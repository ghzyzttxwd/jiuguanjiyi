import {
  DEFAULT_SMART_HOST_SETTINGS,
  discoverContainers,
  getByPointer,
  selectArchiveCandidate,
  textMentionsKey,
  updateActivity,
} from './smart_host_core.js';

const VERSION = '0.2.0-rc2';
const SETTINGS_KEY = 'vab.smartHost.safe.settings.v3';
const ACTIVITY_KEY = 'vab.smartHost.safe.activity.v3';
const UI_INTERVAL_MS = 2500;
const CYCLE_INTERVAL_MS = 15000;
const FUTURE_SIM_MESSAGES = 60;

let mounted = false;
let cycleTimer = null;
let uiTimer = null;
let busy = false;
let lastActionAt = 0;
let statusText = '未启用';

const defaults = {
  enabled: false,
  autoRestore: true,
  ...DEFAULT_SMART_HOST_SETTINGS,
  actionCooldownMs: 30000,
};

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

let cfg = { ...defaults, ...loadJson(SETTINGS_KEY, defaults), enabled: false };
let activity = loadJson(ACTIVITY_KEY, {});

function saveCfg() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch {}
}

function saveActivity() {
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity)); } catch {}
}

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function recentUserText(count = cfg.recentMentionMessages) {
  const chat = ctx()?.chat || [];
  return chat
    .filter(m => m && m.is_user)
    .slice(-Math.max(1, Number(count) || 1))
    .map(m => String(m.mes || ''))
    .join('\n');
}

function messageCount() {
  return ctx()?.chat?.length ?? 0;
}

function scopeBucket(scopeKey) {
  return activity[scopeKey] ||= {};
}

function getVab() {
  return window.VariableArchiveBridge || null;
}

function getState() {
  return getVab()?.getState?.() || null;
}

function refreshActivity(state) {
  const stat = state?.latestMvu?.statData;
  const scopeKey = state?.current?.scopeKey;
  if (!stat || !scopeKey) return [];

  const containers = discoverContainers(stat, cfg);
  activity[scopeKey] = updateActivity({
    containers,
    prior: scopeBucket(scopeKey),
    messageCount: messageCount(),
  });
  saveActivity();
  return containers;
}

function buildPreview(state, options = {}) {
  const stat = state?.latestMvu?.statData;
  const scopeKey = state?.current?.scopeKey;
  if (!stat || !scopeKey) return { action: 'none', reason: '当前没有MVU' };

  const settings = options.settings || cfg;
  const containers = options.containers || discoverContainers(stat, settings);
  const root = options.activityRoot || scopeBucket(scopeKey);
  const text = options.recentText ?? recentUserText(settings.recentMentionMessages);
  const msgCount = options.messageCount ?? messageCount();
  const allowRestore = options.allowRestore ?? true;

  const archives = (state.archiveCache || []).filter(r => r && r.status === 'archived');
  if (allowRestore && settings.autoRestore) {
    for (const record of archives) {
      if (!record?.childKey || !record?.pointer) continue;
      if (!textMentionsKey(text, record.childKey)) continue;
      if (getByPointer(stat, record.pointer) !== undefined) continue;
      return { action: 'restore', record, reason: `最近消息提到了“${record.childKey}”` };
    }
  }

  for (const container of containers) {
    const candidate = selectArchiveCandidate({
      container,
      activity: root[container.path] || {},
      messageCount: msgCount,
      recentText: text,
      settings,
    });
    if (candidate) {
      return {
        action: 'archive',
        container,
        candidate,
        reason: `${container.path} 已有 ${container.count} 项，候选项闲置超过 ${settings.minIdleMessages} 条消息`,
      };
    }
  }

  return { action: 'none', reason: '当前无需迁移' };
}

