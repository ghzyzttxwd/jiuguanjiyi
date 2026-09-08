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
let lastResult = '等待首次扫描';
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

function renderStatus() {
  const box = document.querySelector('#vab-production-auto');
  if (!box) return;
  let line = box.querySelector('[data-vab-reactivation-guard]');
  if (!line) {
    line = document.createElement('div');
    line.className = 'vab-note';
    line.setAttribute('data-vab-reactivation-guard', '');
    const testStatus = box.querySelector('[data-vab-prod-test-status]');
    if (testStatus?.parentNode) testStatus.parentNode.insertBefore(line, testStatus.nextSibling);
    else box.appendChild(line);
  }
  const prefix = lastError ? '⚠' : lastSuccessAt ? '✅' : '◉';
  line.textContent = `${prefix} 重激活守卫：${lastError || lastResult}`;
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
  if (!prod?.active || prod?.blocked || prod?.faulted) {
    lastResult = '自动记忆主控尚未处于运行状态';
    renderStatus();
    return;
  }
  if (!lifecycleReady()) {
    lastResult = '生命周期层暂不可执行（忙碌/生成中/未启用）';
    renderStatus();
    return;
  }
  if (lastSuccessAt && now - lastSuccessAt < SUCCESS_COOLDOWN_MS) {
    renderStatus();
    return;
  }

  running = true;
  try {
    const scanned = await scanState();
    if (!scanned) {
      lastResult = '等待可用MVU';
      resetObservation();
      return;
    }

    if (!scanned.archives.length) {
      lastResult = '当前没有待收口冷归档';
      resetObservation();
      return;
    }

    const plan = scanned.plan;
    if (!plan?.pointer || !plan?.record?.id) {
      lastResult = `有${scanned.archives.length}条冷归档，但对应节点尚未重新进入热MVU`;
      resetObservation();
      return;
    }

    lastPointer = plan.pointer;
    const stable = observe(plan, now);
    if (!stable) {
      lastResult = `检测到 ${plan.pointer} · 稳定确认 ${observation?.count || 1}/${MIN_OBSERVATIONS}`;
      return;
    }

    if (await isGenerationActive()) {
      lastResult = `候选已稳定，但模型仍在生成：${plan.pointer}`;
      return;
    }

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
      resetObservation();
    }
  } catch (error) {
    lastError = String(error?.message || error);
    lastResult = '重激活恢复守卫执行异常；未绕过安全事务';
    resetObservation();
    console.warn('[VAB Reactivation Recovery]', error);
  } finally {
    running = false;
    renderStatus();
  }
}

function start() {
  if (timer) return;
  renderStatus();
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
