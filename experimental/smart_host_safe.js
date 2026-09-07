import {
  DEFAULT_SMART_HOST_SETTINGS,
  collectHotAnchorText,
  discoverContainers,
  getByPointer,
  selectArchiveCandidate,
  simulateFutureArchiveCandidate,
  textMentionsKey,
  updateActivity,
} from './smart_host_core.js';

const VERSION = '0.2.0-rc4';
const SETTINGS_KEY = 'vab.smartHost.safe.settings.v5';
const ACTIVITY_KEY = 'vab.smartHost.safe.activity.v5';
const UI_INTERVAL_MS = 4000;
const TRIGGER_DELAY_MS = 1800;
const FUTURE_SIM_MESSAGES = 60;
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERRORS_IN_WINDOW = 3;

let mounted = false;
let uiTimer = null;
let scheduledTimer = null;
let busy = false;
let generationActive = false;
let lastActionAt = 0;
let lastActionMessageCount = -1;
let statusText = '未启用';
let errorTimes = [];
let eventBindings = [];

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

function recentContextText(count = cfg.recentMentionMessages) {
  const chat = ctx()?.chat || [];
  return chat
    .filter(m => m && typeof m.mes === 'string')
    .slice(-Math.max(1, Number(count) || 1))
    .map(m => String(m.mes || ''))
    .join('\n');
}

function protectionText(statData) {
  return [recentContextText(), collectHotAnchorText(statData)].filter(Boolean).join('\n');
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

function legacyAutoEnabled(state) {
  return !!state?.settings?.autoArchiveGlobal;
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
  const text = options.recentText ?? protectionText(stat);
  const msgCount = options.messageCount ?? messageCount();
  const allowRestore = options.allowRestore ?? true;

  const archives = (state.archiveCache || []).filter(r => r && r.status === 'archived');
  if (allowRestore && settings.autoRestore) {
    for (const record of archives) {
      if (!record?.childKey || !record?.pointer || !record?.sourcePath) continue;
      if (!textMentionsKey(text, record.childKey)) continue;
      if (getByPointer(stat, record.pointer) !== undefined) continue;
      const parent = getByPointer(stat, record.sourcePath);
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;
      return { action: 'restore', record, reason: `最近上下文或热状态重新引用了“${record.childKey}”` };
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
        reason: `${container.path} 已有 ${container.count} 项，候选项达到闲置与容量阈值`,
      };
    }
  }

  return { action: 'none', reason: '当前无需迁移' };
}

function buildFutureSimulation(state, futureMessages = FUTURE_SIM_MESSAGES) {
  const stat = state?.latestMvu?.statData;
  const scopeKey = state?.current?.scopeKey;
  if (!stat || !scopeKey) return { action: 'none', reason: '当前没有MVU', items: [] };

  const liveContainers = discoverContainers(stat, cfg);
  if (!liveContainers.length) return { action: 'none', reason: '当前没有可托管的对象容器', items: [] };

  const nowCount = messageCount();
  const text = protectionText(stat);
  const items = [];

  for (const live of liveContainers) {
    const result = simulateFutureArchiveCandidate({
      container: live,
      messageCount: nowCount,
      recentText: text,
      settings: cfg,
      futureMessages,
    });
    if (!result?.candidate) continue;
    items.push({
      container: live,
      candidate: result.candidate,
      simulatedCount: result.simulatedMessageCount,
      virtualCount: result.virtualCount,
      effectiveMin: result.effectiveMin,
    });
  }

  if (!items.length) {
    return {
      action: 'none',
      reason: `只读模拟完成：即使假设未来再闲置 ${futureMessages} 条消息，也没有安全候选`,
      items: [],
    };
  }

  items.sort((a, b) => b.candidate.size - a.candidate.size || b.container.size - a.container.size);
  return {
    action: 'archive',
    reason: `只读模拟：假设现有条目再闲置 ${futureMessages} 条消息，并让各容器增长到触发线`,
    items,
  };
}

function clearScheduledCycle() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}

function scheduleCycle(delay = TRIGGER_DELAY_MS) {
  clearScheduledCycle();
  if (!mounted || !cfg.enabled || generationActive) return;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    runCycle().catch(error => console.warn('[VAB SmartHost Safe] scheduled cycle failed', error));
  }, Math.max(250, Number(delay) || TRIGGER_DELAY_MS));
}