function buildFutureSimulation(state, futureMessages = FUTURE_SIM_MESSAGES) {
  const stat = state?.latestMvu?.statData;
  const scopeKey = state?.current?.scopeKey;
  if (!stat || !scopeKey) return { action: 'none', reason: '当前没有MVU' };

  const liveContainers = discoverContainers(stat, cfg);
  if (!liveContainers.length) return { action: 'none', reason: '当前没有可托管的对象容器' };

  const nowCount = messageCount();
  const simulatedCount = Math.max(cfg.minMessagesBeforeArchive + 1, nowCount + Math.max(1, futureMessages));
  const text = recentUserText(cfg.recentMentionMessages);

  for (const live of liveContainers) {
    const virtualEntries = live.entries.map(([key, value]) => [key, clone(value)]);
    const realKeys = new Set(virtualEntries.map(([key]) => key));
    const neededCount = Math.max(cfg.minChildren + 1, cfg.targetChildren + 1, virtualEntries.length);

    for (let i = virtualEntries.length; i < neededCount; i++) {
      virtualEntries.push([
        `__模拟新增_${i + 1}`,
        { 模拟占位: true, 说明: '仅用于只读压力模拟，不存在于真实MVU' },
      ]);
    }

    const virtual = {
      ...live,
      entries: virtualEntries,
      count: virtualEntries.length,
      size: Math.max(live.size, cfg.minContainerBytes + 1),
    };

    const activityRoot = { [live.path]: {} };
    for (const [key] of virtualEntries) {
      activityRoot[live.path][key] = {
        hash: 'simulation',
        lastTouched: realKeys.has(key) ? nowCount : simulatedCount,
      };
    }

    const candidate = selectArchiveCandidate({
      container: virtual,
      activity: activityRoot[live.path],
      messageCount: simulatedCount,
      recentText: text,
      settings: cfg,
    });

    if (candidate && realKeys.has(candidate.key)) {
      return {
        action: 'archive',
        container: live,
        candidate,
        simulatedCount,
        virtualCount: virtual.count,
        reason: `只读模拟：假设 ${live.path} 增长到 ${virtual.count} 项，且现有条目再闲置 ${futureMessages} 条消息`,
      };
    }
  }

  return {
    action: 'none',
    reason: `只读模拟完成：即使假设未来再闲置 ${futureMessages} 条消息，也没有安全候选`,
  };
}

async function runCycle({ ignoreCooldown = false } = {}) {
  if (busy) return;
  if (!cfg.enabled) {
    statusText = '未启用 · 不执行任何迁移';
    updateUi();
    return;
  }
  if (!ignoreCooldown && Date.now() - lastActionAt < cfg.actionCooldownMs) return;

  const vab = getVab();
  if (!vab?.getState || !vab?.refreshCurrent) {
    statusText = '归档桥核心未就绪';
    updateUi();
    return;
  }

  busy = true;
  try {
    await vab.refreshCurrent({ render: false });
    let state = getState();
    if (!state?.latestMvu?.statData || !state?.current?.scopeKey) {
      statusText = '当前没有MVU';
      return;
    }

    refreshActivity(state);
    state = getState();
    const preview = buildPreview(state);

    if (preview.action === 'none') {
      statusText = '正常 · 本轮无需迁移';
      return;
    }

    if (preview.action === 'restore') {
      statusText = `恢复：${preview.record.childKey}`;
      await vab.restoreArchive(preview.record.id);
      lastActionAt = Date.now();
      statusText = `已恢复：${preview.record.childKey}`;
      return;
    }

    if (preview.action === 'archive') {
      statusText = `归档：${preview.candidate.key}`;
      await vab.archiveChild(preview.container.path, preview.candidate.key, { automatic: true });
      lastActionAt = Date.now();
      statusText = `已归档：${preview.candidate.key}`;
    }
  } catch (error) {
    statusText = `异常：${error?.message || error}`;
    console.warn('[VAB SmartHost Safe]', error);
  } finally {
    busy = false;
    updateUi();
  }
}

function startCycleTimer() {
  stopCycleTimer();
  if (!cfg.enabled) return;
  cycleTimer = setInterval(() => runCycle(), CYCLE_INTERVAL_MS);
}

function stopCycleTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = null;
}

function setEnabled(value) {
  cfg.enabled = !!value;
  saveCfg();
  statusText = cfg.enabled ? '已开启，等待安全阈值' : '未启用';
  startCycleTimer();
  updateUi();
}

