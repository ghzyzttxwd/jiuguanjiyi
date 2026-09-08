// Variable Archive Bridge v0.2.0 production auto-orchestrator.
// Goal: one normal install link, automatic lifecycle management, and crash-safe boot fallback.
// No MutationObserver. Experimental engines are dynamically imported only after the base plugin is stable.

import {
  beginBoot,
  clearBootSafeMode,
  decideAutoStart,
  markBootFailed,
  markBootHealthy,
  markBootStopped,
} from './experimental/boot_guard_core.js';

const VERSION = '0.2.0';
const BOOT_KEY = 'vab.production.boot.v1';
const START_DELAY_MS = 4500;
const HEALTHY_DELAY_MS = 8000;
const HEALTH_WATCHDOG_MS = 15000;
const UI_INTERVAL_MS = 5000;

let started = false;
let loading = false;
let loaded = false;
let active = false;
let blocked = false;
let faulted = false;
let statusText = '等待启动';
let bootRecord = null;
let healthyTimer = null;
let healthTimer = null;
let uiTimer = null;
let retryTimer = null;
let eventBindings = [];
let recallModule = null;
let lifecycleModule = null;
let lastFault = '';

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function vab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function readBoot() {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeBoot(record) {
  bootRecord = record;
  try { localStorage.setItem(BOOT_KEY, JSON.stringify(record)); } catch {}
}

function makeSessionId() {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function eventMap() {
  const c = ctx();
  return c?.event_types || c?.eventTypes || {};
}

function bindEvent(name, handler) {
  const source = ctx()?.eventSource;
  if (!name || !source?.on) return;
  source.on(name, handler);
  eventBindings.push({ source, name, handler });
}

function hookEvents() {
  if (eventBindings.length) return;
  const e = eventMap();
  const retry = () => scheduleActivation(900);
  bindEvent(e.CHAT_CHANGED, retry);
  bindEvent(e.CHARACTER_MESSAGE_RENDERED, retry);
  bindEvent(e.MESSAGE_RECEIVED, retry);
  bindEvent(e.MESSAGE_UPDATED, retry);
  bindEvent(e.GENERATION_STOPPED, retry);
  bindEvent(e.GENERATION_ENDED, retry);
}

function unhookEvents() {
  for (const { source, name, handler } of eventBindings) {
    try { source?.removeListener?.(name, handler); } catch {}
  }
  eventBindings = [];
}

function scheduleActivation(delay = 900) {
  if (!loaded || active || blocked || faulted) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    tryActivate().catch(error => enterFault(error));
  }, Math.max(300, Number(delay) || 900));
}

async function refreshState() {
  const core = vab();
  if (!core?.refreshCurrent || !core?.getState) return null;
  try { await core.refreshCurrent({ render: false }); } catch {}
  return core.getState?.() || null;
}

async function disableChildren() {
  active = false;
  try { await lifecycleModule?.setLifecycleEnabledSession?.(false, { skipConfirm: true }); } catch {}
  try { await recallModule?.setRecallEnabledSession?.(false); } catch {}
}

async function enterFault(error) {
  if (faulted) return;
  faulted = true;
  lastFault = String(error?.message || error || 'unknown runtime failure');
  statusText = `安全停机：${lastFault}`;
  await disableChildren();
  try { writeBoot(markBootFailed(bootRecord || readBoot(), lastFault)); } catch {}
  ensureUi();
}

async function tryActivate() {
  if (!loaded || active || blocked || faulted || loading) return false;
  const state = await refreshState();
  if (!state?.latestMvu?.statData) {
    statusText = '已加载 · 等待进入MVU变量卡聊天';
    ensureUi();
    return false;
  }

  if (state?.settings?.autoArchiveGlobal) {
    await enterFault('检测到旧版自动归档仍开启，为避免双写已停用v0.2自动主控');
    return false;
  }

  statusText = '正在自动启用：先召回层，再生命周期层…';
  ensureUi();

  const recallOk = await recallModule.setRecallEnabledSession(true);
  if (!recallOk || !recallModule.RecallSafeDiagnostics?.isEnabled?.()) {
    await enterFault(recallModule.RecallSafeDiagnostics?.getStatus?.() || 'Prompt召回层未能启用');
    return false;
  }

  const lifecycleOk = await lifecycleModule.setLifecycleEnabledSession(true, { skipConfirm: true });
  if (!lifecycleOk || !lifecycleModule.AutoLifecycleSafeDiagnostics?.isEnabled?.()) {
    try { await recallModule.setRecallEnabledSession(false); } catch {}
    await enterFault(lifecycleModule.AutoLifecycleSafeDiagnostics?.getStatus?.() || '生命周期层未能启用');
    return false;
  }

  active = true;
  statusText = '✅ 自动记忆运行中 · 冷档案召回 + 热冷归档 + 重激活收口';
  ensureUi();
  return true;
}

async function healthCheck() {
  if (!loaded || blocked || faulted) return;
  if (!active) {
    scheduleActivation(300);
    return;
  }

  const recallEnabled = !!recallModule?.RecallSafeDiagnostics?.isEnabled?.();
  const lifecycleEnabled = !!lifecycleModule?.AutoLifecycleSafeDiagnostics?.isEnabled?.();
  const state = await refreshState();

  if (state?.settings?.autoArchiveGlobal) {
    await enterFault('运行中检测到旧版自动归档被开启，已fail-closed');
    return;
  }
  if (!recallEnabled || !lifecycleEnabled) {
    const r = recallModule?.RecallSafeDiagnostics?.getStatus?.() || '';
    const l = lifecycleModule?.AutoLifecycleSafeDiagnostics?.getStatus?.() || '';
    await enterFault(`子系统退出：${r || l || 'unknown'}`);
  }
}

