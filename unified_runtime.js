// Variable Archive Bridge v0.7.0 unified production runtime.
// Replaces the old RC lifecycle writer with the governor -> warm catalog -> safe executor -> scheduler pipeline.
// Recall remains fail-closed; hot reactivation closure is handled by hot_archive_reconcile.js.

import {
  beginBoot,
  clearBootSafeMode,
  decideAutoStart,
  markBootFailed,
  markBootHealthy,
  markBootStopped,
} from './experimental/boot_guard_core.js';

const VERSION = '0.7.0';
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
let archiveTestModule = null;
let lastFault = '';
let testRunning = false;
let lastTestResult = null;
let testStatusText = '一次性真实归档测试尚未执行 · 仅用于故障排查';

function ctx() {
  try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
  catch { return null; }
}

function vab() {
  try { return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null; }
  catch { return null; }
}

function scheduler() {
  try { return window.VariableArchiveBridgeAutoCooling || window.parent?.VariableArchiveBridgeAutoCooling || null; }
  catch { return null; }
}

function readBoot() {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
  try { await scheduler()?.setEnabled?.(false); } catch {}
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
    await enterFault('检测到旧版自动归档总开关仍开启，为避免双写已安全停机');
    return false;
  }

  const auto = scheduler();
  if (!auto?.setEnabled || !auto?.getStatus) {
    await enterFault('v0.7自动降温调度器未就绪');
    return false;
  }

  statusText = '正在启用：按需召回 + 安全自动降温调度…';
  ensureUi();

  const recallOk = await recallModule.setRecallEnabledSession(true);
  if (!recallOk || !recallModule.RecallSafeDiagnostics?.isEnabled?.()) {
    await enterFault(recallModule.RecallSafeDiagnostics?.getStatus?.() || 'Prompt召回层未能启用');
    return false;
  }

  const coolingOk = await auto.setEnabled(true);
  if (!coolingOk || !auto.getStatus()?.enabled) {
    try { await recallModule.setRecallEnabledSession(false); } catch {}
    statusText = '自动降温暂未启用 · 等待生成结束后重试';
    ensureUi();
    return false;
  }

  active = true;
  statusText = '✅ 自动记忆运行中 · 温索引 + 按需召回 + 安全自动降温 + 热状态权威收口';
  ensureUi();
  return true;
}

async function healthCheck() {
  if (!loaded || blocked || faulted || testRunning) return;
  if (!active) {
    scheduleActivation(300);
    return;
  }

  const state = await refreshState();
  if (state?.settings?.autoArchiveGlobal) {
    await enterFault('运行中检测到旧版自动归档总开关被开启，已fail-closed');
    return;
  }

  const recallEnabled = !!recallModule?.RecallSafeDiagnostics?.isEnabled?.();
  const auto = scheduler();
  const coolingStatus = auto?.getStatus?.();
  if (!recallEnabled) {
    await enterFault(recallModule?.RecallSafeDiagnostics?.getStatus?.() || '召回层退出');
    return;
  }
  if (!coolingStatus?.enabled) {
    if ((coolingStatus?.recentErrors || 0) >= 3) {
      await enterFault(coolingStatus?.statusText || '自动降温调度器已熔断');
      return;
    }
    active = false;
    statusText = coolingStatus?.statusText || '自动降温调度器暂停，等待重试';
    scheduleActivation(1000);
  }
  ensureUi();
}

function host() {
  return document.querySelector('#vab-settings #vab-root');
}

function formatTestStatus(result) {
  if (!result) return testStatusText;
  if (result.status === 'passed') {
    return `✅ 实测通过：${result.pointer} · 热节点 ${result.beforeCount}→${result.afterCount} · 冷档案与快照已验证。`;
  }
  return `⚠ 实测未通过：${result.reason || '未知原因'}${result.pointer ? ` · ${result.pointer}` : ''}`;
}