function ensureUi() {
  const root = document.querySelector('#vab-settings #vab-root');
  if (!root) return;
  if (root.querySelector('#vab-smart-host-safe')) {
    updateUi();
    return;
  }

  const box = document.createElement('details');
  box.id = 'vab-smart-host-safe';
  box.className = 'vab-section';
  box.open = true;
  box.innerHTML = `
    <summary>🧠 智能托管候选版 ${VERSION}</summary>
    <div class="vab-note">安全版：没有 MutationObserver；每次手动载入都强制从“关闭”开始。不开总开关时，执行按钮也不能迁移数据。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-enabled> 智能托管</label>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-restore> 提到冷档案时自动恢复</label>
    <div class="vab-actions">
      <button class="menu_button" data-vab-safe-preview>只读检查</button>
      <button class="menu_button" data-vab-safe-simulate>模拟未来闲置60条</button>
      <button class="menu_button" data-vab-safe-run>执行一次（需先开启）</button>
    </div>
    <div class="vab-note">“模拟未来闲置60条”只在内存副本中假设容器已经膨胀，不写MVU、不写冷档案、不写活动记录。</div>
    <div class="vab-note" data-vab-safe-status></div>
    <details>
      <summary>高级阈值</summary>
      <label>至少聊天楼数 <input class="vab-num" type="number" min="20" data-vab-safe-minmsg></label>
      <label>至少子项数 <input class="vab-num" type="number" min="10" data-vab-safe-minchildren></label>
      <label>至少闲置消息 <input class="vab-num" type="number" min="10" data-vab-safe-idle></label>
      <label>最小容器KB <input class="vab-num" type="number" min="1" data-vab-safe-kb></label>
    </details>`;

  const anchor = root.querySelector('#vab-smart-scan');
  if (anchor) anchor.insertAdjacentElement('beforebegin', box);
  else root.prepend(box);

  box.querySelector('[data-vab-safe-enabled]')?.addEventListener('change', e => setEnabled(e.target.checked));
  box.querySelector('[data-vab-safe-restore]')?.addEventListener('change', e => {
    cfg.autoRestore = !!e.target.checked;
    saveCfg();
    updateUi();
  });
  box.querySelector('[data-vab-safe-preview]')?.addEventListener('click', async () => {
    try {
      await getVab()?.refreshCurrent?.({ render: false });
      const state = getState();
      refreshActivity(state);
      const preview = buildPreview(state);
      if (preview.action === 'archive') statusText = `只读候选：归档 ${preview.candidate.key} · ${preview.reason}`;
      else if (preview.action === 'restore') statusText = `只读候选：恢复 ${preview.record.childKey} · ${preview.reason}`;
      else statusText = `只读结果：${preview.reason}`;
    } catch (error) {
      statusText = `只读检查异常：${error?.message || error}`;
    }
    updateUi();
  });
  box.querySelector('[data-vab-safe-simulate]')?.addEventListener('click', async () => {
    try {
      await getVab()?.refreshCurrent?.({ render: false });
      const simulation = buildFutureSimulation(getState(), FUTURE_SIM_MESSAGES);
      if (simulation.action === 'archive') {
        statusText = `模拟候选：${simulation.container.path}/${simulation.candidate.key} · ${simulation.reason} · 未修改真实数据`;
      } else {
        statusText = `模拟结果：${simulation.reason} · 未修改真实数据`;
      }
    } catch (error) {
      statusText = `模拟异常：${error?.message || error}`;
    }
    updateUi();
  });
  box.querySelector('[data-vab-safe-run]')?.addEventListener('click', () => runCycle({ ignoreCooldown: true }));

  const bindNum = (selector, key, transform) => {
    box.querySelector(selector)?.addEventListener('change', e => {
      cfg[key] = transform(Number(e.target.value));
      saveCfg();
      updateUi();
    });
  };
  bindNum('[data-vab-safe-minmsg]', 'minMessagesBeforeArchive', v => Math.max(20, v || 60));
  bindNum('[data-vab-safe-minchildren]', 'minChildren', v => Math.max(10, v || 30));
  bindNum('[data-vab-safe-idle]', 'minIdleMessages', v => Math.max(10, v || 40));
  bindNum('[data-vab-safe-kb]', 'minContainerBytes', v => Math.max(1, v || 12) * 1024);

  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-settings #vab-smart-host-safe');
  if (!box) return;

  const setChecked = (sel, val) => {
    const el = box.querySelector(sel);
    if (el && el.checked !== !!val) el.checked = !!val;
  };
  const setValue = (sel, val) => {
    const el = box.querySelector(sel);
    const next = String(val);
    if (el && el.value !== next) el.value = next;
  };
  const setText = (sel, val) => {
    const el = box.querySelector(sel);
    const next = String(val);
    if (el && el.textContent !== next) el.textContent = next;
  };

  setChecked('[data-vab-safe-enabled]', cfg.enabled);
  setChecked('[data-vab-safe-restore]', cfg.autoRestore);
  setValue('[data-vab-safe-minmsg]', cfg.minMessagesBeforeArchive);
  setValue('[data-vab-safe-minchildren]', cfg.minChildren);
  setValue('[data-vab-safe-idle]', cfg.minIdleMessages);
  setValue('[data-vab-safe-kb]', Math.max(1, Math.round(cfg.minContainerBytes / 1024)));
  setText('[data-vab-safe-status]', `${cfg.enabled ? '●' : '○'} ${statusText}`);

  const runButton = box.querySelector('[data-vab-safe-run]');
  if (runButton) runButton.disabled = !cfg.enabled || busy;
}

export function mountSmartHostSafe() {
  if (mounted) return;
  mounted = true;
  cfg.enabled = false;
  saveCfg();
  statusText = '未启用 · 候选模块已安全载入';
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
  startCycleTimer();
}

export function unmountSmartHostSafe() {
  setEnabled(false);
  stopCycleTimer();
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  document.querySelector('#vab-smart-host-safe')?.remove();
  mounted = false;
}

export const SmartHostSafeDiagnostics = {
  VERSION,
  getSettings: () => clone(cfg),
  getStatus: () => statusText,
  preview: () => buildPreview(getState()),
  simulateFuture: (futureMessages = FUTURE_SIM_MESSAGES) => buildFutureSimulation(getState(), futureMessages),
  runOnce: () => runCycle({ ignoreCooldown: true }),
};