function host() {
  return document.querySelector('#vab-settings #vab-root');
}

function ensureUi() {
  const root = host();
  if (!root) return;
  let box = root.querySelector('#vab-production-auto');
  if (!box) {
    box = document.createElement('details');
    box.id = 'vab-production-auto';
    box.className = 'vab-section';
    box.open = true;
    box.innerHTML = `
      <summary>🧠📦 自动记忆 ${VERSION}</summary>
      <div class="vab-note" data-vab-prod-status></div>
      <div class="vab-note">默认自动运行：MVU只保留热状态，旧人物/武学/世界资料进入冷档案；相关内容会按需召回，节点真正重新活跃时做保守收口。生成期间不写、每次最多处理1项、异常自动熔断。</div>
      <div class="vab-actions"><button class="menu_button" data-vab-prod-retry style="display:none">解除安全模式并重试</button></div>`;
    root.prepend(box);
    box.querySelector('[data-vab-prod-retry]')?.addEventListener('click', async () => {
      try {
        const cleared = clearBootSafeMode(readBoot());
        writeBoot(cleared);
      } catch {}
      blocked = false;
      faulted = false;
      lastFault = '';
      statusText = '正在重试自动主控…';
      ensureUi();
      if (!loaded) await loadRuntime();
      else scheduleActivation(200);
    });
  }

  const status = box.querySelector('[data-vab-prod-status]');
  if (status) status.textContent = `${active ? '●' : '○'} ${statusText}`;
  const retry = box.querySelector('[data-vab-prod-retry]');
  if (retry) retry.style.display = (blocked || faulted) ? '' : 'none';

  // The production UI is intentionally simple; hide the two low-level RC panels if they were mounted.
  const recallBox = document.querySelector('#vab-recall-safe');
  const lifecycleBox = document.querySelector('#vab-auto-lifecycle-safe');
  if (recallBox) recallBox.style.display = 'none';
  if (lifecycleBox) lifecycleBox.style.display = 'none';
}

function markHealthyLater() {
  if (healthyTimer) clearTimeout(healthyTimer);
  healthyTimer = setTimeout(() => {
    try {
      if (bootRecord?.phase === 'starting' && !blocked && !faulted) {
        writeBoot(markBootHealthy(bootRecord));
      }
    } catch {}
  }, HEALTHY_DELAY_MS);
}

async function loadRuntime() {
  if (loading || loaded || blocked) return;
  loading = true;
  statusText = '正在加载自动记忆引擎…';
  ensureUi();
  try {
    const [recall, lifecycle] = await Promise.all([
      import('./experimental/recall_safe.js'),
      import('./experimental/auto_lifecycle_safe.js'),
    ]);
    if (typeof recall.mountRecallSafe !== 'function' || typeof recall.setRecallEnabledSession !== 'function') {
      throw new Error('召回模块接口不完整');
    }
    if (typeof lifecycle.mountAutoLifecycleSafe !== 'function' || typeof lifecycle.setLifecycleEnabledSession !== 'function') {
      throw new Error('生命周期模块接口不完整');
    }

    recallModule = recall;
    lifecycleModule = lifecycle;
    recall.mountRecallSafe();
    lifecycle.mountAutoLifecycleSafe();
    loaded = true;
    statusText = '引擎已加载 · 正在等待可管理的MVU';
    hookEvents();
    ensureUi();
    scheduleActivation(300);
    markHealthyLater();
  } catch (error) {
    try { lifecycleModule?.unmountAutoLifecycleSafe?.(); } catch {}
    try { await recallModule?.unmountRecallSafe?.(); } catch {}
    recallModule = null;
    lifecycleModule = null;
    loaded = false;
    blocked = true;
    lastFault = String(error?.message || error);
    statusText = `启动失败，已进入安全模式：${lastFault}`;
    writeBoot(markBootFailed(bootRecord || readBoot(), error));
    ensureUi();
  } finally {
    loading = false;
  }
}

async function start() {
  if (started) return;
  started = true;
  const previous = readBoot();
  const decision = decideAutoStart({ desiredEnabled: true, previousRecord: previous });
  if (!decision.allow) {
    blocked = true;
    statusText = `安全模式：${decision.reason}`;
    ensureUi();
    return;
  }

  bootRecord = beginBoot(previous, makeSessionId());
  writeBoot(bootRecord);
  ensureUi();
  await loadRuntime();

  if (!healthTimer) {
    healthTimer = setInterval(() => {
      healthCheck().catch(error => enterFault(error));
    }, HEALTH_WATCHDOG_MS);
  }
}

window.addEventListener('beforeunload', () => {
  try {
    if (retryTimer) clearTimeout(retryTimer);
    if (healthyTimer) clearTimeout(healthyTimer);
    unhookEvents();
    const current = readBoot();
    if (current && !current.safeMode) writeBoot(markBootStopped(current));
  } catch {}
}, { once: true });

uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
setTimeout(() => start().catch(error => enterFault(error)), START_DELAY_MS);
ensureUi();

window.VariableArchiveBridgeAuto = {
  VERSION,
  getStatus: () => ({
    started,
    loading,
    loaded,
    active,
    blocked,
    faulted,
    statusText,
    lastFault,
    boot: readBoot(),
  }),
  retry: async () => {
    const cleared = clearBootSafeMode(readBoot());
    writeBoot(cleared);
    blocked = false;
    faulted = false;
    lastFault = '';
    if (!loaded) await loadRuntime();
    else scheduleActivation(100);
  },
};
