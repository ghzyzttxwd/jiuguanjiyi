// Variable Archive Bridge v0.6.0 safe cooling executor.
// This module is deliberately NOT auto-started: it prepares the verified migration path
// that a later release can schedule automatically. One call moves at most one candidate.

import {
  selectNextCoolingCandidate,
  validatePreCooling,
  validatePostCooling,
} from './safe_cooling_core.js';
import { isGenerationActive } from './experimental/rehydration_live_adapter.js';

const VERSION = '0.6.0';
const COOLDOWN_MS = 30_000;

let busy = false;
let lastRunAt = 0;
let lastScopeKey = '';
let lastMessageCount = -1;
let lastResult = null;

function core() {
  try { return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null; }
  catch { return null; }
}

function governor() {
  try { return window.VariableArchiveBridgeHotStateGovernor || window.parent?.VariableArchiveBridgeHotStateGovernor || null; }
  catch { return null; }
}

function catalog() {
  try { return window.VariableArchiveBridgeWarmCatalog || window.parent?.VariableArchiveBridgeWarmCatalog || null; }
  catch { return null; }
}

function ctx() {
  try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
  catch { return null; }
}

function messageCount() {
  return ctx()?.chat?.length ?? 0;
}

async function stableState() {
  const c = core();
  if (!c?.refreshCurrent || !c?.getState) throw new Error('变量归档桥核心尚未就绪');
  await c.refreshCurrent({ render: false });
  const state = c.getState();
  if (!state?.current?.scopeKey || !state?.latestMvu?.statData) throw new Error('当前没有可迁移的MVU');
  return state;
}

export async function planOneCooling() {
  const c = core();
  const g = governor();
  const w = catalog();
  if (!c || !g?.refresh || !g?.getPreview || !w?.sync || !w?.getEntries) {
    return { status: 'hold', reason: '治理器或温索引尚未就绪' };
  }
  if (await isGenerationActive()) return { status: 'hold', reason: '模型正在生成' };

  const before = await stableState();
  await g.refresh();
  await w.sync();
  const refreshed = c.getState();
  const preview = g.getPreview();
  const candidate = selectNextCoolingCandidate(preview);
  if (!candidate) return { status: 'hold', reason: '当前没有降温候选' };

  const check = validatePreCooling({
    candidate,
    catalogEntries: w.getEntries(),
    statData: refreshed?.latestMvu?.statData,
    scopeKey: refreshed?.current?.scopeKey,
  });
  if (!check.ok) return { status: 'hold', reason: check.reason, candidate };

  return {
    status: 'ready',
    candidate,
    scopeKey: refreshed.current.scopeKey,
    messageCount: messageCount(),
    catalogId: check.catalogId,
  };
}

export async function executeOneCooling({ forceCooldown = false } = {}) {
  if (busy) return { status: 'hold', reason: '已有降温事务正在执行' };
  busy = true;
  try {
    if (await isGenerationActive()) return { status: 'hold', reason: '模型正在生成，禁止写MVU' };
    const now = Date.now();
    if (!forceCooldown && lastRunAt && now - lastRunAt < COOLDOWN_MS) {
      return { status: 'hold', reason: '降温事务冷却中' };
    }

    const plan = await planOneCooling();
    if (plan.status !== 'ready') {
      lastResult = plan;
      return plan;
    }

    const countBefore = messageCount();
    if (lastScopeKey && lastScopeKey !== plan.scopeKey) {
      lastMessageCount = -1;
    }
    if (!forceCooldown && lastScopeKey === plan.scopeKey && lastMessageCount === countBefore) {
      return { status: 'hold', reason: '同一消息计数已执行过一次降温事务' };
    }

    // Re-read immediately before mutation. Any scope/candidate drift aborts fail-closed.
    const c = core();
    const g = governor();
    const w = catalog();
    const stable = await stableState();
    if (stable.current.scopeKey !== plan.scopeKey) return { status: 'hold', reason: '聊天作用域已变化' };
    await g.refresh();
    await w.sync();
    const rePreview = g.getPreview();
    const reCandidate = selectNextCoolingCandidate(rePreview);
    if (!reCandidate || reCandidate.pointer !== plan.candidate.pointer) {
      return { status: 'hold', reason: '降温候选在执行前发生变化，已取消' };
    }
    const pre = validatePreCooling({
      candidate: reCandidate,
      catalogEntries: w.getEntries(),
      statData: c.getState()?.latestMvu?.statData,
      scopeKey: plan.scopeKey,
    });
    if (!pre.ok) return { status: 'hold', reason: pre.reason, candidate: reCandidate };

    // Core archiveChild already performs: snapshot -> pending cold copy -> MVU delete -> reread verification -> archived commit.
    // This executor adds governor/catalog gating before it and post-commit catalog verification after it.
    await c.archiveChild(reCandidate.sourcePath, reCandidate.key, { automatic: true });

    await c.refreshCurrent({ render: false });
    await w.sync();
    const after = c.getState();
    if (after?.current?.scopeKey !== plan.scopeKey) {
      throw new Error('降温完成后聊天作用域变化，停止后续动作');
    }
    const post = validatePostCooling({
      candidate: reCandidate,
      catalogEntries: w.getEntries(),
      statData: after?.latestMvu?.statData,
      scopeKey: plan.scopeKey,
    });
    if (!post.ok) throw new Error(`降温后验证失败：${post.reason}`);

    lastRunAt = Date.now();
    lastScopeKey = plan.scopeKey;
    lastMessageCount = messageCount();
    lastResult = {
      status: 'committed',
      pointer: reCandidate.pointer,
      archiveId: post.archiveId,
      catalogId: post.catalogId,
      bytes: reCandidate.bytes,
      hotAuthoritative: true,
      verified: true,
    };
    return lastResult;
  } catch (error) {
    lastResult = { status: 'error', reason: String(error?.message || error), failClosed: true };
    return lastResult;
  } finally {
    busy = false;
  }
}

window.VariableArchiveBridgeSafeCooling = {
  VERSION,
  plan: planOneCooling,
  executeOne: executeOneCooling,
  getStatus: () => ({
    busy,
    lastRunAt,
    lastScopeKey,
    lastMessageCount,
    lastResult: lastResult ? structuredClone(lastResult) : null,
    automaticEnabled: false,
    maxItemsPerRun: 1,
    cooldownMs: COOLDOWN_MS,
  }),
};
