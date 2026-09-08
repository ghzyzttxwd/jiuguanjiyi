// Variable Archive Bridge v0.5.0 warm catalog pure logic.
// Builds a lightweight directory spanning hot MVU entries and cold archives.
// No browser APIs and no MVU writes in this file.

function escPtr(value) {
  return String(value ?? '').replace(/~/g, '~0').replace(/\//g, '~1');
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

function byteSize(value) {
  try { return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length; }
  catch { return String(value ?? '').length; }
}

function summarize(key, node) {
  const parts = [];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const labelKeys = ['名称', '姓名', '标题', '境界', '等级', '状态', '类型', '品质', 'name', 'title'];
    for (const k of labelKeys) {
      const v = node[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        const s = String(v ?? '').replace(/\s+/g, ' ').trim();
        if (s) parts.push(`${k}:${s}`);
      }
      if (parts.length >= 5) break;
    }
    if (parts.length < 5) {
      for (const [k, v] of Object.entries(node)) {
        if (parts.length >= 5) break;
        if (labelKeys.includes(k)) continue;
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          const s = String(v ?? '').replace(/\s+/g, ' ').trim();
          if (s && s.length <= 80) parts.push(`${k}:${s}`);
        }
      }
    }
  } else if (Array.isArray(node)) {
    parts.push(`数组:${node.length}项`);
  } else if (node !== undefined) {
    parts.push(String(node));
  }
  const body = parts.join('；');
  const text = `${key}${body ? `｜${body}` : ''}`;
  return text.length > 260 ? `${text.slice(0, 257)}…` : text;
}

