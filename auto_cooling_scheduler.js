// Variable Archive Bridge v0.8.0 automatic governance scheduler.
// Event-driven only: after a new stable message, it may execute ONE verified transaction:
// internal-history compaction first when a hard limit is exceeded, otherwise ordinary object cooling.
// The scheduler itself never writes MVU; writes are delegated to the dedicated transactional executors.

import { evaluateAutoCooling, DEFAULT_AUTO_COOLING_POLICY } from './auto_cooling_scheduler_core.js';
import { evaluateAutoHistoryCompaction, HISTORY_COMPACTION_POLICY } from './history_compaction_core.js';
import { isGenerationActive } from './experimental/rehydration_live_adapter.js';

const VERSION = '0.8.0';
const SETTLE_MS = 2600;
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERRORS_IN_WINDOW = 3;

let enabled = false;
let busy = false;
let generationFlag = false;
let timer = null;
let eventBindings = [];
let armedMessageCount = -1;
let lastScopeKey = '';
let lastResult = null;
let statusText = '等待统一主控启用';
let errorTimes = [];

function ctx() {
  try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
  catch { return null; }
}

function core() {
  try { return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null; }
  catch { return null; }
}

function executor() {
  try { return window.VariableArchiveBridgeSafeCooling || window.parent?.VariableArchiveBridgeSafeCooling || null; }
  catch { return null; }
}

function historyExecutor() {
  try { return window.VariableArchiveBridgeHistoryCompactor || window.parent?.VariableArchiveBridgeHistoryCompactor || null; }
  catch { return null; }
}

function messageCount() {
  return ctx()?.chat?.length ?? 0;
}

