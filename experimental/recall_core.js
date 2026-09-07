import { getByPointer } from './smart_host_core.js';

export const DEFAULT_RECALL_SETTINGS = Object.freeze({
  maxRecords: 6,
  maxChars: 9000,
  maxRecordChars: 2600,
  minScore: 120,
  includePinnedWithoutMatch: true,
  skipMirrored: false,
});

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function isRecordHot(record, statData) {
  if (!record || !statData) return false;
  const pointer = record.pointer || (record.sourcePath && record.childKey
    ? `${String(record.sourcePath).replace(/\/$/, '')}/${String(record.childKey).replace(/~/g, '~0').replace(/\//g, '~1')}`
    : '');
  if (!pointer) return false;
  return getByPointer(statData, pointer) !== undefined;
}

export function querySignals(queryText) {
  const text = normalize(queryText);
  const chunks = unique(
    text
      .split(/[\s,，。.!！?？;；:：、()（）\[\]【】{}<>《》"“”'‘’]+/)
      .map(x => x.trim())
      .filter(x => x.length >= 2)
  );
  return { text, chunks };
}

function pathSegments(path) {
  return String(path || '')
    .split('/')
    .map(normalize)
    .filter(x => x.length >= 2);
}

export function scoreArchiveRecord(record, queryText, options = {}) {
  const cfg = { ...DEFAULT_RECALL_SETTINGS, ...options };
  if (!record || record.status !== 'archived') return { score: -Infinity, reasons: ['非冷归档'] };
  if (cfg.statData && isRecordHot(record, cfg.statData)) return { score: -Infinity, reasons: ['同节点已在热变量'] };
  if (cfg.skipMirrored && record.mirroredToMemory) return { score: -Infinity, reasons: ['已由记忆表镜像托管'] };

  const { text, chunks } = querySignals(queryText);
  const childKey = normalize(record.childKey);
  const summary = normalize(record.summary);
  const tags = unique((record.tags || []).map(normalize).filter(x => x.length >= 2));
  const paths = pathSegments(record.sourcePath);

  let score = 0;
  const reasons = [];
  let matched = false;

  if (childKey.length >= 2 && text.includes(childKey)) {
    score += 1400;
    reasons.push(`命中名称:${record.childKey}`);
    matched = true;
  }

  let tagHits = 0;
  for (const tag of tags) {
    if (!text.includes(tag)) continue;
    tagHits++;
    score += Math.min(450, 180 + tag.length * 12);
    matched = true;
  }
  if (tagHits) reasons.push(`命中标签×${tagHits}`);

  let pathHits = 0;
  for (const segment of paths) {
    if (!text.includes(segment)) continue;
    pathHits++;
    score += 70;
  }
  if (pathHits) {
    reasons.push(`命中路径×${pathHits}`);
    matched = true;
  }

  // Weak semantic-ish fallback without embeddings: only reward query chunks that are
  // genuinely present in the short archive summary. This never outweighs a name hit.
  let summaryHits = 0;
  for (const chunk of chunks.slice(0, 24)) {
    if (chunk.length < 2 || !summary.includes(chunk)) continue;
    summaryHits++;
    score += Math.min(80, 15 + chunk.length * 5);
  }
  if (summaryHits) {
    reasons.push(`命中摘要×${summaryHits}`);
    matched = true;
  }

  if (record.pinned && (matched || cfg.includePinnedWithoutMatch)) {
    score += matched ? 260 : 150;
    reasons.push('置顶档案');
  }

  if (!matched && !record.pinned) return { score: 0, reasons: [] };
  if (!matched && record.pinned && !cfg.includePinnedWithoutMatch) return { score: 0, reasons: [] };

  // Small tie-breakers only; relevance dominates.
  const archivedAt = Number(record.archivedAt) || 0;
  if (archivedAt > 0) score += Math.min(20, Math.max(0, archivedAt / 1e15));
  if (record.size && Number(record.size) < 4000) score += 5;

  return { score, reasons, matched };
}

export function selectRecallRecords({ archives = [], statData = null, queryText = '', settings = {} } = {}) {
  const cfg = { ...DEFAULT_RECALL_SETTINGS, ...settings };
  const seen = new Set();
  const ranked = [];

  for (const record of archives || []) {
    const identity = record?.pointer || `${record?.sourcePath || ''}/${record?.childKey || ''}`;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);

    const result = scoreArchiveRecord(record, queryText, {
      ...cfg,
      statData,
    });
    if (!Number.isFinite(result.score) || result.score < cfg.minScore) continue;
    ranked.push({ record, score: result.score, reasons: result.reasons });
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    Number(b.record?.pinned || 0) - Number(a.record?.pinned || 0) ||
    Number(b.record?.archivedAt || 0) - Number(a.record?.archivedAt || 0)
  );

  return ranked.slice(0, Math.max(1, Number(cfg.maxRecords) || 6));
}

function clipJson(value, maxChars) {
  let text;
  try { text = JSON.stringify(value); }
  catch { text = String(value ?? ''); }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}…[本条已截断]`;
}

export function formatRecallContext(ranked, settings = {}) {
  const cfg = { ...DEFAULT_RECALL_SETTINGS, ...settings };
  if (!ranked?.length) return '';

  const cap = Math.max(1000, Number(cfg.maxChars) || 9000);
  const perRecord = Math.max(500, Number(cfg.maxRecordChars) || 2600);
  const pieces = [];
  let used = 0;

  const header = '<variable_cold_archive_recall>\n以下内容来自当前聊天的冷变量档案，仅用于恢复相关旧事实。若与当前MVU/stat_data或最新剧情冲突，以当前热变量和最新剧情为准。不要把“冷档案”本身当作世界内概念。\n';
  used += header.length;

  for (const item of ranked) {
    const r = item.record;
    const path = r.pointer || `${r.sourcePath || ''}/${r.childKey || ''}`;
    const prefix = [
      `名称: ${r.childKey || '未命名'}`,
      `原变量: ${path}`,
      r.summary ? `摘要: ${r.summary}` : '',
      item.reasons?.length ? `召回原因: ${item.reasons.join('、')}` : '',
      '数据:',
    ].filter(Boolean).join('\n');
    const budget = Math.max(300, perRecord - prefix.length - 20);
    const data = clipJson(r.data, budget);
    const piece = `${prefix}\n${data}`;
    if (used + piece.length + 20 > cap) continue;
    pieces.push(piece);
    used += piece.length + 20;
    if (pieces.length >= cfg.maxRecords) break;
  }

  if (!pieces.length) return '';
  return `${header}\n${pieces.map((p, i) => `[召回档案${i + 1}]\n${p}`).join('\n\n')}\n</variable_cold_archive_recall>`;
}

export function buildRecallContext({ archives = [], statData = null, queryText = '', settings = {} } = {}) {
  const ranked = selectRecallRecords({ archives, statData, queryText, settings });
  const text = formatRecallContext(ranked, settings);
  return {
    ranked,
    text,
    chars: text.length,
  };
}
