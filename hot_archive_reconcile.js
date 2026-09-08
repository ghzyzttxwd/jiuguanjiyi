// Variable Archive Bridge 0.2.2 hot-presence reconciler.
//
// Purpose:
//   If an archived record's exact JSON Pointer has genuinely reappeared in the current hot MVU,
//   current hot MVU is authoritative and the old cold version must stop being an active recall candidate.
//
// Design notes:
//   - independent of SillyTavern message timing and lifecycle scheduler events
//   - does NOT write MVU
//   - does NOT merge cold-only fields back into hot state
//   - requires two stable observations before closing a cold record
//   - keeps the old record in IndexedDB with status='restored' for audit/history

import { selectHotArchiveMatches } from './hot_archive_reconcile_core.js';

const DB_NAME = 'variable_archive_bridge';
const START_DELAY_MS = 3000;
const POLL_MS = 2500;
const MIN_OBSERVATIONS = 2;
const MIN_STABLE_MS = 2000;

let timer = null;
let running = false;
let observation = null;
let lastClosed = [];
let lastError = '';
let lastScanAt = 0;
let lastResult = '等待首次扫描';

function getVab() {
  try {
    return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
  } catch {
    return null;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开变量归档数据库'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB事务中止'));
  });
}

function signatureFor(matches, scopeKey) {
  const ids = matches
    .map(item => `${item.record?.id || ''}@${item.pointer || ''}`)
    .filter(Boolean)
    .sort();
  return `${scopeKey}::${ids.join('|')}`;
}

function resetObservation() {
  observation = null;
}

function observeStable(matches, scopeKey, now) {
  const signature = signatureFor(matches, scopeKey);
  if (!signature || !matches.length) {
    resetObservation();
    return false;
  }

  if (observation?.signature === signature) {
    observation.count += 1;
    observation.lastSeenAt = now;
  } else {
    observation = {
      signature,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      pointers: matches.map(x => x.pointer),
    };
  }

  return observation.count >= MIN_OBSERVATIONS
    && now - observation.firstSeenAt >= MIN_STABLE_MS;
}

async function closeRecords(matches, scopeKey) {
  if (!matches.length) return 0;
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains('archives')) return 0;

    const tx = db.transaction('archives', 'readwrite');
    const store = tx.objectStore('archives');
    const now = Date.now();
    let changed = 0;

    for (const item of matches) {
      const id = item.record?.id;
      if (!id) continue;

      // Re-read the record inside the write transaction. This prevents a stale poll from
      // overwriting another component that has already restored/deleted/changed the record.
      const current = await new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('读取归档记录失败'));
      });

      if (!current || current.status !== 'archived') continue;
      if (String(current.scopeKey || '') !== String(scopeKey)) continue;

      store.put({
        ...current,
        status: 'restored',
        restoredAt: now,
        rehydratedMeta: {
          ...(current.rehydratedMeta || {}),
          mode: 'core-hot-presence-reconcile',
          pointer: item.pointer,
          wroteMvu: false,
          hotAuthoritative: true,
        },
      });
      changed += 1;
    }

    await txDone(tx);
    return changed;
  } finally {
    try { db.close(); } catch {}
  }
}

async function scanCurrent() {
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) {
    lastResult = '等待变量归档桥核心就绪';
    return null;
  }

  // Important: use the public core refresh only as a read/refresh operation.
  // Reconciliation itself is independent; it no longer relies on wrapping refreshCurrent.
  try {
    await vab.refreshCurrent({ render: false });
  } catch (error) {
    lastResult = `读取当前MVU失败：${error?.message || error}`;
    return null;
  }

  const state = vab.getState?.() || null;
  const statData = state?.latestMvu?.statData || null;
  const scopeKey = String(state?.current?.scopeKey || '');
  const archives = (state?.archiveCache || []).filter(record => record?.status === 'archived');
  if (!statData || !scopeKey) {
    lastResult = '等待可用MVU';
    return null;
  }

  const matches = selectHotArchiveMatches({ archives, statData, scopeKey });
  return { vab, state, statData, scopeKey, archives, matches };
}

async function tick() {
  if (running || document.hidden) return;
  running = true;
  lastScanAt = Date.now();

  try {
    const scanned = await scanCurrent();
    if (!scanned) {
      resetObservation();
      return;
    }

    if (!scanned.archives.length) {
      lastResult = '当前没有待收口冷归档';
      resetObservation();
      return;
    }

    if (!scanned.matches.length) {
      lastResult = `有${scanned.archives.length}条冷归档；对应路径尚未同时存在于热MVU`;
      resetObservation();
      return;
    }

    const now = Date.now();
    if (!observeStable(scanned.matches, scanned.scopeKey, now)) {
      lastResult = `检测到热节点重现 · 稳定确认 ${observation?.count || 1}/${MIN_OBSERVATIONS}`;
      return;
    }

    // One final fresh read before committing. If the hot node disappeared, do nothing.
    await scanned.vab.refreshCurrent({ render: false });
    const fresh = scanned.vab.getState?.() || null;
    const freshMatches = selectHotArchiveMatches({
      archives: (fresh?.archiveCache || []).filter(r => r?.status === 'archived'),
      statData: fresh?.latestMvu?.statData || null,
      scopeKey: String(fresh?.current?.scopeKey || ''),
    });

    if (!freshMatches.length || String(fresh?.current?.scopeKey || '') !== scanned.scopeKey) {
      lastResult = '提交前复核未通过，未修改冷档案';
      resetObservation();
      return;
    }

    const changed = await closeRecords(freshMatches, scanned.scopeKey);
    if (changed > 0) {
      lastClosed = freshMatches.slice(0, changed).map(x => x.pointer);
      lastError = '';
      lastResult = `已收口 ${changed} 条旧冷档案：${lastClosed.join('、')}`;
      resetObservation();
      // Refresh archiveCache and visible UI immediately. No MVU write occurs here.
      await scanned.vab.refreshCurrent({ render: true });
    } else {
      lastResult = '候选已被其他流程处理，无需重复收口';
      resetObservation();
    }
  } catch (error) {
    lastError = String(error?.message || error);
    lastResult = `重激活收口异常：${lastError}`;
    resetObservation();
    console.warn('[VAB Hot Archive Reconcile]', error);
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

window.VariableArchiveBridgeHotArchiveReconcile = {
  reconcile: () => tick(),
  getStatus: () => ({
    active: !!timer,
    running,
    lastScanAt,
    lastClosed: [...lastClosed],
    lastError,
    lastResult,
    observation: observation ? { ...observation } : null,
    pollMs: POLL_MS,
  }),
};