function scopeKey() {
  return String(core()?.getState?.()?.current?.scopeKey || '');
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(delay = SETTLE_MS) {
  clearTimer();
  if (!enabled || generationFlag || busy) return;
  timer = setTimeout(() => {
    timer = null;
    runCycle().catch(error => recordError(error));
  }, Math.max(500, Number(delay) || SETTLE_MS));
}

function recordError(error) {
  const now = Date.now();
  errorTimes = errorTimes.filter(t => now - t <= ERROR_WINDOW_MS);
  errorTimes.push(now);
  const message = String(error?.message || error || '未知异常');
  lastResult = { status: 'error', reason: message, failClosed: true };
  if (errorTimes.length >= MAX_ERRORS_IN_WINDOW) {
    enabled = false;
    clearTimer();
    statusText = `已熔断：10分钟内异常${errorTimes.length}次 · ${message}`;
  } else {
    statusText = `本轮异常，已安全跳过：${message}`;
  }
  return lastResult;
}

function bindEvent(name, handler) {
  const source = ctx()?.eventSource;
  if (!name || !source?.on) return;
  source.on(name, handler);
  eventBindings.push({ source, name, handler });
}

function hookEvents() {
  if (eventBindings.length) return;
  const e = ctx()?.event_types || ctx()?.eventTypes || {};
  const generationStarted = () => {
    generationFlag = true;
    clearTimer();
    if (enabled) statusText = '模型生成中 · 自动治理暂停';
  };
  const generationEnded = () => {
    generationFlag = false;
    if (enabled) schedule();
  };
  const stableMessage = () => {
    if (enabled && !generationFlag) schedule();
  };
  const chatChanged = () => {
    clearTimer();
    lastScopeKey = '';
    armedMessageCount = messageCount();
    statusText = enabled ? '聊天已切换 · 至少等待一条新的稳定消息' : '等待统一主控启用';
  };

  bindEvent(e.GENERATION_STARTED, generationStarted);
  bindEvent(e.GENERATION_STOPPED, generationEnded);
  bindEvent(e.GENERATION_ENDED, generationEnded);
  bindEvent(e.CHARACTER_MESSAGE_RENDERED, stableMessage);
  bindEvent(e.MESSAGE_RECEIVED, stableMessage);
  bindEvent(e.MESSAGE_UPDATED, stableMessage);
  bindEvent(e.CHAT_CHANGED, chatChanged);
}

function unhookEvents() {
  for (const { source, name, handler } of eventBindings) {
    try { source?.removeListener?.(name, handler); } catch {}
  }
  eventBindings = [];
}

async function runCycle({ previewOnly = false } = {}) {
  if (busy) return { status: 'hold', reason: '自动治理调度器忙' };
  if (!enabled && !previewOnly) return { status: 'hold', reason: '自动治理未启用' };
  busy = true;
  try {
    const ex = executor();
    const hx = historyExecutor();
    if (!ex?.plan || !ex?.executeOne) throw new Error('安全降温执行器尚未就绪');
    if (!hx?.plan || !hx?.executeOne) throw new Error('内部历史压缩执行器尚未就绪');

    const activeGeneration = generationFlag || await isGenerationActive();
    const currentScope = scopeKey();
    if (!currentScope) return { status: 'hold', reason: '当前没有MVU作用域' };
    if (lastScopeKey && currentScope !== lastScopeKey) {
      lastScopeKey = currentScope;
      armedMessageCount = messageCount();
      return { status: 'hold', reason: '聊天作用域刚变化，等待下一条稳定消息' };
    }
    lastScopeKey = currentScope;

    // 1) Hard-overflow internal history gets first priority. It only removes an old prefix,
    // keeps recent items hot, and for generic inferred arrays requires learned append-at-end evidence.
    const historyPlan = await hx.plan();
    const historyDecision = evaluateAutoHistoryCompaction({
      enabled: enabled || previewOnly,
      generationActive: activeGeneration,
      messageCount: messageCount(),
      armedMessageCount,
      plan: historyPlan,
      policy: HISTORY_COMPACTION_POLICY,
    });
    if (historyDecision.allow) {
      if (previewOnly) {
        lastResult = { status: 'ready', type: 'history-segment', reason: historyDecision.reason, candidate: historyPlan.candidate, previewOnly: true };
        statusText = `只读可执行历史压缩：${historyPlan.candidate.arrayPath}`;
        return lastResult;
      }
      const result = await hx.executeOne();
      lastResult = result;
      if (result?.status === 'committed') {
        errorTimes = [];
        statusText = `✅ 内部历史已降温：${result.ownerKey} · ${result.label} · ${result.movedItems}条`;
        return result;
      }
      if (result?.status === 'error') return recordError(result.reason || '内部历史压缩失败');
      statusText = `待机：${result?.reason || result?.status || '历史执行器未提交'}`;
      return result;
    }

    // 2) Otherwise run the existing whole-object cooling path.
    const plan = await ex.plan();
    const decision = evaluateAutoCooling({
      enabled: enabled || previewOnly,
      generationActive: activeGeneration,
      messageCount: messageCount(),
      armedMessageCount,
      plan,
      policy: DEFAULT_AUTO_COOLING_POLICY,
    });

    if (!decision.allow) {
      const historyReason = historyPlan?.status === 'hold' ? historyPlan.reason : historyDecision.reason;
      const ordinaryReason = decision.reason;
      lastResult = { status: 'hold', reason: ordinaryReason, historyReason, candidate: plan?.candidate || null };
      statusText = `待机：${ordinaryReason}${historyReason && !/当前没有/.test(historyReason) ? ` · 历史:${historyReason}` : ''}`;
      return lastResult;
    }
    if (previewOnly) {
      lastResult = { status: 'ready', type: 'object', reason: decision.reason, candidate: plan.candidate, previewOnly: true };
      statusText = `只读可执行：${plan.candidate.pointer}`;
      return lastResult;
    }

    const result = await ex.executeOne();
    lastResult = result;
    if (result?.status === 'committed') {
      errorTimes = [];
      statusText = `✅ 自动降温完成：${result.pointer}`;
    } else if (result?.status === 'error') {
      return recordError(result.reason || '自动降温失败');
    } else {
      statusText = `待机：${result?.reason || result?.status || '执行器未提交'}`;
    }
    return result;
  } catch (error) {
    return recordError(error);
  } finally {
    busy = false;
  }
}

export async function setAutoCoolingEnabled(value) {
  const next = !!value;
  if (!next) {
    enabled = false;
    clearTimer();
    statusText = '自动治理已关闭';
    return enabled;
  }
  if (await isGenerationActive()) {
    enabled = false;
    statusText = '模型正在生成，暂不启用自动治理';
    return enabled;
  }
  hookEvents();
  enabled = true;
  generationFlag = false;
  errorTimes = [];
  lastScopeKey = scopeKey();
  // Critical safety rule: installing/updating the plugin never immediately mutates an old chat.
  // At least one new stable message must happen after arming, or after every chat switch.
  armedMessageCount = messageCount();
  statusText = '已启用 · 等待下一条稳定消息后按需治理';
  return enabled;
}

hookEvents();

window.addEventListener('beforeunload', () => {
  clearTimer();
  unhookEvents();
}, { once: true });

window.VariableArchiveBridgeAutoCooling = {
  VERSION,
  setEnabled: setAutoCoolingEnabled,
  preview: () => runCycle({ previewOnly: true }),
  runNow: () => runCycle(),
  getStatus: () => ({
    enabled,
    busy,
    generationFlag,
    scheduled: !!timer,
    armedMessageCount,
    lastScopeKey,
    statusText,
    lastResult: lastResult ? structuredClone(lastResult) : null,
    recentErrors: errorTimes.length,
    policy: { ...DEFAULT_AUTO_COOLING_POLICY },
    historyPolicy: { ...HISTORY_COMPACTION_POLICY },
    eventDriven: true,
    directMvuWrites: false,
    maxTransactionsPerCycle: 1,
    internalHistoryCompaction: true,
  }),
};
