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

export function byteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function countContainer(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function levelFor(count, softLimit, hardLimit) {
  if (count > hardLimit) return 'hard';
  if (count > softLimit) return 'warn';
  return 'ok';
}

function isObjectRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLikelyDynamicRecord(value) {
  if (!isObjectRecord(value)) return false;
  const entries = Object.values(value);
  if (entries.length < 4) return false;
  const structured = entries.filter(v => v && typeof v === 'object').length;
  return structured / entries.length >= 0.5;
}

function pointerJoin(base, key) {
  const segment = escapePointerSegment(key);
  if (!base || base === '/') return `/${segment}`;
  return `${base.replace(/\/$/, '')}/${segment}`;
}

function pathLabel(path) {
  const parts = parsePointer(path);
  return parts[parts.length - 1] || path || '根节点';
}

export const MAIN_GOD_POLICY = {
  id: 'main-god-v1',
  label: '主神空间 V1.x 适配策略',
  collectionPolicies: [
    { path: '/玩家/能力', label: '玩家能力', softLimit: 12, hardLimit: 20, strategy: '近期使用 / 当前主修 / 当前任务相关优先' },
    { path: '/玩家/装备', label: '玩家装备', softLimit: 12, hardLimit: 20, strategy: '当前装备 / 近期使用 / 关键道具优先' },
    { path: '/长期人物', label: '长期人物', softLimit: 10, hardLimit: 16, protect: '同行', strategy: '同行 / 当前世界 / 未结因果优先' },
    { path: '/当前世界/重要人物', label: '当前世界重要人物', softLimit: 15, hardLimit: 24, strategy: '当前区域 / 最近接触 / 当前任务相关优先' },
    { path: '/当前世界/重要势力', label: '当前世界重要势力', softLimit: 10, hardLimit: 16, strategy: '当前行动 / 与玩家直接相关优先' },
    { path: '/当前世界/重大事件', label: '当前世界重大事件', softLimit: 12, hardLimit: 20, protect: '未完结事件', strategy: '进行中 / 未完成 / 未失效优先' },
    { path: '/当前世界/玩家已知情报', label: '玩家已知情报', softLimit: 20, hardLimit: 32, strategy: '当前世界有效 / 最近获得优先' },
    { path: '/世界档案', label: '世界档案', softLimit: 2, hardLimit: 4, strategy: '当前可重返 / 最近离开优先；其余进入冷档案' },
    { path: '/轮回者生态/轮回队', label: '轮回队', softLimit: 8, hardLimit: 12, strategy: '当前接触 / 当前区域相关优先' },
    { path: '/轮回者生态/重要轮回者', label: '重要轮回者', softLimit: 12, hardLimit: 20, strategy: '近期接触 / 敌友关系活跃优先' },
    { path: '/轮回者生态/已知组织', label: '已知组织', softLimit: 10, hardLimit: 16, strategy: '当前任务 / 当前区域相关优先' },
    { path: '/轮回残印/解析档案', label: '解析档案', softLimit: 8, hardLimit: 12, strategy: '当前研究对象 / 最近推进优先' },
    { path: '/轮回残印/世界烙印', label: '世界烙印', softLimit: 8, hardLimit: 12, strategy: '当前可能使用 / 最近获得优先' },
    { path: '/资源/世界坐标', label: '世界坐标', softLimit: 10, hardLimit: 20, strategy: '当前可进入 / 当前任务相关优先' },
  ],
  historyPolicies: [
    { containerPath: '/长期人物', fieldPath: '/共同经历', label: '长期人物·共同经历', softLimit: 8, hardLimit: 16 },
    { containerPath: '/长期人物', fieldPath: '/与玩家关系/关键关系事件', label: '长期人物·关键关系事件', softLimit: 5, hardLimit: 10 },
    { containerPath: '/当前世界/重要人物', fieldPath: '/重要经历', label: '世界人物·重要经历', softLimit: 6, hardLimit: 12 },
    { containerPath: '/当前世界/重要势力', fieldPath: '/重要变化', label: '势力·重要变化', softLimit: 6, hardLimit: 12 },
    { containerPath: '/当前世界/重大事件', fieldPath: '/已发生偏移', label: '重大事件·已发生偏移', softLimit: 6, hardLimit: 12 },
    { containerPath: '/当前世界/重大事件', fieldPath: '/衍生事件', label: '重大事件·衍生事件', softLimit: 6, hardLimit: 12 },
    { containerPath: '/轮回者生态/轮回队', fieldPath: '/重要历史', label: '轮回队·重要历史', softLimit: 6, hardLimit: 12 },
    { containerPath: '/世界档案', fieldPath: '/重大事件结果', label: '世界档案·重大事件结果', softLimit: 12, hardLimit: 24 },
    { containerPath: '/世界档案', fieldPath: '/玩家永久改变', label: '世界档案·玩家永久改变', softLimit: 12, hardLimit: 24 },
  ],
};

export function detectMainGod(statData) {
  if (!statData || typeof statData !== 'object') return false;
  return !!(
    getByPointer(statData, '/玩家') &&
    getByPointer(statData, '/轮回残印') &&
    getByPointer(statData, '/当前轮回') &&
    getByPointer(statData, '/当前世界') &&
    getByPointer(statData, '/长期人物') !== undefined &&
    getByPointer(statData, '/世界档案') !== undefined
  );
}

export function discoverGenericPolicy(statData, { maxDepth = 4 } = {}) {
  const collectionPolicies = [];
  const historyPolicies = [];
  const seenCollections = new Set();
  const seenHistories = new Set();

  function walk(value, path, depth) {
    if (depth > maxDepth || value == null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      if (value.length >= 8 && path) {
        const key = path;
        if (!seenCollections.has(key)) {
          seenCollections.add(key);
          collectionPolicies.push({
            path,
            label: `${pathLabel(path)}（自动发现数组）`,
            softLimit: 12,
            hardLimit: 24,
            strategy: '通用自动发现：近期/当前相关项优先；仅分析，不自动删除',
            inferred: true,
          });
        }
      }
      return;
    }

    if (path && isLikelyDynamicRecord(value)) {
      const key = path;
      if (!seenCollections.has(key)) {
        seenCollections.add(key);
        collectionPolicies.push({
          path,
          label: `${pathLabel(path)}（自动发现记录）`,
          softLimit: 12,
          hardLimit: 24,
          strategy: '通用自动发现：最近变更/最近提及/当前相关项优先；仅分析，不自动删除',
          inferred: true,
        });
      }

      for (const [ownerKey, node] of Object.entries(value)) {
        if (!isObjectRecord(node)) continue;
        for (const [fieldKey, fieldValue] of Object.entries(node)) {
          if (!Array.isArray(fieldValue) || fieldValue.length < 6) continue;
          const fieldPath = `/${escapePointerSegment(fieldKey)}`;
          const hKey = `${path}|${fieldPath}`;
          if (seenHistories.has(hKey)) continue;
          seenHistories.add(hKey);
          historyPolicies.push({
            containerPath: path,
            fieldPath,
            label: `${pathLabel(path)}·${fieldKey}（自动发现历史）`,
            softLimit: 8,
            hardLimit: 16,
            inferred: true,
          });
        }
        // one representative child is enough to infer field shape for this collection
        break;
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (child == null || typeof child !== 'object') continue;
      walk(child, pointerJoin(path, key), depth + 1);
    }
  }

  walk(statData, '', 0);
  return {
    id: 'generic-auto',
    label: '通用自动发现策略',
    collectionPolicies,
    historyPolicies,
  };
}

function protectedCountFor(policy, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  if (policy.protect === '同行') {
    return Object.values(value).filter(v => v && typeof v === 'object' && v.是否同行 === true).length;
  }
  if (policy.protect === '未完结事件') {
    return Object.values(value).filter(v => {
      if (!v || typeof v !== 'object') return false;
      if (v.是否永久失效 === true) return false;
      const status = String(v.状态 || '');
      return !/(完成|已结束|终结|永久失效|失效)/.test(status);
    }).length;
  }
  return 0;
}

export function analyzeCollections(statData, policies = []) {
  const rows = [];
  for (const policy of policies) {
    const value = getByPointer(statData, policy.path);
    if (value === undefined) continue;
    const count = countContainer(value);
    const protectedCount = protectedCountFor(policy, value);
    const excess = Math.max(0, count - policy.softLimit);
    rows.push({
      ...policy,
      count,
      bytes: byteSize(value),
      protectedCount,
      excess,
      level: levelFor(count, policy.softLimit, policy.hardLimit),
    });
  }
  return rows;
}

export function analyzeHistoryArrays(statData, policies = []) {
  const rows = [];
  for (const policy of policies) {
    const container = getByPointer(statData, policy.containerPath);
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const [key, node] of Object.entries(container)) {
      const value = getByPointer(node, policy.fieldPath);
      if (!Array.isArray(value)) continue;
      const count = value.length;
      if (count <= policy.softLimit) continue;
      rows.push({
        ...policy,
        ownerKey: key,
        count,
        bytes: byteSize(value),
        excess: Math.max(0, count - policy.softLimit),
        level: levelFor(count, policy.softLimit, policy.hardLimit),
      });
    }
  }
  return rows.sort((a, b) => (b.level === 'hard') - (a.level === 'hard') || b.excess - a.excess);
}

export function resolvePolicy(statData, externalPolicy = null) {
  if (externalPolicy && Array.isArray(externalPolicy.collectionPolicies)) {
    return {
      id: String(externalPolicy.id || 'card-policy'),
      label: String(externalPolicy.label || '角色卡自带策略'),
      collectionPolicies: externalPolicy.collectionPolicies,
      historyPolicies: Array.isArray(externalPolicy.historyPolicies) ? externalPolicy.historyPolicies : [],
      source: 'card',
    };
  }
  if (detectMainGod(statData)) return { ...MAIN_GOD_POLICY, source: 'builtin-profile' };
  return { ...discoverGenericPolicy(statData), source: 'generic-auto' };
}

export function analyzeHotState(statData, { externalPolicy = null } = {}) {
  const policy = resolvePolicy(statData, externalPolicy);
  const collections = analyzeCollections(statData, policy.collectionPolicies);
  const histories = analyzeHistoryArrays(statData, policy.historyPolicies);
  const hard = collections.filter(x => x.level === 'hard').length + histories.filter(x => x.level === 'hard').length;
  const warn = collections.filter(x => x.level === 'warn').length + histories.filter(x => x.level === 'warn').length;
  const candidateCount = collections.reduce((sum, x) => sum + x.excess, 0) + histories.reduce((sum, x) => sum + x.excess, 0);
  return {
    profile: policy.id,
    profileLabel: policy.label,
    policySource: policy.source,
    readOnly: true,
    collections,
    histories,
    summary: {
      hard,
      warn,
      candidateCount,
      totalStatBytes: byteSize(statData),
      governedCollectionBytes: collections.reduce((sum, x) => sum + x.bytes, 0),
    },
  };
}
