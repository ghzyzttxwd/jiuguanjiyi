// Variable Archive Bridge v0.8.0 internal-history compaction pure logic.
// Chooses only old prefix segments from overgrown history arrays. No browser APIs / MVU writes.

import { getByPointer, byteSize } from './hot_state_governor_core.js';

export const HISTORY_COMPACTION_POLICY = Object.freeze({
  minMessagesBeforeAuto: 20,
  maxItemsPerSegment: 6,
  maxBytesPerSegment: 16 * 1024,
  requiredAppendEvidenceForInferred: 2,
});

function escPtr(value) {
  return String(value ?? '').replace(/~/g, '~0').replace(/\//g, '~1');
}

export function historyArrayPath(row) {
  if (!row?.containerPath || row?.ownerKey == null || !row?.fieldPath) return '';
  const base = String(row.containerPath).replace(/\/$/, '');
  const field = String(row.fieldPath).startsWith('/') ? String(row.fieldPath) : `/${row.fieldPath}`;
  return `${base}/${escPtr(row.ownerKey)}${field}`;
}

function jsonEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

export function selectHistoryCompactionPlan({
  preview = null,
  statData = null,
  appendEvidence = {},
  policy = HISTORY_COMPACTION_POLICY,
} = {}) {
  const rows = Array.isArray(preview?.histories) ? preview.histories : [];
  const candidates = [];

  for (const row of rows) {
    const count = Math.max(0, Number(row?.count) || 0);
    const hardLimit = Math.max(0, Number(row?.hardLimit) || 0);
    const softLimit = Math.max(0, Number(row?.softLimit ?? row?.keep) || 0);
    if (!hardLimit || count <= hardLimit) continue;

    const arrayPath = historyArrayPath(row);
    const arr = getByPointer(statData, arrayPath);
    if (!arrayPath || !Array.isArray(arr) || arr.length !== count) continue;

    const evidence = Math.max(0, Number(appendEvidence?.[arrayPath]) || 0);
    if (row?.inferred === true && evidence < policy.requiredAppendEvidenceForInferred) continue;

    const removable = Math.max(0, arr.length - softLimit);
    if (!removable) continue;

    const maxItems = Math.max(1, Number(policy.maxItemsPerSegment) || 1);
    const maxBytes = Math.max(1024, Number(policy.maxBytesPerSegment) || 1024);
    const wanted = Math.min(removable, maxItems);
    const removedItems = [];
    let bytes = 0;
    for (let i = 0; i < wanted; i++) {
      const itemBytes = byteSize(arr[i]);
      if (removedItems.length && bytes + itemBytes > maxBytes) break;
      removedItems.push(arr[i]);
      bytes += itemBytes;
      if (bytes >= maxBytes) break;
    }
    if (!removedItems.length) continue;

    candidates.push({
      type: 'history-segment',
      arrayPath,
      containerPath: row.containerPath,
      ownerKey: String(row.ownerKey),
      fieldPath: row.fieldPath,
      label: String(row.label || row.fieldPath || '内部历史'),
      inferred: row?.inferred === true,
      appendEvidence: evidence,
      level: 'hard',
      hardLimit,
      softLimit,
      beforeCount: arr.length,
      removeCount: removedItems.length,
      afterCount: arr.length - removedItems.length,
      removedItems,
      removedBytes: bytes,
      expectedRemaining: arr.slice(removedItems.length),
    });
  }

  candidates.sort((a, b) =>
    (b.beforeCount - b.hardLimit) - (a.beforeCount - a.hardLimit) ||
    b.removedBytes - a.removedBytes ||
    a.arrayPath.localeCompare(b.arrayPath, 'zh-CN')
  );
  return candidates[0] || null;
}

export function validateHistoryPlanCurrent(plan, statData) {
  if (!plan?.arrayPath || !Array.isArray(plan.removedItems)) return { ok: false, reason: '历史压缩计划无效' };
  const arr = getByPointer(statData, plan.arrayPath);
  if (!Array.isArray(arr)) return { ok: false, reason: '目标历史数组已不存在' };
  if (arr.length !== plan.beforeCount) return { ok: false, reason: '历史数组长度在执行前发生变化' };
  if (!jsonEqual(arr.slice(0, plan.removeCount), plan.removedItems)) {
    return { ok: false, reason: '历史数组旧段在执行前发生变化' };
  }
  if (!jsonEqual(arr.slice(plan.removeCount), plan.expectedRemaining)) {
    return { ok: false, reason: '历史数组保留段在执行前发生变化' };
  }
  return { ok: true, current: arr };
}

export function validateHistoryPost(plan, statData) {
  const arr = getByPointer(statData, plan?.arrayPath || '');
  if (!Array.isArray(arr)) return { ok: false, reason: '压缩后目标历史数组不存在' };
  if (arr.length !== plan.afterCount) return { ok: false, reason: `压缩后长度异常：${arr.length}/${plan.afterCount}` };
  if (!jsonEqual(arr, plan.expectedRemaining)) return { ok: false, reason: '压缩后保留历史内容不一致' };
  return { ok: true, current: arr };
}

export function evaluateAutoHistoryCompaction({
  enabled = true,
  generationActive = false,
  messageCount = 0,
  armedMessageCount = -1,
  plan = null,
  policy = HISTORY_COMPACTION_POLICY,
} = {}) {
  if (!enabled) return { allow: false, reason: '自动历史压缩未启用' };
  if (generationActive) return { allow: false, reason: '模型正在生成' };
  if (!plan || plan.status !== 'ready' || !plan.candidate) {
    return { allow: false, reason: plan?.reason || '当前没有可安全压缩的内部历史' };
  }
  const count = Math.max(0, Number(messageCount) || 0);
  const minMessages = Math.max(0, Number(policy.minMessagesBeforeAuto) || 0);
  if (count < minMessages) return { allow: false, reason: `聊天楼层未达到历史压缩门槛 ${minMessages}` };
  const armedAt = Number(armedMessageCount);
  if (Number.isFinite(armedAt) && armedAt >= 0 && count <= armedAt) {
    return { allow: false, reason: '启用/切换聊天后尚未产生新的稳定消息' };
  }
  return { allow: true, reason: '内部历史超过硬上限且旧段可安全迁移' };
}
