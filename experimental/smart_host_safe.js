import {
  DEFAULT_SMART_HOST_SETTINGS,
  discoverContainers,
  getByPointer,
  selectArchiveCandidate,
  textMentionsKey,
  updateActivity,
} from './smart_host_core.js';

const VERSION = '0.2.0-rc1';
const SETTINGS_KEY = 'vab.smartHost.safe.settings.v2';
const ACTIVITY_KEY = 'vab.smartHost.safe.activity.v2';
const UI_INTERVAL_MS = 2500;
const CYCLE_INTERVAL_MS = 15000;

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

let cfg = { ...defaults, ...loadJson(SETTINGS_KEY, defaults) };
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

function buildPreview(state) {
  const stat = state?.latestMvu?.statData;
  const scopeKey = state?.current?.scopeKey;
  if (!stat || !scopeKey) return { action: 'none', reason: '当前没有MVU' };

  const containers = discoverContainers(stat, cfg);
  const root = scopeBucket(scopeKey);
  const text = recentUserText();
  const msgCount = messageCount();

  const archives = (state.archiveCache || []).filter(r => r && r.status === 'archived');
  if (cfg.autoRestore) {
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
      settings: cfg,
    });
    if (candidate) {
      return {
        action: 'archive',
        container,
        candidate,
        reason: `${container.path} 已有 ${container.count} 项，候选项闲置超过 ${cfg.minIdleMessages} 条消息`,
      };
    }
  }

  return { action: 'none', reason: '当前无需迁移' };
}

async function runCycle({ force = false } = {}) {
  if (busy) return;
  if (!cfg.enabled && !force) return;
  if (!force && Date.now() - lastActionAt < cfg.actionCooldownMs) return;

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
    <div class="vab-note">安全版：没有 MutationObserver；关闭时没有后台归档循环。开启后也只在满足“数量/体积/闲置消息”三重阈值时，每次迁移1项，并继续调用归档桥已验证的快照→迁移→验证链。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-enabled> 智能托管</label>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-restore> 提到冷档案时自动恢复</label>
    <div class="vab-actions">
      <button class="menu_button" data-vab-safe-preview>只读检查</button>
      <button class="menu_button" data-vab-safe-run>执行一次</button>
    </div>
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
  box.querySelector('[data-vab-safe-run]')?.addEventListener('click', () => runCycle({ force: true }));

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
}

export function mountSmartHostSafe() {
  if (mounted) return;
  mounted = true;
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
  startCycleTimer();
}

export function unmountSmartHostSafe() {
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
  runOnce: () => runCycle({ force: true }),
};