function tokenize(...parts) {
  const all = parts.join(' ').split(/[\s,，。；;：:|｜/\\\[\]{}()（）<>《》"'`]+/)
    .map(x => String(x).trim())
    .filter(x => x.length >= 2 && x.length <= 40);
  return [...new Set(all)].slice(0, 36);
}

function pointerOf(sourcePath, key) {
  const base = String(sourcePath || '/').replace(/\/$/, '');
  return `${base}/${escPtr(key)}`;
}

function coolingKeys(preview, sourcePath) {
  const row = preview?.collections?.find?.(x => x?.path === sourcePath);
  return new Set((row?.cooling || []).map(x => String(x?.key)));
}

export function buildCatalogEntries({ statData, report, archives = [], scopeKey = '', scopeLabel = '', preview = null } = {}) {
  const map = new Map();
  const collections = Array.isArray(report?.collections) ? report.collections : [];

  for (const row of collections) {
    const sourcePath = String(row?.path || '');
    if (!sourcePath) continue;
    const container = getByPointer(statData, sourcePath);
    if (!container || typeof container !== 'object') continue;
    const entries = Array.isArray(container) ? container.map((v, i) => [String(i), v]) : Object.entries(container);
    const cool = coolingKeys(preview, sourcePath);
    for (const [key, node] of entries) {
      const pointer = pointerOf(sourcePath, key);
      const summary = summarize(key, node);
      map.set(pointer, {
        id: `catalog:${scopeKey}:${pointer}`,
        recordType: 'warm-catalog',
        status: 'catalog',
        scopeKey,
        scopeLabel,
        sourcePath,
        childKey: String(key),
        pointer,
        kindLabel: String(row?.label || sourcePath.split('/').filter(Boolean).at(-1) || '目录'),
        temperature: 'hot',
        coolingCandidate: cool.has(String(key)),
        archiveId: '',
        summary,
        tags: tokenize(key, row?.label, sourcePath, summary),
        sourceBytes: byteSize(node),
      });
    }
  }

  for (const archive of archives || []) {
    // Internal history segments are recall material, not entity-directory entries.
    if (!archive || archive.status !== 'archived' || archive.recordType === 'warm-catalog' || archive.recordType === 'history-segment') continue;
    const sourcePath = String(archive.sourcePath || '');
    const key = String(archive.childKey || '');
    if (!sourcePath || !key) continue;
    const pointer = String(archive.pointer || pointerOf(sourcePath, key));
    // Hot MVU is authoritative: never let an older cold row replace a hot row at the same pointer.
    if (map.has(pointer)) continue;
    const summary = String(archive.summary || summarize(key, archive.data));
    map.set(pointer, {
      id: `catalog:${scopeKey}:${pointer}`,
      recordType: 'warm-catalog',
      status: 'catalog',
      scopeKey,
      scopeLabel,
      sourcePath,
      childKey: key,
      pointer,
      kindLabel: String(archive.kindLabel || sourcePath.split('/').filter(Boolean).at(-1) || '目录'),
      temperature: 'cold',
      coolingCandidate: false,
      archiveId: String(archive.id || ''),
      summary,
      tags: Array.isArray(archive.tags) && archive.tags.length ? archive.tags.slice(0, 36) : tokenize(key, sourcePath, summary),
      sourceBytes: Math.max(0, Number(archive.size) || byteSize(archive.data)),
    });
  }

  return [...map.values()].sort((a, b) => {
    if (a.kindLabel !== b.kindLabel) return a.kindLabel.localeCompare(b.kindLabel, 'zh-CN');
    if (a.temperature !== b.temperature) return a.temperature === 'hot' ? -1 : 1;
    return a.childKey.localeCompare(b.childKey, 'zh-CN');
  });
}

const DIRECTORY_RE = /(哪些|有什么|有哪些|全部|所有|一共|清单|目录|列表|会什么|会哪些|认识哪些|拥有些什么|掌握哪些|学会哪些|去过哪些)/i;
const CATEGORY_RULES = [
  { re: /(武功|武学|功法|技能|能力|法术|招式|内功|剑法|掌法|轻功)/i, match: /(武功|武学|功法|技能|能力|法术|招式|内功|剑法|掌法|轻功)/i },
  { re: /(装备|物品|道具|背包|武器|防具)/i, match: /(装备|物品|道具|背包|武器|防具)/i },
  { re: /(人物|角色|朋友|同伴|队友|红颜|老婆|关系|认识)/i, match: /(人物|角色|朋友|同伴|队友|红颜|关系)/i },
  { re: /(世界|位面|副本|坐标)/i, match: /(世界|位面|副本|坐标)/i },
  { re: /(势力|组织|队伍|轮回队)/i, match: /(势力|组织|队伍|轮回队)/i },
  { re: /(事件|任务|情报|线索)/i, match: /(事件|任务|情报|线索)/i },
];

function relevantCategory(entry, query) {
  const rule = CATEGORY_RULES.find(x => x.re.test(query));
  if (!rule) return true;
  return rule.match.test(`${entry.kindLabel} ${entry.sourcePath} ${entry.tags?.join(' ') || ''}`);
}

export function buildDirectoryContext(entries, query, { maxItems = 80, maxChars = 5200 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const text = String(query || '').trim();
  if (!text || !list.length) return '';
  const lower = text.toLowerCase();
  const exact = list.filter(e => {
    const key = String(e.childKey || '').toLowerCase();
    return key.length >= 2 && lower.includes(key);
  });
  const directoryIntent = DIRECTORY_RE.test(text);
  if (!directoryIntent && !exact.length) return '';

  let selected = exact.length ? exact : list.filter(e => relevantCategory(e, text));
  if (!selected.length) return '';
  selected = selected.slice(0, Math.max(1, maxItems));

  let body = '';
  if (exact.length && !directoryIntent) {
    body = selected.map(e => `- ${e.childKey}｜${e.temperature === 'cold' ? '冷档案' : '热区'}｜${e.sourcePath}｜${e.summary}`).join('\n');
  } else {
    const groups = new Map();
    for (const e of selected) {
      const label = e.kindLabel || e.sourcePath || '目录';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(e);
    }
    body = [...groups.entries()].map(([label, rows]) => {
      const names = rows.map(e => `${e.childKey}${e.temperature === 'cold' ? '[冷]' : ''}`).join('、');
      return `${label}（${rows.length}）: ${names}`;
    }).join('\n');
  }

  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`;
  return `<variable_archive_catalog>\n这是变量归档桥的轻量目录。用于回答“有哪些/会哪些/认识哪些”等目录问题；详情仍以当前MVU和按需冷档案为准。\n${body}\n</variable_archive_catalog>`;
}
