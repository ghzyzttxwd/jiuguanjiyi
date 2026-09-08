import { getByPointer, byteSize } from './hot_state_governor_core.js';

function primitiveText(node) {
  if (node == null) return '';
  if (['string', 'number', 'boolean'].includes(typeof node)) return String(node);
  if (Array.isArray(node)) return node.slice(0, 4).map(primitiveText).join(' ');
  if (typeof node !== 'object') return '';
  const preferred = ['名称','姓名','标题','类型','类别','境界','等级','状态','当前状态','关系','身份','来源','世界','地点','是否同行','主修','装备状态'];
  const parts = [];
  for (const key of preferred) {
    if (key in node && node[key] != null && typeof node[key] !== 'object') parts.push(`${key}:${node[key]}`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (parts.length >= 8) break;
    if (preferred.includes(key)) continue;
    if (value == null || typeof value === 'object') continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text && text.length <= 80) parts.push(`${key}:${text}`);
  }
  return parts.join('；');
}

function shortSummary(key, node) {
  const body = primitiveText(node);
  const text = body ? `${key}｜${body}` : String(key);
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

function isProtectedNode(node) {
  if (!node || typeof node !== 'object') return false;
  const directTrueKeys = ['是否同行','当前同行','是否主修','主修','当前装备','已装备','装备中','激活','当前激活','正在使用','进行中','当前任务'];
  for (const key of directTrueKeys) if (node[key] === true) return true;
  const joined = Object.entries(node)
    .filter(([,v]) => v == null || typeof v !== 'object')
    .map(([k,v]) => `${k}:${String(v)}`)
    .join(' ');
  return /(当前主修|主修中|同行中|当前同行|进行中|执行中|装备中|已装备|激活中|战斗中|当前任务|未完成)/.test(joined);
}

function touchAge(touch, messageCount) {
  if (!touch || !Number.isFinite(Number(touch.lastChanged))) return null;
  return Math.max(0, Number(messageCount || 0) - Number(touch.lastChanged));
}

function scoreItem({ key, node, index, total, recentText, touch, messageCount }) {
  let score = 1;
  const reasons = [];
  const protectedNode = isProtectedNode(node);
  if (protectedNode) {
    score += 10000;
    reasons.push('当前/主修/同行/进行中保护');
  }

  const haystack = `${key} ${primitiveText(node)}`.toLowerCase();
  const recent = String(recentText || '').toLowerCase();
  if (String(key).length >= 2 && recent.includes(String(key).toLowerCase())) {
    score += 120;
    reasons.push('最近对话直接提及');
  } else {
    const tokens = haystack.split(/[\s,，。；;：:|｜/\\\[\]{}()（）<>《》"'`]+/).filter(x => x.length >= 2 && x.length <= 24);
    if (tokens.some(token => recent.includes(token))) {
      score += 35;
      reasons.push('最近对话相关');
    }
  }

  const age = touchAge(touch, messageCount);
  if (age !== null) {
    if (age <= 1) { score += 80; reasons.push('刚发生变量变化'); }
    else if (age <= 3) { score += 60; reasons.push('近期变量变化'); }
    else if (age <= 8) { score += 40; reasons.push('较近期变量变化'); }
    else if (age <= 16) { score += 20; reasons.push('仍较新'); }
  }

  const fromEnd = Math.max(0, total - 1 - index);
  if (fromEnd <= 1) { score += 15; reasons.push('最近加入'); }
  else if (fromEnd <= 4) { score += 8; reasons.push('较新加入'); }

  return { score, reasons, protectedNode };
}

function entriesOf(value) {
  if (Array.isArray(value)) return value.map((node, i) => [String(i), node]);
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

export function buildCoolingPreview(statData, analysis, {
  recentText = '',
  touchMap = {},
  messageCount = 0,
} = {}) {
  const collections = [];
  const warmIndex = [];
  let estimatedCoolingBytes = 0;
  let candidateCount = 0;

  for (const row of analysis?.collections || []) {
    const container = getByPointer(statData, row.path);
    const entries = entriesOf(container);
    const scored = entries.map(([key, node], index) => {
      const heat = scoreItem({
        key,
        node,
        index,
        total: entries.length,
        recentText,
        touch: touchMap?.[row.path]?.[key],
        messageCount,
      });
      return {
        key,
        node,
        bytes: byteSize(node),
        summary: shortSummary(key, node),
        ...heat,
      };
    }).sort((a, b) => b.score - a.score || b.bytes - a.bytes || String(a.key).localeCompare(String(b.key)));

    const keepTarget = Math.max(0, Number(row.softLimit) || 0);
    const protectedItems = scored.filter(x => x.protectedNode);
    const ordinary = scored.filter(x => !x.protectedNode);
    const keepOrdinaryCount = Math.max(0, keepTarget - protectedItems.length);
    const keepKeys = new Set([
      ...protectedItems.map(x => x.key),
      ...ordinary.slice(0, keepOrdinaryCount).map(x => x.key),
    ]);
    const cooling = entries.length > keepTarget ? scored.filter(x => !keepKeys.has(x.key)) : [];
    const coolingBytes = cooling.reduce((sum, item) => sum + item.bytes, 0);

    if (cooling.length) {
      candidateCount += cooling.length;
      estimatedCoolingBytes += coolingBytes;
      for (const item of cooling) {
        warmIndex.push({
          sourcePath: row.path,
          key: item.key,
          label: row.label,
          summary: item.summary,
          bytes: item.bytes,
          heatScore: item.score,
          reasons: item.reasons,
        });
      }
    }

    collections.push({
      path: row.path,
      label: row.label,
      count: entries.length,
      softLimit: row.softLimit,
      hardLimit: row.hardLimit,
      kept: scored.filter(x => keepKeys.has(x.key)),
      cooling,
      coolingBytes,
    });
  }

  const histories = [];
  let historyCandidateCount = 0;
  let historyCoolingBytes = 0;
  for (const row of analysis?.histories || []) {
    const container = getByPointer(statData, row.containerPath);
    const owner = container?.[row.ownerKey];
    const arr = getByPointer(owner, row.fieldPath);
    if (!Array.isArray(arr)) continue;
    const excess = Math.max(0, arr.length - Number(row.softLimit || 0));
    if (!excess) continue;
    const oldItems = arr.slice(0, excess);
    const bytes = oldItems.reduce((sum, item) => sum + byteSize(item), 0);
    historyCandidateCount += excess;
    historyCoolingBytes += bytes;
    histories.push({
      containerPath: row.containerPath,
      ownerKey: row.ownerKey,
      fieldPath: row.fieldPath,
      label: row.label,
      count: arr.length,
      keep: row.softLimit,
      candidateCount: excess,
      bytes,
    });
  }

  return {
    readOnly: true,
    collections,
    warmIndex,
    histories,
    summary: {
      candidateCount,
      estimatedCoolingBytes,
      historyCandidateCount,
      historyCoolingBytes,
      totalCandidateCount: candidateCount + historyCandidateCount,
      totalEstimatedBytes: estimatedCoolingBytes + historyCoolingBytes,
    },
  };
}
