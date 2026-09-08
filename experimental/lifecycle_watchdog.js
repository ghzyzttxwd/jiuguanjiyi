// VAB reactivation recovery watchdog.
// Purpose: recover when MVU writes land after SillyTavern message events and the normal lifecycle
// scheduler misses the moment an archived node becomes hot again.
//
// This watchdog NEVER performs generic archiving and NEVER merges cold-only fields into MVU.
// After two stable observations it invokes the existing guarded rehydration transaction with
// autoConservative=true, so current hot MVU remains authoritative.

import { buildRehydrationPlans } from './rehydration_core.js';
import { planSignature } from './auto_lifecycle_core.js';
import { executeRehydrationTransaction } from './rehydration_transaction.js';
import { createRehydrationLiveIo, isGenerationActive } from './rehydration_live_adapter.js';
import { AutoLifecycleSafeDiagnostics } from './auto_lifecycle_safe.js';

const START_DELAY_MS = 8000;
const POLL_MS = 5000;
const MIN_OBSERVATIONS = 2;
const MIN_STABLE_MS = 2500;
const SUCCESS_COOLDOWN_MS = 10000;

let timer = null;
let running = false;
let observation = null;
let lastSuccessAt = 0;
let lastPointer = '';
let lastResult = '';
let lastError = '';
let lastScanAt = 0;

function getVab() {
  try {
    return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
  } catch {
    return null;
  }
}

function productionStatus() {
  try {
    return (window.VariableArchiveBridgeAuto || window.parent?.VariableArchiveBridgeAuto)?.getStatus?.() || null;
  } catch {
    return null;
  }
}

function lifecycleReady() {
  try {
    if (!AutoLifecycleSafeDiagnostics?.isEnabled?.()) return false;
    const runtime = AutoLifecycleSafeDiagnostics.getRuntime?.() || {};
    return !runtime.busy && !runtime.generationFlag;
  } catch {
    return false;
  }
}

function resetObservation() {
  observation = null;
}

function observe(plan, now) {
  const signature = planSignature(plan);
  if (!signature) {
    resetObservation();
    return false;
  }

  if (observation?.signature === signature) {
    observation.count += 1;
    observation.lastSeenAt = now;
  } else {
    observation = {
      pointer: plan.pointer,
      signature,
      recordId: plan.record?.id || '',
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }

  return observation.count >= MIN_OBSERVATIONS
    && now - observation.firstSeenAt >= MIN_STABLE_MS;
}

async function scanState() {
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) return null;

  try { await vab.refreshCurrent({ render: false }); } catch {}
  const state = vab.getState?.() || null;
  const statData = state?.latestMvu?.statData || null;
  if (!statData) return null;

  const archives = (state?.archiveCache || []).filter(record => record?.status === 'archived');
  if (!archives.length) return { state, archives, plan: null };

  const plans = buildRehydrationPlans({
    archives,
    statData,
    settings: { maxPlansPerCycle: 1 },
  });

  return { state, archives, plan: plans?.[0] || null };
}

async function tick() {
  const now = Date.now();
  lastScanAt = now;

  if (running || document.hidden) return;
  const prod = productionStatus();
  if (!prod?.active || prod?.blocked || prod?.faulted) return;
  if (!lifecycleReady()) return;
  if (lastSuccessAt && now - lastSuccessAt < SUCCESS_COOLDOWN_MS) return;

  running = true;
  try {
    const scanned = await scanState();
    if (!scanned) {
      lastResult = '等待可用MVU';
      resetObservation();
      return;
    }

    if (!scanned.archives.length) {
      lastResult = '当前没有冷归档';
      resetObservation();
      return;
    }

    const plan = scanned.plan;
    if (!plan?.pointer || !plan?.record?.id) {
      lastResult = `冷归档${scanned.archives.length}条，但没有节点重新进入热MVU`;
      resetObservation();
      return;
    }

    lastPointer = plan.pointer;
    const stable = observe(plan, now);
    if (!stable) {
      lastResult = `检测到重激活候选 ${plan.pointer} · 稳定确认 ${observation?.count || 1}/${MIN_OBSERVATIONS}`;
      return;
    }

    if (await isGenerationActive()) {
      lastResult = `候选已稳定，但模型仍在生成：${plan.pointer}`;
      return;
    }

    // Use the existing transaction. In automatic conservative mode it does not resurrect
    // cold-only fields. For object changes it simply closes the old cold version while the
    // current hot node remains authoritative.
    const io = createRehydrationLiveIo();
    const result = await executeRehydrationTransaction(io, plan.record.id, {
      autoConservative: true,
    });

    try { await getVab()?.refreshCurrent?.({ render: false }); } catch {}

    lastResult = `${result?.status || 'unknown'} · ${result?.mode || ''} · ${result?.pointer || plan.pointer}`;
    lastError = '';

    if (['restored-without-write', 'committed'].includes(result?.status)) {
      lastSuccessAt = Date.now();
      resetObservation();
    } else if (result?.status === 'noop') {
      // Another guarded path may have completed the same record first. Refresh next pass.
      resetObservation();
    }
  } catch (error) {
    lastError = String(error?.message || error);
    lastResult = '重激活恢复守卫执行异常；未绕过安全事务';
    resetObservation();
    console.warn('[VAB Reactivation Recovery]', error);
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
    lastScanAt,
    lastSuccessAt,
    lastPointer,
    lastResult,
    lastError,
    observation: observation ? { ...observation } : null,
    pollMs: POLL_MS,
  }),
  tick: () => tick(),
};
