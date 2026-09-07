import assert from 'node:assert/strict';
import {
  collectHotAnchorText,
  discoverContainers,
  selectArchiveCandidate,
  updateActivity,
} from './smart_host_core.js';

function makeMap(prefix, count, payload) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, payload(i)]));
}

function rng(seed = 123456789) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

const random = rng(20260908);
const stat = {
  玩家: {
    当前主修: '武学60',
    当前目标: '人物100',
    武学: makeMap('武学', 60, i => ({
      阶段: i % 5,
      熟练: i * 7,
      描述: 'w'.repeat(260 + (i % 8) * 30),
    })),
  },
  队伍: {
    成员: ['人物100', '人物99', '人物98'],
    当前任务: '护送人物97',
  },
  人物: makeMap('人物', 100, i => ({
    关系: i % 101,
    地点: `地点${i % 12}`,
    备注: 'p'.repeat(220 + (i % 9) * 25),
  })),
  世界档案: makeMap('世界', 20, i => ({
    名称: `世界${i + 1}`,
    状态摘要: `已完成阶段${i % 4}`,
    历史: 'h'.repeat(2400 + (i % 3) * 700),
  })),
  当前世界: { 名称: '世界20', 当前章节: '终局', 当前敌人: '人物96' },
};

const original = JSON.stringify(stat);
let activity = {};
let archivedSelections = 0;
let maxScanMs = 0;
const protectedKeys = new Set(['武学60', '人物100', '人物99', '人物98', '人物97', '人物96']);

for (let turn = 1; turn <= 500; turn++) {
  // Deterministic sparse edits emulate a long MVU chat without changing object counts.
  if (turn % 17 === 0) {
    const idx = 1 + Math.floor(random() * 90);
    stat.人物[`人物${idx}`].关系 = (stat.人物[`人物${idx}`].关系 + 1) % 101;
  }
  if (turn % 29 === 0) {
    const idx = 1 + Math.floor(random() * 50);
    stat.玩家.武学[`武学${idx}`].熟练 += 3;
  }

  const t0 = performance.now();
  const containers = discoverContainers(stat);
  const scanMs = performance.now() - t0;
  maxScanMs = Math.max(maxScanMs, scanMs);
  activity = updateActivity({ containers, prior: activity, messageCount: turn });

  const hot = `${collectHotAnchorText(stat)}\n本轮继续使用武学60，与人物100、人物99同行。`;

  if (turn < 80) continue;
  for (const container of containers) {
    const candidate = selectArchiveCandidate({
      container,
      activity: activity[container.path] || {},
      messageCount: turn,
      recentText: hot,
    });
    if (!candidate) continue;
    archivedSelections++;
    assert(!protectedKeys.has(candidate.key), `protected hot key selected: ${candidate.key}`);
  }
}

assert(archivedSelections > 0, 'stress simulation should eventually produce cold candidates');
assert(maxScanMs < 2000, `scan unexpectedly slow: ${maxScanMs}ms`);

// The simulation may update activity metadata and selected test fields, but container discovery
// and candidate selection must never delete or structurally rewrite the source tree.
const after = JSON.parse(JSON.stringify(stat));
const before = JSON.parse(original);
assert.equal(Object.keys(after.人物).length, Object.keys(before.人物).length);
assert.equal(Object.keys(after.玩家.武学).length, Object.keys(before.玩家.武学).length);
assert.equal(Object.keys(after.世界档案).length, Object.keys(before.世界档案).length);

const hotFinal = collectHotAnchorText(stat);
assert(hotFinal.includes('武学60'));
assert(hotFinal.includes('人物100'));
assert(!hotFinal.includes('人物1'));

console.log(JSON.stringify({
  ok: true,
  turns: 500,
  archivedSelections,
  maxScanMs: Math.round(maxScanMs * 100) / 100,
  protectedKeys: [...protectedKeys],
}));
