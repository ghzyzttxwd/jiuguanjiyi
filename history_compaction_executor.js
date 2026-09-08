// Variable Archive Bridge v0.8.0 transactional internal-history compactor.
// Moves only the oldest verified prefix of an overgrown history array into the existing cold archive DB.
// It never invents fields inside the card schema. Cold history stays external and is recalled on demand.

import {
  HISTORY_COMPACTION_POLICY,
  historyArrayPath,
  selectHistoryCompactionPlan,
  validateHistoryPlanCurrent,
  validateHistoryPost,
} from './history_compaction_core.js';
import { getByPointer } from './hot_state_governor_core.js';
import { isGenerationActive } from './experimental/rehydration_live_adapter.js';

const VERSION = '0.8.0';
const DB_NAME = 'variable_archive_bridge';
const EVIDENCE_KEY = 'vab.history.append-evidence.v1';
const COOLDOWN_MS = 45_000;

let busy = false;
let lastRunAt = 0;
let lastResult = null;
let dbPromise = null;

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

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch {}
  }
  return JSON.parse(JSON.stringify(value));
}

function resolveMvu() {
  try { return window.Mvu || window.parent?.Mvu || null; }
  catch { return null; }
}

function hashValue(value) {
  let text = '';
  try { text = JSON.stringify(value); } catch { text = String(value ?? ''); }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function parsePointer(path) {
  if (!path || path === '/') return [];
  return String(path).slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function setByPointer(root, path, value) {
  const keys = parsePointer(path);
  if (!keys.length) throw new Error('禁止覆盖stat_data根节点');
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cur[key] || typeof cur[key] !== 'object') throw new Error(`历史路径父节点不存在：${path}`);
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}

function makeId() {
  try { return `history_${Date.now()}_${crypto.randomUUID()}`; }
  catch { return `history_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function byteSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; }
  catch { return String(value ?? '').length; }
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (['number', 'boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.slice(0, 3).map(textOf).filter(Boolean).join('；');
  if (typeof value !== 'object') return '';
  const preferred = ['标题','名称','事件','内容','描述','结果','时间','日期','地点','状态'];
  const parts = [];
  for (const key of preferred) {
    const v = value[key];
    if (v == null || typeof v === 'object') continue;
    const s = String(v).replace(/\s+/g, ' ').trim();
    if (s) parts.push(`${key}:${s}`);
    if (parts.length >= 4) break;
  }
  if (!parts.length) {
    for (const [key, v] of Object.entries(value)) {
      if (v == null || typeof v === 'object') continue;
      const s = String(v).replace(/\s+/g, ' ').trim();
      if (s && s.length <= 100) parts.push(`${key}:${s}`);
      if (parts.length >= 4) break;
    }
  }
  return parts.join('；');
}

function summarizePlan(plan) {
  const first = textOf(plan.removedItems?.[0]);
  const last = textOf(plan.removedItems?.at?.(-1));
  const body = [first, last && last !== first ? last : ''].filter(Boolean).join(' → ');
  const text = `${plan.ownerKey}｜${plan.label}｜历史${plan.removeCount}条${body ? `｜${body}` : ''}`;
  return text.length > 520 ? `${text.slice(0, 517)}…` : text;
}

function collectTags(plan, summary) {
  const source = [plan.ownerKey, plan.label, plan.containerPath, plan.fieldPath, summary,
    ...(plan.removedItems || []).slice(0, 6).map(textOf)]
    .join(' ');
  return [...new Set(source.split(/[\s,，。；;：:|｜/\\\[\]{}()（）<>《》"'`]+/)
    .map(x => x.trim()).filter(x => x.length >= 2 && x.length <= 36))].slice(0, 40);
}

function readEvidenceStore() {
  try { return JSON.parse(localStorage.getItem(EVIDENCE_KEY) || '{}'); }
  catch { return {}; }
}

function writeEvidenceStore(store) {
  try { localStorage.setItem(EVIDENCE_KEY, JSON.stringify(store)); } catch {}
}

function sampleArray(arr) {
  const n = arr.length;
  const headN = Math.min(6, n);
  const tailN = Math.min(6, n);
  return {
    len: n,
    head: arr.slice(0, headN).map(hashValue),
    tail: arr.slice(Math.max(0, n - tailN)).map(hashValue),
  };
}

