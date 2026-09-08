import {
  assessMasterHealth,
  assessMasterPreflight,
  disableMasterStack,
  enableMasterStack,
} from './memory_master_core.js';
import { RecallSafeDiagnostics, setRecallEnabledSession } from './recall_safe.js';
import { AutoLifecycleSafeDiagnostics, setLifecycleEnabledSession } from './auto_lifecycle_safe.js';
import { SmartHostSafeDiagnostics } from './smart_host_safe.js';
import { RehydrationLiveSafeDiagnostics } from './rehydration_live_safe.js';
import { summarizeLifecycleDecision } from './auto_lifecycle_core.js';

const VERSION = '0.2.0-rc2';
const UI_INTERVAL_MS = 4000;
const HEALTH_WATCHDOG_MS = 15000;
const HEALTH_DEBOUNCE_MS = 650;

let mounted = false;
let masterEnabled = false; // session-only: never persisted
let busy = false;
let uiTimer = null;
let healthTimer = null;
let healthDebounceTimer = null;
let eventBindings = [];
let statusText = '未启用 · 召回/归档/重激活不会由主控自动运行';
let lastPreflight = null;
let lastHealth = null;
let lastHealthAt = 0;
let healthCheckCount = 0;
let failClosedCount = 0;

const LOCK_SELECTORS = [
  '[data-vab-recall-enabled]',
  '[data-vab-lifecycle-enable]',
  '[data-vab-safe-enabled]',
  '[data-vab-rehydrate-arm]',
  '#vab-auto-archive-global',
];

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function getVab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function state() {
  return getVab()?.getState?.() || null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setLocks(locked) {
  for (const selector of LOCK_SELECTORS) {
    document.querySelectorAll(selector).forEach(el => {
      if (locked) {
        if (el.dataset.vabMasterLocked === '1') return;
        el.dataset.vabMasterLocked = '1';
        el.dataset.vabMasterPrevDisabled = el.disabled ? '1' : '0';
        el.disabled = true;
        el.title = '当前由“统一自动记忆主控”托管；先关闭主控才能单独修改此开关。';
      } else if (el.dataset.vabMasterLocked === '1') {
        el.disabled = el.dataset.vabMasterPrevDisabled === '1';
        delete el.dataset.vabMasterLocked;
        delete el.dataset.vabMasterPrevDisabled;
        if (el.title?.includes('统一自动记忆主控')) el.removeAttribute('title');
      }
    });
  }
}

async function enableRecall() {
  await setRecallEnabledSession(true);
  return RecallSafeDiagnostics.isEnabled();
}

async function disableRecall() {
  await setRecallEnabledSession(false);
  return !RecallSafeDiagnostics.isEnabled();
}

async function enableLifecycle() {
  // Master owns the one user confirmation. Child confirmation is deliberately skipped here.
  await setLifecycleEnabledSession(true, { skipConfirm: true });
  return AutoLifecycleSafeDiagnostics.isEnabled();
}

async function disableLifecycle() {
  await setLifecycleEnabledSession(false, { skipConfirm: true });
  return !AutoLifecycleSafeDiagnostics.isEnabled();
}

function currentPreflight() {
  const s = state();
  let recall = null;
  try { recall = RecallSafeDiagnostics.preview(); } catch {}
  return assessMasterPreflight({
    hasMvu: !!s?.latestMvu?.statData,
    legacyAutoEnabled: !!s?.settings?.autoArchiveGlobal,
    smartHostEnabled: !!SmartHostSafeDiagnostics?.getSettings?.()?.enabled,
    manualRehydrationArmed: !!RehydrationLiveSafeDiagnostics?.isArmed?.(),
    recallMode: recall?.decision?.mode || 'auto-prompt',
  });
}

async function previewAll() {
  const preflight = currentPreflight();
  lastPreflight = preflight;
  let recall = null;
  let lifecycle = null;
  try { recall = RecallSafeDiagnostics.preview(); } catch (error) {
    statusText = `预检失败：召回层异常：${error?.message || error}`;
    updateUi();
    return;
  }
  try { lifecycle = await AutoLifecycleSafeDiagnostics.preview(); } catch (error) {
    statusText = `预检失败：生命周期层异常：${error?.message || error}`;
    updateUi();
    return;
  }

  const recallMode = recall?.decision?.mode || 'unknown';
  const recallCount = recall?.ranked?.length || 0;
  const lifecycleText = lifecycle ? summarizeLifecycleDecision(lifecycle) : '无生命周期决策';
  statusText = `${preflight.ok ? '✅' : '⛔'} ${preflight.reason} · 召回:${recallMode}/${recallCount}条 · 生命周期:${lifecycleText} · 只读未修改数据`;
  updateUi();
}

async function enableMaster() {
  if (busy || masterEnabled) return;
  busy = true;
  try {
    const preflight = currentPreflight();
    lastPreflight = preflight;
    if (!preflight.ok) {
      statusText = `无法开启：${preflight.reason}`;
      return;
    }

    const ok = confirm([
      '开启“统一自动记忆主控”候选版？',
      '',
      '仅本次页面会话有效，刷新/重启后自动关闭。',
      '开启后由一个主控同时协调：',
      '1. 冷档案按需Prompt召回；',
      '2. 热变量超载后安全归档；',
      '3. 归档节点真正重新进入MVU后事务重激活。',
      '',
      '生成期间不写；聊天切换首轮不写；每次最多改1个MVU节点；异常会熔断并联动关闭。',
      '单纯提到旧人物/武学只召回上下文，不会硬恢复MVU。',
    ].join('\n'));
    if (!ok) {
      statusText = '未开启 · 用户取消本次会话主控';
      return;
    }

    statusText = '正在开启统一主控：先启用Prompt召回，再启用生命周期托管…';
    updateUi();

    const result = await enableMasterStack({
      preflight,
      enableRecall,
      disableRecall,
      enableLifecycle,
      disableLifecycle,
    });

    masterEnabled = !!result.ok;
    if (masterEnabled) {
      setLocks(true);
      statusText = '✅ 统一自动记忆主控已开启 · session-only · Prompt召回 + 热冷归档 + 重激活收口由一个主控协调';
      scheduleHealthCheck(HEALTH_DEBOUNCE_MS);
    } else {
      setLocks(false);
      statusText = `未开启：${result.reason}${result.rolledBack ? ' · 已回滚先前开启的子系统' : ''}`;
    }
  } finally {
    busy = false;
    updateUi();
  }
}

async function disableMaster({ reason = '用户关闭主控' } = {}) {
  if (busy) return;
  busy = true;
  masterEnabled = false;
  setLocks(false);
  clearScheduledHealth();
  try {
    const result = await disableMasterStack({ disableRecall, disableLifecycle });
    statusText = result.ok
      ? `○ 统一自动记忆主控已关闭 · ${reason} · 本插件拥有的召回Prompt已清理`
      : `⚠️ 主控已请求关闭，但子系统关闭异常：${result.errors.join('；')}`;
  } finally {
    busy = false;
    updateUi();
  }
}

async function healthCheck() {
  if (!mounted || !masterEnabled || busy) return;
  healthCheckCount++;
  lastHealthAt = Date.now();
  const health = assessMasterHealth({
    masterEnabled,
    recallEnabled: RecallSafeDiagnostics.isEnabled(),
    lifecycleEnabled: AutoLifecycleSafeDiagnostics.isEnabled(),
  });
  lastHealth = health;

  const preflight = currentPreflight();
  if (!preflight.ok) {
    failClosedCount++;
    await disableMaster({ reason: `运行中安全条件失效：${preflight.reason}` });
    return;
  }
  if (!health.healthy && health.action === 'fail-closed') {
    failClosedCount++;
    await disableMaster({ reason: `故障联动：${health.reason}` });
  }
}

function clearScheduledHealth() {
  if (healthDebounceTimer) clearTimeout(healthDebounceTimer);
  healthDebounceTimer = null;
}

function scheduleHealthCheck(delay = HEALTH_DEBOUNCE_MS) {
  clearScheduledHealth();
  if (!mounted || !masterEnabled) return;
  healthDebounceTimer = setTimeout(() => {
    healthDebounceTimer = null;
    healthCheck().catch(error => console.warn('[VAB Memory Master RC] event health check failed', error));
  }, Math.max(100, Number(delay) || HEALTH_DEBOUNCE_MS));
}

function bindEvent(name, handler) {
  const c = ctx();
  const source = c?.eventSource;
  if (!name || !source?.on) return;
  source.on(name, handler);
  eventBindings.push({ source, name, handler });
}

function hookEvents() {
  if (eventBindings.length) return;
  const e = ctx()?.event_types || ctx()?.eventTypes || {};
  const stable = () => scheduleHealthCheck();
  bindEvent(e.GENERATION_STOPPED, stable);
  bindEvent(e.GENERATION_ENDED, stable);
  bindEvent(e.CHARACTER_MESSAGE_RENDERED, stable);
  bindEvent(e.MESSAGE_RECEIVED, stable);
  bindEvent(e.MESSAGE_UPDATED, stable);
  bindEvent(e.CHAT_CHANGED, stable);
}

function unhookEvents() {
  for (const { source, name, handler } of eventBindings) {
    try { source?.removeListener?.(name, handler); } catch {}
  }
  eventBindings = [];
}

function uiHost() {
  return document.querySelector('#vab-rc-host')
    || document.querySelector('#vab-smart-host-safe')
    || document.querySelector('#vab-settings #vab-root');
}

function ensureUi() {
  const host = uiHost();
  if (!host) return;
  if (host.querySelector('#vab-memory-master-safe')) {
    updateUi();
    return;
  }

  const box = document.createElement('details');
  box.id = 'vab-memory-master-safe';
  box.className = 'vab-section';
  box.open = true;
  box.innerHTML = `
    <summary>🧠📦 统一自动记忆主控 ${VERSION}</summary>
    <div class="vab-note">RC2：日常只保留这一个总开关。主控直接调用子系统API，不再模拟点击内部开关；开启时只弹一次总确认。统一协调：①冷档案按需Prompt召回；②热变量超载自动归档；③归档节点真正重新进入MVU时事务重激活。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-master-enable> 本次页面会话启用统一自动记忆（实验RC）</label>
    <div class="vab-actions"><button class="menu_button" data-vab-master-preview>统一安全预检</button></div>
    <div class="vab-note">保护：主控不持久化；事件触发健康检查 + 15秒低频看门狗；召回层退出、生命周期熔断、旧自动引擎/手动写入重新开启时一律 fail-closed，先停写入再清理本插件Prompt。</div>
    <div class="vab-note" data-vab-master-status>○ ${escapeHtml(statusText)}</div>`;

  host.prepend(box);
  box.querySelector('[data-vab-master-enable]')?.addEventListener('change', async e => {
    if (e.target.checked) await enableMaster();
    else await disableMaster();
  });
  box.querySelector('[data-vab-master-preview]')?.addEventListener('click', () => previewAll());
  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-memory-master-safe');
  if (!box) return;
  const toggle = box.querySelector('[data-vab-master-enable]');
  if (toggle && toggle.checked !== masterEnabled) toggle.checked = masterEnabled;
  if (toggle) toggle.disabled = busy;
  const status = box.querySelector('[data-vab-master-status]');
  if (status) status.textContent = `${masterEnabled ? '●' : '○'} ${statusText}`;
}

export function mountMemoryMasterSafe() {
  if (mounted) return;
  mounted = true;
  masterEnabled = false;
  busy = false;
  statusText = '未启用 · 召回/归档/重激活不会由主控自动运行';
  hookEvents();
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
  healthTimer = setInterval(() => {
    healthCheck().catch(error => console.warn('[VAB Memory Master RC] watchdog health check failed', error));
  }, HEALTH_WATCHDOG_MS);
}

export async function unmountMemoryMasterSafe() {
  if (masterEnabled) await disableMaster({ reason: '候选模块卸载' });
  setLocks(false);
  clearScheduledHealth();
  if (uiTimer) clearInterval(uiTimer);
  if (healthTimer) clearInterval(healthTimer);
  uiTimer = null;
  healthTimer = null;
  unhookEvents();
  document.querySelector('#vab-memory-master-safe')?.remove();
  masterEnabled = false;
  busy = false;
  mounted = false;
}

export const MemoryMasterSafeDiagnostics = {
  VERSION,
  isEnabled: () => masterEnabled,
  getStatus: () => statusText,
  getPreflight: () => lastPreflight,
  getHealth: () => lastHealth,
  getRuntime: () => ({
    mounted,
    masterEnabled,
    busy,
    eventBindings: eventBindings.length,
    healthScheduled: !!healthDebounceTimer,
    lastHealthAt,
    healthCheckCount,
    failClosedCount,
  }),
  preview: previewAll,
  enable: enableMaster,
  disable: disableMaster,
};
