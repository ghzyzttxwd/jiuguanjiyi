import {
  assessMasterHealth,
  assessMasterPreflight,
  disableMasterStack,
  enableMasterStack,
} from './memory_master_core.js';
import { RecallSafeDiagnostics } from './recall_safe.js';
import { AutoLifecycleSafeDiagnostics } from './auto_lifecycle_safe.js';
import { SmartHostSafeDiagnostics } from './smart_host_safe.js';
import { RehydrationLiveSafeDiagnostics } from './rehydration_live_safe.js';
import { summarizeLifecycleDecision } from './auto_lifecycle_core.js';

const VERSION = '0.2.0-rc1';
const UI_INTERVAL_MS = 4000;
const COMPONENT_WAIT_MS = 5000;

let mounted = false;
let masterEnabled = false; // session-only: never persisted
let busy = false;
let uiTimer = null;
let healthTimer = null;
let statusText = '未启用 · 召回/归档/重激活不会由主控自动运行';
let lastPreflight = null;
let lastHealth = null;

const LOCK_SELECTORS = [
  '[data-vab-recall-enabled]',
  '[data-vab-lifecycle-enable]',
  '[data-vab-safe-enabled]',
  '[data-vab-rehydrate-arm]',
  '#vab-auto-archive-global',
];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function waitFor(check, expected, timeoutMs = COMPONENT_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!!check() === !!expected) return true;
    await sleep(50);
  }
  return !!check() === !!expected;
}

async function driveToggle(selector, expected, check) {
  if (!!check() === !!expected) return true;
  const el = document.querySelector(selector);
  if (!el) return false;
  const wasDisabled = el.disabled;
  el.disabled = false;
  el.checked = !!expected;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const ok = await waitFor(check, expected);
  if (!masterEnabled) el.disabled = wasDisabled;
  return ok;
}

async function enableRecall() {
  return driveToggle('[data-vab-recall-enabled]', true, () => RecallSafeDiagnostics.isEnabled());
}

async function disableRecall() {
  return driveToggle('[data-vab-recall-enabled]', false, () => RecallSafeDiagnostics.isEnabled());
}

async function enableLifecycle() {
  // This delegated toggle keeps the existing lifecycle confirmation dialog.
  return driveToggle('[data-vab-lifecycle-enable]', true, () => AutoLifecycleSafeDiagnostics.isEnabled());
}

async function disableLifecycle() {
  return driveToggle('[data-vab-lifecycle-enable]', false, () => AutoLifecycleSafeDiagnostics.isEnabled());
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

    statusText = '正在开启统一主控：先启用Prompt召回，再进入生命周期托管确认…';
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
  setLocks(false);
  try {
    const result = await disableMasterStack({ disableRecall, disableLifecycle });
    masterEnabled = false;
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
  const health = assessMasterHealth({
    masterEnabled,
    recallEnabled: RecallSafeDiagnostics.isEnabled(),
    lifecycleEnabled: AutoLifecycleSafeDiagnostics.isEnabled(),
  });
  lastHealth = health;

  const preflight = currentPreflight();
  if (!preflight.ok) {
    await disableMaster({ reason: `运行中安全条件失效：${preflight.reason}` });
    return;
  }
  if (!health.healthy && health.action === 'fail-closed') {
    await disableMaster({ reason: `故障联动：${health.reason}` });
  }
}

function ensureUi() {
  const host = document.querySelector('#vab-smart-host-safe');
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
    <div class="vab-note">目标形态：日常只保留这一个总开关。开启后统一协调：①冷档案按需Prompt召回；②热变量超载时自动归档；③归档节点真正重新进入MVU时事务重激活。单纯“提到旧人物/武学”只召回，不硬恢复MVU。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-master-enable> 本次页面会话启用统一自动记忆（实验RC）</label>
    <div class="vab-actions"><button class="menu_button" data-vab-master-preview>统一安全预检</button></div>
    <div class="vab-note">主控本身不持久化。开启时仍沿用生命周期模块现有的确认框；若召回层因Prompt冲突退出、生命周期层熔断，或旧自动引擎/手动写入被重新开启，主控会 fail-closed：联动关闭全部自动功能。</div>
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
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
  healthTimer = setInterval(() => healthCheck().catch(error => {
    console.warn('[VAB Memory Master RC] health check failed', error);
  }), UI_INTERVAL_MS);
}

export async function unmountMemoryMasterSafe() {
  if (masterEnabled) await disableMaster({ reason: '候选模块卸载' });
  setLocks(false);
  if (uiTimer) clearInterval(uiTimer);
  if (healthTimer) clearInterval(healthTimer);
  uiTimer = null;
  healthTimer = null;
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
  preview: previewAll,
};
