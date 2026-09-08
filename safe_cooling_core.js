// Variable Archive Bridge v0.6.0 safe cooling pure logic.
// Selects one low-heat governor candidate and validates pre/post migration state.
// No browser APIs and no MVU writes in this file.

function escPtr(value) {
  return String(value ?? '').replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointerOf(sourcePath, key) {
  const base = String(sourcePath || '/').replace(/\/$/, '');
  return `${base}/${escPtr(key)}`;
}

export function getByPointer(root, path) {
  if (!root || typeof path !== 'string' || !path.startsWith('/')) return undefined;
  const keys = path.slice(1).split('/').filter(Boolean).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function pressure(row) {
  const count = Math.max(0, Number(row?.count) || 0);
  const soft = Math.max(0, Number(row?.softLimit) || 0);
  const hard = Math.max(soft, Number(row?.hardLimit) || soft);
  return {
    hardExceeded: Math.max(0, count - hard),
    softExceeded: Math.max(0, count - soft),
    count,
  };
}

export function selectNextCoolingCandidate(preview) {
  const rows = Array.isArray(preview?.collections) ? preview.collections : [];
  const pool = [];
  for (const row of rows) {
    const cooling = Array.isArray(row?.cooling) ? row.cooling : [];
    if (!cooling.length) continue;
    const p = pressure(row);
    for (const item of cooling) {
      if (!item || item.protectedNode) continue;
      pool.push({
        sourcePath: String(row.path || ''),
        key: String(item.key ?? ''),
        label: String(row.label || ''),
        heatScore: Number(item.score) || 0,
        bytes: Math.max(0, Number(item.bytes) || 0),
        reasons: Array.isArray(item.reasons) ? [...item.reasons] : [],
        ageMessages: Number.isFinite(Number(item.ageMessages)) ? Math.max(0, Number(item.ageMessages)) : null,
        hardExceeded: p.hardExceeded,
        softExceeded: p.softExceeded,
        collectionCount: p.count,
      });
    }
  }
  if (!pool.length) return null;

  // Hard overflow first, then larger soft overflow; within the same pressure,
  // move the coldest/oldest candidate first. Large low-heat entries win ties.
  pool.sort((a, b) =>
    b.hardExceeded - a.hardExceeded ||
    b.softExceeded - a.softExceeded ||
    a.heatScore - b.heatScore ||
    (b.ageMessages ?? -1) - (a.ageMessages ?? -1) ||
    b.bytes - a.bytes ||
    a.sourcePath.localeCompare(b.sourcePath, 'zh-CN') ||
    a.key.localeCompare(b.key, 'zh-CN'));

  const chosen = pool[0];
  return {
    ...chosen,
    pointer: pointerOf(chosen.sourcePath, chosen.key),
  };
}

export function validatePreCooling({ candidate, catalogEntries, statData, scopeKey = '' } = {}) {
  if (!candidate?.sourcePath || candidate.key === undefined || candidate.key === '') {
    return { ok: false, reason: '没有有效降温候选' };
  }
  const pointer = candidate.pointer || pointerOf(candidate.sourcePath, candidate.key);
  if (getByPointer(statData, pointer) === undefined) {
    return { ok: false, reason: '候选已经不在当前热MVU中' };
  }
  const row = (catalogEntries || []).find(x => x?.pointer === pointer && (!scopeKey || x?.scopeKey === scopeKey));
  if (!row) return { ok: false, reason: '温索引尚未落盘该候选' };
  if (row.temperature !== 'hot') return { ok: false, reason: '温索引未标记为热区' };
  if (!row.coolingCandidate) return { ok: false, reason: '温索引未确认该项是降温候选' };
  return { ok: true, pointer, catalogId: row.id };
}

export function validatePostCooling({ candidate, catalogEntries, statData, scopeKey = '', archiveResult = null } = {}) {
  if (!candidate) return { ok: false, reason: '缺少迁移候选' };
  const pointer = candidate.pointer || pointerOf(candidate.sourcePath, candidate.key);
  if (getByPointer(statData, pointer) !== undefined) {
    return { ok: false, reason: '迁移后节点仍存在于热MVU' };
  }
  const row = (catalogEntries || []).find(x => x?.pointer === pointer && (!scopeKey || x?.scopeKey === scopeKey));
  if (!row) return { ok: false, reason: '迁移后温索引缺失' };
  if (row.temperature !== 'cold') return { ok: false, reason: '迁移后温索引没有转为冷档案' };
  if (!row.archiveId) return { ok: false, reason: '迁移后温索引没有冷档案ID' };
  if (archiveResult?.archiveId && row.archiveId !== archiveResult.archiveId) {
    return { ok: false, reason: '温索引与冷档案ID不一致' };
  }
  return { ok: true, pointer, archiveId: row.archiveId, catalogId: row.id };
}
