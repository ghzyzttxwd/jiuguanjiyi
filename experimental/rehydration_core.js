import { getByPointer } from './smart_host_core.js';

export const DEFAULT_REHYDRATION_SETTINGS = Object.freeze({
  maxPlansPerCycle: 1,
  maxMergeDepth: 10,
});

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeEntries(value) {
  return Object.entries(value || {}).filter(([key]) => !BLOCKED_KEYS.has(key));
}

export function mergeColdBaseWithHot(cold, hot, settings = {}, depth = 0) {
  const cfg = { ...DEFAULT_REHYDRATION_SETTINGS, ...settings };
  if (depth >= cfg.maxMergeDepth) return clone(hot);

  // Arrays and scalar values are treated as atomic current state: hot always wins.
  if (!plainObject(cold) || !plainObject(hot)) return clone(hot);

  const out = {};
  for (const [key, value] of safeEntries(cold)) out[key] = clone(value);

  for (const [key, hotValue] of safeEntries(hot)) {
    const coldValue = out[key];
    if (plainObject(coldValue) && plainObject(hotValue)) {
      out[key] = mergeColdBaseWithHot(coldValue, hotValue, cfg, depth + 1);
    } else {
      out[key] = clone(hotValue);
    }
  }
  return out;
}

export function recordPointer(record) {
  if (!record) return '';
  if (record.pointer) return String(record.pointer);
  const sourcePath = String(record.sourcePath || '').replace(/\/$/, '');
  const childKey = String(record.childKey || '')
    .replace(/~/g, '~0')
    .replace(/\//g, '~1');
  return sourcePath && childKey ? `${sourcePath}/${childKey}` : '';
}

function jsonEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function diffSummary(cold, hot) {
  if (!plainObject(cold) || !plainObject(hot)) {
    return {
      coldOnly: 0,
      hotOnly: 0,
      changed: jsonEqual(cold, hot) ? 0 : 1,
    };
  }

  const coldKeys = new Set(safeEntries(cold).map(([key]) => key));
  const hotKeys = new Set(safeEntries(hot).map(([key]) => key));
  let coldOnly = 0;
  let hotOnly = 0;
  let changed = 0;

  for (const key of coldKeys) {
    if (!hotKeys.has(key)) coldOnly++;
    else if (!jsonEqual(cold[key], hot[key])) changed++;
  }
  for (const key of hotKeys) if (!coldKeys.has(key)) hotOnly++;
  return { coldOnly, hotOnly, changed };
}

export function planReactivatedRecord(record, statData, settings = {}) {
  if (!record || record.status !== 'archived' || !statData) return null;
  const pointer = recordPointer(record);
  if (!pointer) return null;
  const hot = getByPointer(statData, pointer);
  if (hot === undefined) return null;

  const exact = jsonEqual(record.data, hot);
  if (exact) {
    return {
      action: 'mark-restored',
      record,
      pointer,
      hot: clone(hot),
      merged: clone(hot),
      diff: { coldOnly: 0, hotOnly: 0, changed: 0 },
      reason: '同一节点已重新出现在热变量，内容与冷档案一致，只需关闭冷档案状态',
    };
  }

  const bothObjects = plainObject(record.data) && plainObject(hot);
  const merged = bothObjects
    ? mergeColdBaseWithHot(record.data, hot, settings)
    : clone(hot);

  return {
    action: bothObjects ? 'merge-hot-over-cold' : 'keep-hot-mark-restored',
    record,
    pointer,
    hot: clone(hot),
    merged,
    diff: diffSummary(record.data, hot),
    reason: bothObjects
      ? '归档节点被重新创建为热对象：以冷档案补齐缺失字段，以当前热值覆盖已变化字段'
      : '归档节点被重新创建为数组或标量：当前热值优先，不用旧冷值覆盖',
  };
}

export function buildRehydrationPlans({ archives = [], statData = null, settings = {} } = {}) {
  const cfg = { ...DEFAULT_REHYDRATION_SETTINGS, ...settings };
  const plans = [];
  const seen = new Set();

  for (const record of archives || []) {
    const pointer = recordPointer(record);
    if (!pointer || seen.has(pointer)) continue;
    const plan = planReactivatedRecord(record, statData, cfg);
    if (!plan) continue;
    seen.add(pointer);
    plans.push(plan);
    if (plans.length >= Math.max(1, Number(cfg.maxPlansPerCycle) || 1)) break;
  }
  return plans;
}

export function formatRehydrationPlan(plan) {
  if (!plan) return '无重激活计划';
  const d = plan.diff || {};
  return `${plan.action} · ${plan.pointer} · 冷档案独有字段${d.coldOnly || 0} · 热变量新增字段${d.hotOnly || 0} · 变化字段${d.changed || 0}`;
}