function observeAppendEvidence(scopeKey, preview, statData) {
  const all = readEvidenceStore();
  const scope = all[scopeKey] ||= {};
  const scores = {};
  for (const row of preview?.histories || []) {
    const path = historyArrayPath(row);
    const arr = getByPointer(statData, path);
    if (!path || !Array.isArray(arr)) continue;
    const old = scope[path];
    let evidence = Math.max(0, Number(old?.evidence) || 0);
    if (old && arr.length > old.len) {
      const headOk = old.head.every((h, i) => hashValue(arr[i]) === h);
      const start = Math.max(0, old.len - old.tail.length);
      const tailOk = old.tail.every((h, i) => hashValue(arr[start + i]) === h);
      if (headOk && tailOk) evidence = Math.min(9, evidence + 1);
      else evidence = 0;
    } else if (old && arr.length < old.len) {
      // A shrink can be our own verified compaction; preserve existing confidence.
      evidence = Math.max(0, evidence);
    }
    scope[path] = { ...sampleArray(arr), evidence, seenAt: messageCount() };
    scores[path] = evidence;
  }
  const keys = Object.keys(scope);
  if (keys.length > 80) {
    keys.sort((a, b) => Number(scope[b]?.seenAt || 0) - Number(scope[a]?.seenAt || 0));
    for (const key of keys.slice(80)) delete scope[key];
  }
  const scopeKeys = Object.keys(all);
  if (scopeKeys.length > 20) {
    scopeKeys.sort((a, b) => Math.max(...Object.values(all[b] || {}).map(x => Number(x?.seenAt || 0)), 0)
      - Math.max(...Object.values(all[a] || {}).map(x => Number(x?.seenAt || 0)), 0));
    for (const key of scopeKeys.slice(20)) delete all[key];
  }
  writeEvidenceStore(all);
  return scores;
}

function preserveEvidenceAfterCommit(scopeKey, plan, newArray) {
  const all = readEvidenceStore();
  const scope = all[scopeKey] ||= {};
  const old = scope[plan.arrayPath] || {};
  scope[plan.arrayPath] = {
    ...sampleArray(newArray),
    evidence: Math.max(Number(old.evidence) || 0, plan.inferred ? HISTORY_COMPACTION_POLICY.requiredAppendEvidenceForInferred : 0),
    seenAt: messageCount(),
  };
  writeEvidenceStore(all);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('冷档案数据库打开失败'));
  });
  return dbPromise;
}

async function putArchive(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('archives', 'readwrite');
    tx.objectStore('archives').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('历史冷档案写入失败'));
    tx.onabort = () => reject(tx.error || new Error('历史冷档案事务中止'));
  });
}

async function deleteArchive(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('archives', 'readwrite');
    tx.objectStore('archives').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('历史冷档案清理失败'));
  });
}

async function stableState() {
  const c = core();
  if (!c?.refreshCurrent || !c?.getState) throw new Error('变量归档桥核心尚未就绪');
  await c.refreshCurrent({ render: false });
  const state = c.getState();
  if (!state?.current?.scopeKey || !state?.latestMvu?.statData || !state?.latestMvu?.variables) {
    throw new Error('当前没有可治理的MVU');
  }
  return state;
}

async function refreshPreview() {
  const g = governor();
  if (!g?.refresh || !g?.getPreview) throw new Error('热变量治理器尚未就绪');
  await g.refresh();
  return g.getPreview();
}

export async function planHistoryCompaction() {
  if (await isGenerationActive()) return { status: 'hold', reason: '模型正在生成' };
  const state = await stableState();
  const preview = await refreshPreview();
  const evidence = observeAppendEvidence(state.current.scopeKey, preview, state.latestMvu.statData);
  const candidate = selectHistoryCompactionPlan({
    preview,
    statData: state.latestMvu.statData,
    appendEvidence: evidence,
  });
  if (!candidate) {
    const hasInferredHard = (preview?.histories || []).some(row => row?.level === 'hard' && row?.inferred === true);
    return {
      status: 'hold',
      reason: hasInferredHard
        ? '发现通用历史数组超限，但尚未学习到可靠的末尾追加顺序，保守不动'
        : '当前没有超过硬上限的内部历史',
    };
  }
  return {
    status: 'ready',
    candidate,
    scopeKey: state.current.scopeKey,
    messageId: state.latestMvu.messageId,
    messageCount: messageCount(),
  };
}

async function writeMvu(messageId, variables) {
  const mvu = resolveMvu();
  if (!mvu?.replaceMvuData) throw new Error('未找到Mvu.replaceMvuData');
  await mvu.replaceMvuData(variables, { type: 'message', message_id: messageId });
}