async function runProductionArchiveTest() {
  if (testRunning) return lastTestResult;
  if (!active || blocked || faulted || !archiveTestModule?.runOneTimeArchiveTest) {
    lastTestResult = { status: 'failed', reason: '统一主控尚未处于可测试状态' };
    testStatusText = formatTestStatus(lastTestResult);
    ensureUi();
    return lastTestResult;
  }

  testRunning = true;
  testStatusText = '🧪 正在执行一次性真实归档事务 · 自动调度已临时暂停';
  ensureUi();
  const auto = scheduler();
  const wasEnabled = !!auto?.getStatus?.()?.enabled;
  try {
    if (wasEnabled) await auto.setEnabled(false);
    const result = await archiveTestModule.runOneTimeArchiveTest();
    lastTestResult = result;
    testStatusText = formatTestStatus(result);
    return result;
  } catch (error) {
    lastTestResult = { status: 'failed', reason: error?.message || String(error) };
    testStatusText = formatTestStatus(lastTestResult);
    return lastTestResult;
  } finally {
    if (wasEnabled && !blocked && !faulted) {
      try { await auto?.setEnabled?.(true); }
      catch (error) { await enterFault(`一次性归档测试后自动调度恢复异常：${error?.message || error}`); }
    }
    testRunning = false;
    ensureUi();
  }
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
      <summary>🧠📦 自动记忆 · 插件 v${VERSION}</summary>
      <div class="vab-note" data-vab-prod-status></div>
      <div class="vab-note">默认自动运行。动态集合超过热区预算后，只会处理已经长期闲置、没有近期提及/变化、且通过温索引和事务校验的候选；安装更新后不会立刻改旧聊天，切换聊天后也至少等待一条新稳定消息。生成期间不写、每轮最多1项、异常自动熔断。</div>
      <div class="vab-actions">
        <button class="menu_button" data-vab-prod-test>🧪 一次性真实归档测试</button>
        <button class="menu_button" data-vab-prod-retry style="display:none">解除安全模式并重试</button>
      </div>
      <div class="vab-note" data-vab-prod-test-status></div>`;
    root.prepend(box);
    box.querySelector('[data-vab-prod-test]')?.addEventListener('click', () => {
      runProductionArchiveTest().catch(error => enterFault(error));
    });
    box.querySelector('[data-vab-prod-retry]')?.addEventListener('click', async () => {
      try { writeBoot(clearBootSafeMode(readBoot())); } catch {}
      blocked = false;
      faulted = false;
      lastFault = '';
      statusText = '正在重试统一主控…';
      ensureUi();
      if (!loaded) await loadRuntime();
      else scheduleActivation(200);
    });
  }

  const status = box.querySelector('[data-vab-prod-status]');
  const autoStatus = scheduler()?.getStatus?.();
  if (status) {
    const suffix = autoStatus?.enabled && autoStatus?.statusText ? ` · ${autoStatus.statusText}` : '';
    status.textContent = `${active ? '●' : '○'} ${statusText}${suffix}`;
  }
  const retry = box.querySelector('[data-vab-prod-retry]');
  if (retry) retry.style.display = (blocked || faulted) ? '' : 'none';
  const testButton = box.querySelector('[data-vab-prod-test]');
  if (testButton) testButton.disabled = testRunning || !active || blocked || faulted;
  const testStatus = box.querySelector('[data-vab-prod-test-status]');
  if (testStatus) testStatus.textContent = testStatusText;

  // Old RC panels may survive a hot reload; keep them hidden and never enable their writer.
  const recallBox = document.querySelector('#vab-recall-safe');
  const lifecycleBox = document.querySelector('#vab-auto-lifecycle-safe');
  if (recallBox) recallBox.style.display = 'none';
  if (lifecycleBox) lifecycleBox.style.display = 'none';
}

function markHealthyLater() {
  if (healthyTimer) clearTimeout(healthyTimer);
  healthyTimer = setTimeout(() => {
    try {
      if (bootRecord?.phase === 'starting' && !blocked && !faulted) writeBoot(markBootHealthy(bootRecord));
    } catch {}
  }, HEALTHY_DELAY_MS);
}

async function loadRuntime() {
  if (loading || loaded || blocked) return;
  loading = true;
  statusText = '正在加载统一自动记忆引擎…';
  ensureUi();
  try {
    const [recall, archiveTest] = await Promise.all([
      import('./experimental/recall_safe.js'),
      import('./experimental/one_time_archive_test.js'),
    ]);
    if (typeof recall.mountRecallSafe !== 'function' || typeof recall.setRecallEnabledSession !== 'function') {
      throw new Error('召回模块接口不完整');
    }
    if (typeof archiveTest.runOneTimeArchiveTest !== 'function') {
      throw new Error('一次性归档测试模块接口不完整');
    }

    recallModule = recall;
    archiveTestModule = archiveTest;
    recall.mountRecallSafe();
    loaded = true;
    statusText = '引擎已加载 · 正在等待可管理的MVU';
    hookEvents();
    ensureUi();
    scheduleActivation(300);
    markHealthyLater();
  } catch (error) {
    try { await recallModule?.unmountRecallSafe?.(); } catch {}
    recallModule = null;
    archiveTestModule = null;
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
    if (healthTimer) clearInterval(healthTimer);
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
    testRunning,
    lastTestResult,
    scheduler: scheduler()?.getStatus?.() || null,
    boot: readBoot(),
  }),
  retry: async () => {
    writeBoot(clearBootSafeMode(readBoot()));
    blocked = false;
    faulted = false;
    lastFault = '';
    if (!loaded) await loadRuntime();
    else scheduleActivation(100);
  },
  runOneTimeArchiveTest: runProductionArchiveTest,
};
