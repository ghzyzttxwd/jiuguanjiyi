// Live IO adapter for the experimental rehydration transaction.
// This module is NOT loaded by normal startup. It is only imported through the explicit safety gate.
// All writes are scope-checked and generation-aware.

const DB_NAME = 'variable_archive_bridge';

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function pointerParts(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`非法JSON Pointer：${path}`);
  return path.slice(1).split('/').filter(Boolean).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getByPointer(root, path) {
  let cur = root;
  for (const part of pointerParts(path)) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPointer(root, path, value) {
  const parts = pointerParts(path);
  if (!parts.length) throw new Error('禁止覆盖 stat_data 根节点');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[parts.at(-1)] = clone(value);
}

function jsonEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function getVab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function getMvu() {
  return window.Mvu || window.parent?.Mvu || null;
}

async function generationFlags() {
  let isSendPress = false;
  let isGroupGenerating = false;
  try {
    const script = await import('/script.js');
    isSendPress = !!script?.is_send_press;
  } catch {}
  try {
    const group = await import('/scripts/group-chats.js');
    isGroupGenerating = !!group?.is_group_generating;
  } catch {}
  return { isSendPress, isGroupGenerating, active: isSendPress || isGroupGenerating };
}

export async function isGenerationActive() {
  return (await generationFlags()).active;
}

async function openArchiveDb() {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开VAB IndexedDB'));
  });
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB请求失败'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB事务中止'));
  });
}

async function getArchiveById(recordId) {
  const db = await openArchiveDb();
  try {
    const tx = db.transaction('archives', 'readonly');
    const value = await reqAsPromise(tx.objectStore('archives').get(recordId));
    await txDone(tx);
    return value || null;
  } finally {
    db.close();
  }
}

async function putArchiveRecord(record) {
  const db = await openArchiveDb();
  try {
    const tx = db.transaction('archives', 'readwrite');
    tx.objectStore('archives').put(record);
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function refreshSnapshot() {
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) throw new Error('VariableArchiveBridge核心未就绪');
  await vab.refreshCurrent({ render: false });
  const s = vab.getState();
  const scopeKey = String(s?.current?.scopeKey || '');
  const latest = s?.latestMvu;
  if (!scopeKey) throw new Error('无法确定当前聊天scope');
  if (!latest?.statData || !latest?.variables) throw new Error('当前聊天没有可用MVU stat_data');
  return {
    scopeKey,
    messageId: latest.messageId,
    statData: clone(latest.statData),
    variables: clone(latest.variables),
  };
}

function assertSameScope(actual, expected, phase) {
  if (!actual || actual !== expected) {
    throw new Error(`${phase}：聊天scope已变化，已拒绝写入`);
  }
}

async function ensureNotGenerating(phase) {
  const flags = await generationFlags();
  if (flags.active) throw new Error(`${phase}：当前正在生成消息，禁止重激活写入`);
}

export function createRehydrationLiveIo() {
  return {
    async refresh() {
      return refreshSnapshot();
    },

    async getArchive(recordId, requestedScope) {
      const record = await getArchiveById(recordId);
      if (!record) return null;
      if (String(record.scopeKey || '') !== String(requestedScope || '')) return null;
      return clone(record);
    },

    async saveSnapshot(_before, reason) {
      const vab = getVab();
      if (!vab?.saveSnapshot) throw new Error('VAB快照API不可用');
      return await vab.saveSnapshot(reason || 'before-rehydration-merge');
    },

    async writeMerged(path, merged, fresh) {
      await ensureNotGenerating('写入前');
      const now = await refreshSnapshot();
      assertSameScope(now.scopeKey, fresh.scopeKey, '写入前复核');
      if (Number(now.messageId) !== Number(fresh.messageId)) {
        throw new Error('写入前最新MVU楼层已变化，放弃本次写入');
      }
      const currentHot = getByPointer(now.statData, path);
      const expectedHot = getByPointer(fresh.statData, path);
      if (!jsonEqual(currentHot, expectedHot)) {
        throw new Error('写入前目标热节点发生变化，检测到竞态，放弃本次写入');
      }

      const mvu = getMvu();
      if (!mvu?.replaceMvuData) throw new Error('Mvu.replaceMvuData不可用');
      const vars = clone(now.variables);
      const stat = clone(now.statData);
      setByPointer(stat, path, merged);
      vars.stat_data = stat;
      await mvu.replaceMvuData(vars, { type: 'message', message_id: now.messageId });
    },

    async readHot(path, snapshot) {
      return clone(getByPointer(snapshot?.statData, path));
    },

    async markRestored(record, meta) {
      await ensureNotGenerating('提交冷档案状态前');
      const now = await refreshSnapshot();
      assertSameScope(now.scopeKey, record.scopeKey, '冷档案状态提交');

      const latestRecord = await getArchiveById(record.id);
      if (!latestRecord) throw new Error('提交时冷档案已不存在');
      if (String(latestRecord.scopeKey || '') !== now.scopeKey) throw new Error('冷档案scope不匹配');
      if (latestRecord.status !== 'archived') throw new Error(`冷档案状态已变化：${latestRecord.status}`);

      latestRecord.status = 'restored';
      latestRecord.restoredAt = Date.now();
      latestRecord.rehydratedMeta = clone(meta || {});
      await putArchiveRecord(latestRecord);
      try { await getVab()?.refreshCurrent?.({ render: false }); } catch {}
    },

    async rollback(_snapshot, beforeWrite) {
      const now = await refreshSnapshot();
      assertSameScope(now.scopeKey, beforeWrite.scopeKey, '回滚');
      if (Number(now.messageId) !== Number(beforeWrite.messageId)) {
        throw new Error('回滚时最新MVU楼层已变化，禁止向旧楼层盲写');
      }

      const mvu = getMvu();
      if (!mvu?.replaceMvuData) throw new Error('回滚时Mvu.replaceMvuData不可用');
      const vars = clone(now.variables);
      vars.stat_data = clone(beforeWrite.statData);
      await mvu.replaceMvuData(vars, { type: 'message', message_id: now.messageId });
    },
  };
}

export const RehydrationLiveAdapterDiagnostics = {
  refreshSnapshot,
  getArchiveById,
  generationFlags,
};
