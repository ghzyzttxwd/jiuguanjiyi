export const DEFAULT_DELIVERY_SETTINGS = Object.freeze({
  macroName: 'varArchiveContext',
  maxScanDepth: 5,
  maxScanNodes: 5000,
  maxScanChars: 180000,
});

function normalize(value) {
  return String(value ?? '').trim();
}

function identityOf(record) {
  if (!record) return '';
  if (record.pointer) return String(record.pointer);
  if (record.sourcePath || record.childKey) {
    return `${String(record.sourcePath || '').replace(/\/$/, '')}/${String(record.childKey || '')}`;
  }
  return String(record.id || '');
}

export function collectPromptStrings(sources = [], settings = {}) {
  const cfg = { ...DEFAULT_DELIVERY_SETTINGS, ...settings };
  const out = [];
  const seen = new WeakSet();
  let nodes = 0;
  let chars = 0;
  let truncated = false;

  function push(source, path, value) {
    if (chars >= cfg.maxScanChars) {
      truncated = true;
      return;
    }
    const text = String(value ?? '');
    if (!text) return;
    const remaining = Math.max(0, cfg.maxScanChars - chars);
    const clipped = text.slice(0, remaining);
    out.push({ source, path, text: clipped });
    chars += clipped.length;
    if (clipped.length < text.length) truncated = true;
  }

  function walk(source, value, path, depth) {
    if (nodes >= cfg.maxScanNodes || chars >= cfg.maxScanChars) {
      truncated = true;
      return;
    }
    nodes++;
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      push(source, path, value);
      return;
    }
    if (typeof value !== 'object' || depth >= cfg.maxScanDepth) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(source, value[i], `${path}[${i}]`, depth + 1);
        if (nodes >= cfg.maxScanNodes || chars >= cfg.maxScanChars) break;
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      walk(source, child, path ? `${path}.${key}` : key, depth + 1);
      if (nodes >= cfg.maxScanNodes || chars >= cfg.maxScanChars) break;
    }
  }

  for (const item of sources || []) {
    if (!item) continue;
    const source = normalize(item.name || item.source || 'unknown');
    walk(source, item.value, '', 0);
    if (nodes >= cfg.maxScanNodes || chars >= cfg.maxScanChars) break;
  }

  return { strings: out, nodes, chars, truncated };
}

export function detectMacroPlacement(sources = [], settings = {}) {
  const cfg = { ...DEFAULT_DELIVERY_SETTINGS, ...settings };
  const macroName = normalize(cfg.macroName) || 'varArchiveContext';
  const strongPattern = new RegExp(`\\{\\{\\s*${macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'i');
  const weakPattern = new RegExp(macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const scan = collectPromptStrings(sources, cfg);
  const strong = [];
  const weak = [];

  for (const item of scan.strings) {
    if (strongPattern.test(item.text)) {
      strong.push({ source: item.source, path: item.path });
    } else if (weakPattern.test(item.text)) {
      weak.push({ source: item.source, path: item.path });
    }
  }

  return {
    confidence: strong.length ? 'strong' : weak.length ? 'weak' : 'none',
    found: strong.length > 0,
    strong,
    weak,
    scannedNodes: scan.nodes,
    scannedChars: scan.chars,
    truncated: scan.truncated,
  };
}

export function findLegacyOverlap(ranked = [], legacyText = '') {
  const text = String(legacyText || '');
  if (!text) return [];
  const out = [];
  const seen = new Set();

  for (const item of ranked || []) {
    const record = item?.record || item;
    if (!record) continue;
    const id = identityOf(record);
    if (!id || seen.has(id)) continue;
    const childKey = normalize(record.childKey);
    const pointer = normalize(record.pointer || id);
    const sourcePath = normalize(record.sourcePath);
    const byName = childKey.length >= 2 && text.includes(childKey);
    const byPointer = pointer.length >= 2 && text.includes(pointer);
    const byPathAndName = sourcePath && childKey && text.includes(sourcePath) && text.includes(childKey);
    if (byName || byPointer || byPathAndName) {
      seen.add(id);
      out.push({ identity: id, childKey, byName, byPointer, byPathAndName });
    }
  }
  return out;
}

export function detectPromptKeyCollision({ existingValue = '', lastOwnedValue = '', signature = '<variable_cold_archive_recall>' } = {}) {
  const existing = String(existingValue || '');
  if (!existing) return { collision: false, reason: 'empty' };
  if (lastOwnedValue && existing === String(lastOwnedValue)) return { collision: false, reason: 'owned-exact' };
  if (signature && existing.includes(signature)) return { collision: false, reason: 'owned-signature' };
  return { collision: true, reason: 'foreign-nonempty' };
}

export function analyzeRecallDelivery({
  ranked = [],
  legacyMacroEnabled = false,
  legacyMacroText = '',
  macroPlacement = { confidence: 'none' },
  memoryActive = false,
  skippedMirroredCount = 0,
  promptCollision = false,
} = {}) {
  const overlap = findLegacyOverlap(ranked, legacyMacroText);
  const reasons = [];
  let mode = 'auto-prompt';

  if (promptCollision) {
    mode = 'blocked-collision';
    reasons.push('vab_cold_recall Prompt Key 已被其他内容占用');
  } else if (legacyMacroEnabled && macroPlacement?.confidence === 'strong' && String(legacyMacroText || '').trim()) {
    mode = 'legacy-macro';
    reasons.push('检测到 {{varArchiveContext}} 已实际放入当前Prompt来源，自动召回让路给旧宏以避免双重注入');
  } else {
    reasons.push('自动Prompt通道可用');
  }

  if (legacyMacroEnabled && macroPlacement?.confidence === 'weak') {
    reasons.push('检测到 varArchiveContext 字样但未确认宏占位符，保持自动通道并标记弱冲突');
  }
  if (memoryActive && skippedMirroredCount > 0) {
    reasons.push(`记忆增强已接管 ${skippedMirroredCount} 条镜像档案，自动召回已排除这些记录`);
  }
  if (overlap.length) reasons.push(`与旧宏候选重合 ${overlap.length} 条`);

  return {
    mode,
    shouldInject: mode === 'auto-prompt',
    overlap,
    overlapCount: overlap.length,
    macroConfidence: macroPlacement?.confidence || 'none',
    memoryActive: !!memoryActive,
    skippedMirroredCount: Number(skippedMirroredCount) || 0,
    promptCollision: !!promptCollision,
    reasons,
  };
}

export function summarizeDeliveryDecision(decision = {}) {
  const modeLabel = {
    'auto-prompt': '自动Prompt召回',
    'legacy-macro': '沿用 {{varArchiveContext}} 宏',
    'blocked-collision': 'Prompt Key 冲突，已阻止注入',
  }[decision.mode] || String(decision.mode || '未知');
  const details = [modeLabel, ...(decision.reasons || [])];
  return details.join(' · ');
}
