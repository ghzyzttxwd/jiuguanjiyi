import { getByPointer } from './smart_host_core.js';
import { isGenerationActive } from './rehydration_live_adapter.js';
import { selectOneTimeArchiveTestCandidate } from './one_time_archive_test_core.js';

const DB_NAME = 'variable_archive_bridge';
const VERSION = '0.2.0-test1';

let running = false;
const completedScopes = new Map();
let lastResult = null;

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function vab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function recentContextText(count = 10) {
  return (ctx()?.chat || [])
    .filter(m => m && typeof m.mes === 'string')
    .slice(-Math.max(1, Number(count) || 10))
    .map(m => String(m.mes || ''))
    .join('\n');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onupgradeneeded = () => {
      try { req.transaction?.abort?.(); } catch {}
      reject(new Error('归档数据库尚未初始化，已拒绝测试写入'));
    };
  });
}

function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 查询失败'));
  });
}

async function findAutoArchiveSnapshot(scopeKey, since) {
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains('snapshots')) return null;
    const tx = db.transaction('snapshots', 'readonly');
    const store = tx.objectStore('snapshots');
    if (!store.indexNames.contains('scopeKey')) return null;
    const rows = await requestResult(store.index('scopeKey').getAll(scopeKey));
    return (rows || [])
      .filter(row => row?.reason === 'before-auto-archive' && Number(row?.createdAt || 0) >= since)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
  } finally {
    try { db.close(); } catch {}
  }
}

function makeFailure(reason, detail = {}) {
  return {
    status: 'failed',
    reason,
    ...detail,
  };
}

export async function runOneTimeArchiveTest() {
  if (running) return makeFailure('一次性归档测试正在执行中');
  const core = vab();
  if (!core?.refreshCurrent || !core?.getState || !core?.archiveChild) {
    return makeFailure('变量归档桥核心API未就绪');
  }
  if (await isGenerationActive()) {
    return makeFailure('模型正在生成，测试已拒绝写入');
  }

  running = true;
  const startedAt = Date.now();
  try {
    await core.refreshCurrent({ render: false });
    const beforeState = core.getState();
    const scopeKey = String(beforeState?.current?.scopeKey || '');
    const statData = beforeState?.latestMvu?.statData;
    if (!scopeKey || !statData) return makeFailure('当前聊天没有可测试的MVU stat_data');
    if (beforeState?.settings?.autoArchiveGlobal) {
      return makeFailure('检测到旧版自动归档总开关仍开启，为避免双写拒绝测试');
    }

    if (completedScopes.has(scopeKey)) {
      lastResult = completedScopes.get(scopeKey);
      return { ...lastResult, repeated: true };
    }

    const candidate = selectOneTimeArchiveTestCandidate({
      statData,
      recentText: recentContextText(10),
      minContainerChildren: 5,
    });
    if (!candidate) {
      return makeFailure('没有找到满足保护条件的一次性测试候选；未修改MVU');
    }

    const beforeContainer = getByPointer(statData, candidate.containerPath);
    const beforeCount = beforeContainer && typeof beforeContainer === 'object'
      ? Object.keys(beforeContainer).length
      : candidate.containerCount;

    await core.archiveChild(candidate.containerPath, candidate.key, { automatic: true });
    await core.refreshCurrent({ render: false });

    const afterState = core.getState();
    const afterStat = afterState?.latestMvu?.statData;
    const afterContainer = getByPointer(afterStat, candidate.containerPath);
    const afterCount = afterContainer && typeof afterContainer === 'object'
      ? Object.keys(afterContainer).length
      : 0;
    const hotRemoved = getByPointer(afterStat, candidate.pointer) === undefined;

    const archiveRecord = (afterState?.archiveCache || [])
      .filter(row => row?.status === 'archived')
      .filter(row => row?.sourcePath === candidate.containerPath && row?.childKey === candidate.key)
      .filter(row => Number(row?.archivedAt || 0) >= startedAt)
      .sort((a, b) => Number(b.archivedAt || 0) - Number(a.archivedAt || 0))[0] || null;

    const snapshot = await findAutoArchiveSnapshot(scopeKey, startedAt);
    const countReduced = afterCount === Math.max(0, beforeCount - 1);
    const archiveVerified = !!archiveRecord;
    const snapshotVerified = !!snapshot;
    const passed = hotRemoved && countReduced && archiveVerified && snapshotVerified;

    const result = {
      status: passed ? 'passed' : 'failed',
      reason: passed ? '真实自动归档事务链已验证通过' : '归档动作执行后有验收项未通过',
      pointer: candidate.pointer,
      containerPath: candidate.containerPath,
      childKey: candidate.key,
      recordSize: candidate.size,
      beforeCount,
      afterCount,
      hotRemoved,
      countReduced,
      archiveVerified,
      archiveId: archiveRecord?.id || '',
      snapshotVerified,
      snapshotId: snapshot?.id || '',
      scopeKey,
      completedAt: Date.now(),
    };

    lastResult = result;
    if (passed) completedScopes.set(scopeKey, result);
    return result;
  } catch (error) {
    lastResult = makeFailure(error?.message || String(error), { error: String(error?.stack || error || '') });
    return lastResult;
  } finally {
    running = false;
  }
}

export const OneTimeArchiveTestDiagnostics = {
  VERSION,
  isRunning: () => running,
  getLastResult: () => lastResult ? { ...lastResult } : null,
};
