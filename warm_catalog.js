// Variable Archive Bridge v0.5.0 persistent warm catalog.
// Keeps a lightweight directory for hot MVU entries and cold archives in the existing IndexedDB.
// It NEVER writes MVU and NEVER restores/deletes hot variables.

import { buildCatalogEntries, buildDirectoryContext } from './warm_catalog_core.js';

const VERSION = '0.5.0';
const DB_NAME = 'variable_archive_bridge';
const STORE = 'archives';
const RECORD_TYPE = 'warm-catalog';
const SYNC_MS = 15000;
const WIDGET_ID = 'vab-warm-catalog';

let db = null;
let entries = [];
let lastError = '';
let syncing = false;
let lastSignature = '';
let timer = null;
let macroRegistered = false;
let queuedSync = null;

function core() {
  try { return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null; }
  catch { return null; }
}

function governor() {
  try { return window.VariableArchiveBridgeHotStateGovernor || window.parent?.VariableArchiveBridgeHotStateGovernor || null; }
  catch { return null; }
}

function ctx() {
  try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
  catch { return null; }
}

function recentUserText() {
  try {
    const chat = ctx()?.chat || [];
    return chat.filter(m => m?.is_user).slice(-2).map(m => String(m?.mes || '')).join('\n');
  } catch {
    return '';
  }
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function ensureDb() {
  if (db) return db;
  const c = core();
  if (!c?.getState?.()?.db) return null; // never create an empty DB before the core has initialized its schema
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!db.objectStoreNames.contains(STORE)) {
    db.close();
    db = null;
    return null;
  }
  return db;
}

async function readScopeRecords(scopeKey) {
  const d = await ensureDb();
  if (!d || !scopeKey) return [];
  const tx = d.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  if (store.indexNames.contains('scopeKey')) return await reqPromise(store.index('scopeKey').getAll(scopeKey));
  const all = await reqPromise(store.getAll());
  return all.filter(x => x?.scopeKey === scopeKey);
}

function signatureOf(rows) {
  return rows.map(x => `${x.id}|${x.temperature}|${x.coolingCandidate ? 1 : 0}|${x.summary}`).join('\n');
}

async function persistCatalog(scopeKey, desired, existingScopeRecords) {
  const d = await ensureDb();
  if (!d) return;
  const old = (existingScopeRecords || []).filter(x => x?.recordType === RECORD_TYPE);
  const wanted = new Map(desired.map(x => [x.id, x]));
  const tx = d.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const now = Date.now();
  for (const row of desired) store.put({ ...row, catalogUpdatedAt: now });
  for (const row of old) if (!wanted.has(row.id)) store.delete(row.id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('温索引事务中止'));
  });
}

function ensureWidget() {
  if (document.getElementById(WIDGET_ID)) return true;
  const content = document.querySelector('#vab-settings .inline-drawer-content');
  if (!content) return false;
  const wrap = document.createElement('div');
  wrap.id = WIDGET_ID;
  wrap.style.cssText = 'margin:8px 0 12px;padding:9px 10px;border:1px solid var(--SmartThemeBorderColor,#888);border-radius:10px;';
  wrap.innerHTML = '<b>📇 温索引库</b><div class="vab-warm-catalog-status" style="opacity:.8;margin-top:4px;">等待同步…</div>';
  const updater = document.getElementById('vab-self-update');
  if (updater?.parentNode === content) updater.insertAdjacentElement('afterend', wrap);
  else content.prepend(wrap);
  return true;
}

function render() {
  ensureWidget();
  const node = document.querySelector(`#${WIDGET_ID} .vab-warm-catalog-status`);
  if (!node) return;
  if (lastError) {
    node.textContent = `同步失败：${lastError}`;
    return;
  }
  const hot = entries.filter(x => x.temperature === 'hot').length;
  const cold = entries.filter(x => x.temperature === 'cold').length;
  const cooling = entries.filter(x => x.coolingCandidate).length;
  node.textContent = `${entries.length} 项 · 热区 ${hot} · 冷档案 ${cold}${cooling ? ` · 降温候选 ${cooling}` : ''}`;
}

export async function syncCatalog() {
  if (syncing) return entries;
  syncing = true;
  try {
    const c = core();
    if (!c?.refreshCurrent || !c?.getState) throw new Error('变量归档桥核心尚未就绪');
    await c.refreshCurrent({ render: false });
    let state = c.getState();
    if (!state?.current?.scopeKey) throw new Error('当前没有变量卡聊天作用域');

    const g = governor();
    if (state?.latestMvu?.statData && g?.refresh) {
      await g.refresh();
      state = c.getState();
    }

    const report = g?.getReport?.() || null;
    const preview = g?.getPreview?.() || null;
    const scopeKey = state.current.scopeKey;
    const scopeLabel = state.current.scopeLabel || '';
    const allScopeRecords = await readScopeRecords(scopeKey);
    const archives = allScopeRecords.filter(x => x?.status === 'archived' && x?.recordType !== RECORD_TYPE);

    const desired = buildCatalogEntries({
      statData: state?.latestMvu?.statData || {},
      report,
      preview,
      archives,
      scopeKey,
      scopeLabel,
    });

    const sig = signatureOf(desired);
    if (sig !== lastSignature) {
      await persistCatalog(scopeKey, desired, allScopeRecords);
      lastSignature = sig;
    }
    entries = desired;
    lastError = '';
    render();
    return entries;
  } catch (error) {
    lastError = String(error?.message || error);
    render();
    return entries;
  } finally {
    syncing = false;
  }
}

function queueSync(delay = 250) {
  if (queuedSync) clearTimeout(queuedSync);
  queuedSync = setTimeout(() => {
    queuedSync = null;
    syncCatalog().catch(() => {});
  }, delay);
}

function registerCatalogMacro() {
  if (macroRegistered) return;
  const c = ctx();
  if (!c) return;
  const handler = () => buildDirectoryContext(entries, recentUserText());
  try {
    if (c.macros?.register) {
      c.macros.register('varArchiveCatalog', {
        description: '变量归档桥轻量目录：用于“有哪些/会哪些/认识哪些”等目录查询。',
        handler,
      });
      macroRegistered = true;
      return;
    }
    if (typeof c.registerMacro === 'function') {
      c.registerMacro('varArchiveCatalog', handler, '变量归档桥轻量目录');
      macroRegistered = true;
    }
  } catch {
    // Hot reload may leave the same macro registered. Storage remains usable.
    macroRegistered = true;
  }
}

function start() {
  ensureWidget();
  setTimeout(() => {
    registerCatalogMacro();
    syncCatalog();
  }, 2500);
  if (!timer) timer = setInterval(() => syncCatalog(), SYNC_MS);
  window.addEventListener('focus', () => queueSync(200));
  window.addEventListener('online', () => queueSync(300));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) queueSync(200); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeWarmCatalog = {
  VERSION,
  sync: syncCatalog,
  getEntries: () => entries.map(x => ({ ...x, tags: [...(x.tags || [])] })),
  buildContext: query => buildDirectoryContext(entries, String(query || '')),
  buildContextFromRecent: () => buildDirectoryContext(entries, recentUserText()),
  getStatus: () => ({ syncing, lastError, count: entries.length, hot: entries.filter(x => x.temperature === 'hot').length, cold: entries.filter(x => x.temperature === 'cold').length, readOnlyMvu: true }),
};
