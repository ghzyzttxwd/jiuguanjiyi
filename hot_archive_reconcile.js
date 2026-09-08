// Variable Archive Bridge 0.2.1 hot-presence reconciler.
// Single invariant: if an archived record's exact JSON Pointer already exists in current hot MVU,
// the hot node is authoritative and the old cold version must stop being an active recall candidate.
// This module never writes MVU and never merges cold fields back into hot state.

import { selectHotArchiveMatches } from './hot_archive_reconcile_core.js';

const DB_NAME = 'variable_archive_bridge';
let installed = false;
let reconciling = false;
let lastClosed = [];
let lastError = '';

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

async function closeRecords(records) {
  if (!records.length) return 0;
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains('archives')) return 0;
    const tx = db.transaction('archives', 'readwrite');
    const store = tx.objectStore('archives');
    const now = Date.now();
    for (const item of records) {
      const next = {
        ...item.record,
        status: 'restored',
        restoredAt: now,
        rehydratedMeta: {
          mode: 'core-hot-presence-reconcile',
          pointer: item.pointer,
          wroteMvu: false,
          hotAuthoritative: true,
        },
      };
      store.put(next);
    }
    await txDone(tx);
    return records.length;
  } finally {
    db.close();
  }
}

async function reconcileCurrentState() {
  if (reconciling) return { changed: 0, pointers: [] };
  reconciling = true;
  try {
    const vab = getVab();
    const state = vab?.getState?.() || null;
    const statData = state?.latestMvu?.statData || null;
    const scopeKey = String(state?.current?.scopeKey || '');
    const archives = (state?.archiveCache || []).filter(r => r?.status === 'archived');
    const matches = selectHotArchiveMatches({ archives, statData, scopeKey });

    if (!matches.length) {
      lastClosed = [];
      return { changed: 0, pointers: [] };
    }

    const changed = await closeRecords(matches);
    lastClosed = matches.map(x => x.pointer);
    lastError = '';
    return { changed, pointers: [...lastClosed] };
  } catch (error) {
    lastError = String(error?.message || error);
    console.warn('[VAB Hot Archive Reconcile]', error);
    return { changed: 0, pointers: [], error: lastError };
  } finally {
    reconciling = false;
  }
}

function install() {
  if (installed) return true;
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) return false;

  const originalRefresh = vab.refreshCurrent.bind(vab);
  vab.refreshCurrent = async function wrappedRefresh(options = {}) {
    const result = await originalRefresh(options);
    const reconcile = await reconcileCurrentState();
    if (reconcile.changed > 0) {
      // Reload archiveCache immediately so callers and UI see the restored record disappear now,
      // not on some later event or timer.
      return await originalRefresh(options);
    }
    return result;
  };

  installed = true;
  return true;
}

function installSoon() {
  if (install()) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (install() || tries >= 20) clearInterval(timer);
  }, 250);
}

installSoon();

window.VariableArchiveBridgeHotArchiveReconcile = {
  reconcile: reconcileCurrentState,
  getStatus: () => ({ installed, reconciling, lastClosed: [...lastClosed], lastError }),
};