function recordFailure(error) {
  const now = Date.now();
  errorTimes = errorTimes.filter(t => now - t <= ERROR_WINDOW_MS);
  errorTimes.push(now);
  if (errorTimes.length >= MAX_ERRORS_IN_WINDOW) {
    cfg.enabled = false;
    saveCfg();
    clearScheduledCycle();
    statusText = `熔断：10分钟内连续异常 ${errorTimes.length} 次，智能托管已自动关闭。最后异常：${error?.message || error}`;
    return true;
  }
  return false;
}

async function runCycle({ ignoreCooldown = false, ignorePerMessageGuard = false } = {}) {
  if (busy) return;
  if (!cfg.enabled) {
    statusText = '未启用 · 不执行任何迁移';
    updateUi();
    return;
  }
  if (generationActive) {
    statusText = '模型正在生成 · 本轮暂停所有变量迁移';
    updateUi();
    return;
  }
  if (document.hidden) {
    statusText = '页面在后台 · 本轮暂停';
    updateUi();
    return;
  }

  const currentMessageCount = messageCount();
  if (!ignorePerMessageGuard && lastActionMessageCount === currentMessageCount) return;
  if (!ignoreCooldown && Date.now() - lastActionAt < cfg.actionCooldownMs) return;

  const vab = getVab();
  if (!vab?.getState || !vab?.refreshCurrent || !vab?.archiveChild || !vab?.restoreArchive) {
    statusText = '归档桥核心未就绪';
    updateUi();
    return;
  }

  busy = true;
  try {
    const beforeState = getState();
    const beforeScope = beforeState?.current?.scopeKey || '';
    await vab.refreshCurrent({ render: false });
    let state = getState();
    const scopeKey = state?.current?.scopeKey;

    if (!state?.latestMvu?.statData || !scopeKey) {
      statusText = '当前没有MVU';
      return;
    }
    if (beforeScope && beforeScope !== scopeKey) {
      statusText = '检测到聊天刚切换 · 本轮不修改变量';
      return;
    }
    if (legacyAutoEnabled(state)) {
      statusText = '检测到旧版“自动归档总开关”已开启；为避免双引擎同时改变量，智能托管暂停';
      return;
    }
    if (generationActive) {
      statusText = '模型开始生成 · 已在写入前取消本轮迁移';
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
      lastActionMessageCount = messageCount();
      errorTimes = [];
      statusText = `已恢复：${preview.record.childKey}`;
      return;
    }

    if (preview.action === 'archive') {
      statusText = `归档：${preview.candidate.key}`;
      await vab.archiveChild(preview.container.path, preview.candidate.key, { automatic: true });
      lastActionAt = Date.now();
      lastActionMessageCount = messageCount();
      errorTimes = [];
      statusText = `已归档：${preview.candidate.key}`;
    }
  } catch (error) {
    const fused = recordFailure(error);
    if (!fused) statusText = `异常：${error?.message || error} · 已记录，达到3次会自动熔断`;
    console.warn('[VAB SmartHost Safe]', error);
  } finally {
    busy = false;
    updateUi();
  }
}

function bindHostEvent(eventName, handler) {
  const c = ctx();
  const source = c?.eventSource;
  if (!eventName || !source?.on) return;
  source.on(eventName, handler);
  eventBindings.push({ source, eventName, handler });
}

function hookHostEvents() {
  if (eventBindings.length) return;
  const c = ctx();
  const events = c?.event_types || {};

  const onGenerationStarted = () => {
    generationActive = true;
    clearScheduledCycle();
    if (cfg.enabled) statusText = '模型正在生成 · 自动托管暂停';
    updateUi();
  };
  const onGenerationFinished = () => {
    generationActive = false;
    if (cfg.enabled) {
      statusText = '生成结束 · 等待安全检查';
      scheduleCycle(TRIGGER_DELAY_MS);
    }
    updateUi();
  };
  const onStableMessage = () => {
    if (cfg.enabled && !generationActive) scheduleCycle(TRIGGER_DELAY_MS);
  };
  const onChatChanged = () => {
    clearScheduledCycle();
    lastActionMessageCount = -1;
    if (cfg.enabled) statusText = '聊天已切换 · 等待下一次生成完成后再检查';
    updateUi();
  };

  bindHostEvent(events.GENERATION_STARTED, onGenerationStarted);
  bindHostEvent(events.GENERATION_STOPPED, onGenerationFinished);
  bindHostEvent(events.GENERATION_ENDED, onGenerationFinished);
  bindHostEvent(events.CHARACTER_MESSAGE_RENDERED, onStableMessage);
  bindHostEvent(events.MESSAGE_RECEIVED, onStableMessage);
  bindHostEvent(events.MESSAGE_UPDATED, onStableMessage);
  bindHostEvent(events.CHAT_CHANGED, onChatChanged);
}