export async function executeOneHistoryCompaction({ forceCooldown = false } = {}) {
  if (busy) return { status: 'hold', reason: '已有历史压缩事务正在执行' };
  busy = true;
  try {
    if (await isGenerationActive()) return { status: 'hold', reason: '模型正在生成，禁止写MVU' };
    const now = Date.now();
    if (!forceCooldown && lastRunAt && now - lastRunAt < COOLDOWN_MS) {
      return { status: 'hold', reason: '历史压缩事务冷却中' };
    }

    const initialPlan = await planHistoryCompaction();
    if (initialPlan.status !== 'ready') return initialPlan;
    const firstState = await stableState();
    if (firstState.current.scopeKey !== initialPlan.scopeKey) return { status: 'hold', reason: '聊天作用域已变化' };
    const originalArray = deepClone(getByPointer(firstState.latestMvu.statData, initialPlan.candidate.arrayPath));
    const pre = validateHistoryPlanCurrent(initialPlan.candidate, firstState.latestMvu.statData);
    if (!pre.ok) return { status: 'hold', reason: pre.reason };

    // Re-plan immediately before mutation. Any candidate drift aborts fail-closed.
    const freshPlan = await planHistoryCompaction();
    if (freshPlan.status !== 'ready' || freshPlan.scopeKey !== initialPlan.scopeKey ||
        freshPlan.candidate.arrayPath !== initialPlan.candidate.arrayPath ||
        freshPlan.candidate.removeCount !== initialPlan.candidate.removeCount) {
      return { status: 'hold', reason: '内部历史候选在执行前发生变化，已取消' };
    }
    const state = await stableState();
    const plan = freshPlan.candidate;
    const pre2 = validateHistoryPlanCurrent(plan, state.latestMvu.statData);
    if (!pre2.ok) return { status: 'hold', reason: pre2.reason };

    const id = makeId();
    const summary = summarizePlan(plan);
    const archiveRecord = {
      id,
      recordType: 'history-segment',
      scopeKey: state.current.scopeKey,
      scopeLabel: state.current.scopeLabel,
      sourcePath: plan.arrayPath,
      childKey: `${plan.ownerKey}·${plan.label}`,
      // Pseudo pointer deliberately never overlaps the still-hot history array.
      pointer: `${plan.arrayPath}/__vab_history/${id}`,
      kindLabel: '内部历史',
      data: {
        ownerKey: plan.ownerKey,
        label: plan.label,
        fieldPath: plan.fieldPath,
        items: deepClone(plan.removedItems),
        removedCount: plan.removeCount,
        beforeCount: plan.beforeCount,
        afterCount: plan.afterCount,
      },
      summary,
      tags: collectTags(plan, summary),
      size: byteSize(plan.removedItems),
      archivedAt: Date.now(),
      messageId: state.latestMvu.messageId,
      messageCount: messageCount(),
      status: 'pending',
      pinned: false,
      mirroredToMemory: false,
      automatic: true,
      historyMeta: {
        verified: false,
        inferred: !!plan.inferred,
        appendEvidence: plan.appendEvidence,
        arrayPath: plan.arrayPath,
      },
    };

    const c = core();
    await c.saveSnapshot?.('before-auto-history-compact');
    await putArchive(archiveRecord);

    const vars = deepClone(state.latestMvu.variables);
    const stat = deepClone(state.latestMvu.statData);
    setByPointer(stat, plan.arrayPath, deepClone(plan.expectedRemaining));
    vars.stat_data = stat;
    try {
      await writeMvu(state.latestMvu.messageId, vars);
    } catch (error) {
      await deleteArchive(id).catch(() => {});
      throw error;
    }

    await new Promise(r => setTimeout(r, 90));
    const after = await stableState();
    const post = validateHistoryPost(plan, after.latestMvu.statData);
    if (!post.ok) {
      const currentArray = getByPointer(after.latestMvu.statData, plan.arrayPath);
      const unchanged = Array.isArray(currentArray) && hashValue(currentArray) === hashValue(originalArray);
      if (unchanged) {
        // Our write did not take effect. Nothing was removed, so discard the pending copy and stop.
        await deleteArchive(id).catch(() => {});
        throw new Error(`历史压缩写入未生效，热变量保持原样：${post.reason}`);
      }

      // Do NOT "rollback" by overwriting a changed array: another updater may have appended/edited
      // history after our write. Preserve the complete removed prefix in cold storage and fail closed.
      archiveRecord.status = 'archived';
      archiveRecord.historyMeta = {
        ...archiveRecord.historyMeta,
        verified: false,
        recoveryRequired: true,
        concurrentChangeDetected: true,
        verifyError: post.reason,
      };
      await putArchive(archiveRecord);
      throw new Error(`历史压缩后检测到并发变化；为避免覆盖新剧情，未回写旧数组，冷副本已保留并触发安全停机：${post.reason}`);
    }

    archiveRecord.status = 'archived';
    archiveRecord.historyMeta = { ...archiveRecord.historyMeta, verified: true, committedAt: Date.now() };
    await putArchive(archiveRecord);
    preserveEvidenceAfterCommit(state.current.scopeKey, plan, post.current);
    lastRunAt = Date.now();
    await core()?.refreshCurrent?.({ render: false }).catch(() => {});
    await catalog()?.sync?.().catch(() => {});

    lastResult = {
      status: 'committed',
      type: 'history-segment',
      pointer: plan.arrayPath,
      archiveId: id,
      ownerKey: plan.ownerKey,
      label: plan.label,
      movedItems: plan.removeCount,
      bytes: plan.removedBytes,
      beforeCount: plan.beforeCount,
      afterCount: plan.afterCount,
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

window.VariableArchiveBridgeHistoryCompactor = {
  VERSION,
  plan: planHistoryCompaction,
  executeOne: executeOneHistoryCompaction,
  getStatus: () => ({
    busy,
    lastRunAt,
    lastResult: lastResult ? deepClone(lastResult) : null,
    maxItemsPerSegment: HISTORY_COMPACTION_POLICY.maxItemsPerSegment,
    maxBytesPerSegment: HISTORY_COMPACTION_POLICY.maxBytesPerSegment,
    automaticEnabled: false,
  }),
};
