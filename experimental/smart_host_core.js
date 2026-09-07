export const DEFAULT_SMART_HOST_SETTINGS = Object.freeze({
  minMessagesBeforeArchive: 60,
  minIdleMessages: 40,
  minChildren: 30,
  targetChildren: 20,
  minContainerBytes: 12 * 1024,
  maxDepth: 4,
  minObjectRatio: 0.7,
  maxScalarRatio: 0.25,
  recentMentionMessages: 8,
});

export function escapePointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerSegment(value) {
  return String(value).replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(path) {
  if (!path || path === '/') return [];
  return String(path).split('/').slice(1).map(unescapePointerSegment);
}

export function getByPointer(root, path) {
  let cur = root;
  for (const seg of parsePointer(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function byteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export function stableHash(value) {
  let s;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function isProtectedPath(path) {
  const segments = parsePointer(path).map(x => String(x).toLowerCase());
  const protectedWords = [
    '当前', 'current', '状态', 'status', '元信息', 'metadata', '身份', 'identity',
    '任务', 'task', '主线', 'mainquest', '系统', 'system', '临时', 'temporary',
  ];
  return segments.some(seg => protectedWords.some(word =>
    seg === word || seg.startsWith(word) || seg.endsWith(word) || seg.startsWith(`${word}_`) || seg.endsWith(`_${word}`)
  ));
}

export function discoverContainers(statData, settings = {}) {
  const cfg = { ...DEFAULT_SMART_HOST_SETTINGS, ...settings };
  if (!statData || typeof statData !== 'object' || Array.isArray(statData)) return [];

  const out = [];
  const seen = new WeakSet();

  function walk(node, segments, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node) || depth > cfg.maxDepth) return;
    seen.add(node);
    const entries = Object.entries(node);

    if (segments.length && entries.length >= 3) {
      const objectCount = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).length;
      const scalarCount = entries.filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)).length;
      const objectRatio = objectCount / entries.length;
      const scalarRatio = scalarCount / entries.length;
      const path = '/' + segments.map(escapePointerSegment).join('/');
      const size = byteSize(node);

      if (!isProtectedPath(path) && objectRatio >= cfg.minObjectRatio && scalarRatio <= cfg.maxScalarRatio) {
        out.push({ path, node, entries, size, count: entries.length, objectRatio, scalarRatio });
      }
    }

    if (depth >= cfg.maxDepth) return;
    for (const [key, value] of entries) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, [...segments, key], depth + 1);
      }
    }
  }

  walk(statData, [], 0);
  return out.sort((a, b) => b.size - a.size || b.count - a.count);
}

export function textMentionsKey(text, key) {
  const hay = String(text || '');
  const needle = String(key || '').trim();
  if (needle.length < 2) return false;
  return hay.includes(needle);
}

export function effectiveMinChildren(container, settings = {}) {
  const cfg = { ...DEFAULT_SMART_HOST_SETTINGS, ...settings };
  const count = Math.max(1, Number(container?.count || container?.entries?.length || 1));
  const size = Math.max(0, Number(container?.size || 0));
  const avg = size / count;
  let limit = Math.max(5, Number(cfg.minChildren) || 30);

  if (avg >= 8 * 1024) limit = Math.min(limit, 6);
  else if (avg >= 4 * 1024) limit = Math.min(limit, 8);
  else if (avg >= 2 * 1024) limit = Math.min(limit, 12);
  else if (avg >= 1024) limit = Math.min(limit, 18);
  else if (avg >= 512) limit = Math.min(limit, 24);

  if (size >= cfg.minContainerBytes * 4) limit = Math.min(limit, 5);
  else if (size >= cfg.minContainerBytes * 2) limit = Math.min(limit, 8);

  return Math.max(5, limit);
}

export function selectArchiveCandidate({ container, activity = {}, messageCount = 0, recentText = '', settings = {} }) {
  const cfg = { ...DEFAULT_SMART_HOST_SETTINGS, ...settings };
  if (!container) return null;
  if (messageCount < cfg.minMessagesBeforeArchive) return null;

  const effectiveMin = effectiveMinChildren(container, cfg);
  if (container.count <= effectiveMin) return null;
  if (container.size < cfg.minContainerBytes && container.count < effectiveMin * 2) return null;

  const target = Math.max(4, Math.min(cfg.targetChildren, Math.max(4, Math.floor(effectiveMin * 0.75))));
  if (container.count <= target) return null;

  const candidates = container.entries
    .map(([key, value]) => ({
      key,
      size: byteSize(value),
      lastTouched: activity[key]?.lastTouched ?? messageCount,
    }))
    .filter(item => messageCount - item.lastTouched >= cfg.minIdleMessages)
    .filter(item => !textMentionsKey(recentText, item.key))
    .sort((a, b) => a.lastTouched - b.lastTouched || b.size - a.size);

  return candidates[0] || null;
}

export function updateActivity({ containers, prior = {}, messageCount = 0 }) {
  const next = structuredClone(prior || {});
  for (const container of containers || []) {
    const bucket = next[container.path] ||= {};
    const liveKeys = new Set();
    for (const [key, value] of container.entries) {
      liveKeys.add(key);
      const h = stableHash(value);
      if (!bucket[key]) {
        bucket[key] = { hash: h, lastTouched: messageCount };
      } else if (bucket[key].hash !== h) {
        bucket[key] = { hash: h, lastTouched: messageCount };
      }
    }
    for (const key of Object.keys(bucket)) {
      if (!liveKeys.has(key)) delete bucket[key];
    }
  }
  return next;
}

export function simulateFutureArchiveCandidate({
  container,
  messageCount = 0,
  recentText = '',
  settings = {},
  futureMessages = 60,
}) {
  const cfg = { ...DEFAULT_SMART_HOST_SETTINGS, ...settings };
  if (!container?.entries?.length) return null;

  const simulatedCount = Math.max(
    cfg.minMessagesBeforeArchive + 1,
    Number(messageCount || 0) + Math.max(1, Number(futureMessages || 0)),
  );

  const realKeys = new Set(container.entries.map(([key]) => key));
  const virtualEntries = container.entries.map(([key, value]) => [key, value]);
  const effectiveMin = effectiveMinChildren(container, cfg);
  const neededCount = Math.max(effectiveMin + 1, cfg.targetChildren + 1, virtualEntries.length);

  for (let i = virtualEntries.length; i < neededCount; i++) {
    virtualEntries.push([
      `__模拟新增_${i + 1}`,
      { simulationOnly: true },
    ]);
  }

  const virtualContainer = {
    ...container,
    entries: virtualEntries,
    count: virtualEntries.length,
    size: Math.max(container.size || 0, cfg.minContainerBytes + 1),
  };

  const virtualActivity = {};
  for (const [key] of virtualEntries) {
    virtualActivity[key] = {
      hash: 'simulation',
      lastTouched: realKeys.has(key) ? Number(messageCount || 0) : simulatedCount,
    };
  }

  const candidate = selectArchiveCandidate({
    container: virtualContainer,
    activity: virtualActivity,
    messageCount: simulatedCount,
    recentText,
    settings: cfg,
  });

  if (!candidate || !realKeys.has(candidate.key)) return null;
  return {
    candidate,
    virtualCount: virtualContainer.count,
    simulatedMessageCount: simulatedCount,
    effectiveMin,
  };
}