function unhookHostEvents() {
  for (const { source, eventName, handler } of eventBindings) {
    try { source?.removeListener?.(eventName, handler); } catch {}
  }
  eventBindings = [];
  generationActive = false;
}

function setEnabled(value) {
  if (value && legacyAutoEnabled(getState())) {
    cfg.enabled = false;
    statusText = '无法开启：旧版“自动归档总开关”仍开启，请只保留一个自动引擎';
    saveCfg();
    clearScheduledCycle();
    updateUi();
    return;
  }
  cfg.enabled = !!value;
  saveCfg();
  clearScheduledCycle();
  statusText = cfg.enabled
    ? '已开启 · 事件驱动模式；只在生成结束/稳定消息后检查，不做15秒轮询'
    : '未启用';
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
    <div class="vab-note">RC4：没有 MutationObserver；不再每15秒扫描归档。自动模式改为事件驱动，只在模型生成结束或稳定消息事件后延迟检查。每次手动载入仍强制从“关闭”开始。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-enabled> 智能托管</label>
    <label class="checkbox_label"><input type="checkbox" data-vab-safe-restore> 提到冷档案时自动恢复</label>
    <div class="vab-actions">
      <button class="menu_button" data-vab-safe-preview>只读检查</button>
      <button class="menu_button" data-vab-safe-simulate>模拟未来闲置60条</button>
      <button class="menu_button" data-vab-safe-run>执行一次（需先开启）</button>
    </div>
    <div class="vab-note">额外保险：生成期间绝不迁移；同一聊天楼数最多自动改1项；30秒动作冷却；10分钟内3次异常自动熔断关闭；最近8条双方消息与当前任务/队伍/正在使用对象会被保护。</div>
    <div class="vab-note" data-vab-safe-status></div>
    <details>
      <summary>高级阈值</summary>
      <label>至少聊天楼数 <input class="vab-num" type="number" min="20" data-vab-safe-minmsg></label>
      <label>小对象基础上限 <input class="vab-num" type="number" min="10" data-vab-safe-minchildren></label>
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
      if (preview.action === 'archive') statusText = `只读候选：归档 ${preview.candidate.key} · ${preview.reason} · 动态热区阈值${preview.candidate.effectiveMin ?? '—'}`;
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
        const top = simulation.items.slice(0, 3).map(item =>
          `${item.container.path}/${item.candidate.key}（热区阈值${item.effectiveMin}，候选${Math.max(1, Math.round(item.candidate.size / 1024))}KB）`
        ).join('；');
        statusText = `模拟候选：${top} · ${simulation.reason} · 未修改真实数据`;
      } else {
        statusText = `模拟结果：${simulation.reason} · 未修改真实数据`;
      }
    } catch (error) {
      statusText = `模拟异常：${error?.message || error}`;
    }
    updateUi();
  });
  box.querySelector('[data-vab-safe-run]')?.addEventListener('click', () => runCycle({ ignoreCooldown: true, ignorePerMessageGuard: true }));

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
  if (runButton) runButton.disabled = !cfg.enabled || busy || generationActive;
}

export function mountSmartHostSafe() {
  if (mounted) return;
  mounted = true;
  cfg.enabled = false;
  saveCfg();
  statusText = '未启用 · 候选模块已安全载入（事件驱动RC4）';
  hookHostEvents();
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
}

export function unmountSmartHostSafe() {
  cfg.enabled = false;
  saveCfg();
  clearScheduledCycle();
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  unhookHostEvents();
  document.querySelector('#vab-smart-host-safe')?.remove();
  mounted = false;
}

export const SmartHostSafeDiagnostics = {
  VERSION,
  getSettings: () => clone(cfg),
  getStatus: () => statusText,
  getRuntime: () => ({
    mounted,
    busy,
    generationActive,
    eventBindings: eventBindings.length,
    scheduled: !!scheduledTimer,
    lastActionMessageCount,
    recentErrors: errorTimes.length,
  }),
  preview: () => buildPreview(getState()),
  simulateFuture: (futureMessages = FUTURE_SIM_MESSAGES) => buildFutureSimulation(getState(), futureMessages),
  runOnce: () => runCycle({ ignoreCooldown: true, ignorePerMessageGuard: true }),
};
