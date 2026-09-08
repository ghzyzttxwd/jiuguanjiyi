function unescapePointerSegment(s) {
  return String(s).replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapePointerSegment(s) {
  return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parsePointer(path) {
  if (path === '' || path === '/') return [];
  if (typeof path !== 'string' || !path.startsWith('/')) return [];
  return path.slice(1).split('/').map(unescapePointerSegment);
}

export function getByPointer(root, path) {
  let cur = root;
  for (const key of parsePointer(path)) {
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function recordPointer(record) {
  if (!record) return '';
  if (record.pointer && String(record.pointer).startsWith('/')) return String(record.pointer);
  const base = String(record.sourcePath || '').replace(/\/$/, '');
  const child = escapePointerSegment(record.childKey || '');
  return base && child ? `${base}/${child}` : '';
}

export function selectHotArchiveMatches({ archives = [], statData = null, scopeKey = '' } = {}) {
  if (!statData || typeof statData !== 'object' || !scopeKey) return [];
  const matches = [];
  for (const record of archives || []) {
    if (!record || record.status !== 'archived') continue;
    if (String(record.scopeKey || '') !== String(scopeKey)) continue;
    const pointer = recordPointer(record);
    if (!pointer) continue;
    if (getByPointer(statData, pointer) === undefined) continue;
    matches.push({ record, pointer });
  }
  return matches;
}
