// VAB lifecycle watchdog: low-frequency recovery trigger for MVU updates that land after chat events.
// It never mutates MVU or IndexedDB directly. It only wakes the existing guarded lifecycle engine
// when an archived record is already present again in the current hot MVU.

const START_DELAY_MS = 9000;
const POLL_MS = 6000;

let timer = null;
let running = false;
let lifecycleModule = null;
let rehydrationCore = null;
let lastWakeAt = 0;
let lastPointer = '';
let lastError = '';

function getVab() {
  try {
    return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
  } catch {
    return null;
  }
}

function productionActive() {
  try {
    return !!(window.VariableArchiveBridgeAuto || window.parent?.VariableArchiveBridgeAuto)?.getStatus?.()?.active;
  } catch {
    return false;
  }
}

async function ensureModules() {
  if (lifecycleModule && rehydrationCore) return true;
  try {
    [lifecycleModule, rehydrationCore] = await Promise.all([
      import('./auto_lifecycle_safe.js'),
      import('./rehydration_core.js'),
    ]);
    return true;
  } catch (error) {
    lastError = `模块加载失败：${error?.message || error}`;
    return false;
  }
}

async function tick() {
  if (running || document.hidden || !productionActive()) return;
  running = true;
  try {
    if (!await ensureModules()) return;

    const diagnostics = lifecycleModule?.AutoLifecycleSafeDiagnostics;
    if (!diagnostics?.isEnabled?.()) return;
    const runtime = diagnostics.getRuntime?.() || {};
    if (runtime.busy || runtime.generationFlag || runtime.scheduled) return;

    const vab = getVab();
    if (!vab?.refreshCurrent || !vab?.getState) return;

    // A transient no-MVU read is not an error; the next watchdog pass retries.
    try { await vab.refreshCurrent({ render: false }); } catch {}
    const state = vab.getState?.() || null;
    const statData = state?.latestMvu?.statData || null;
    if (!statData) return;

    const archives = (state?.archiveCache || []).filter(record => record?.status === 'archived');
    if (!archives.length) return;

    const plans = rehydrationCore.buildRehydrationPlans({
      archives,
      statData,
      settings: { maxPlansPerCycle: 1 },
    });
    const plan = plans?.[0] || null;
    if (!plan?.pointer) return;

    // Wake the existing lifecycle engine. setEnabled(true) is idempotent for an already-enabled
    // session and schedules the normal guarded cycle; all generation/scope/stability checks remain intact.
    const ok = await lifecycleModule.setLifecycleEnabledSession(true, { skipConfirm: true });
    if (!ok) {
      lastError = diagnostics.getStatus?.() || '生命周期引擎拒绝唤醒';
      return;
    }

    lastWakeAt = Date.now();
    lastPointer = plan.pointer;
    lastError = '';
  } catch (error) {
    lastError = String(error?.message || error);
    console.warn('[VAB Lifecycle Watchdog]', error);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), POLL_MS);
}

setTimeout(start, START_DELAY_MS);

window.VariableArchiveBridgeLifecycleWatchdog = {
  getStatus: () => ({
    running,
    active: !!timer,
    lastWakeAt,
    lastPointer,
    lastError,
    pollMs: POLL_MS,
  }),
  tick: () => tick(),
};
