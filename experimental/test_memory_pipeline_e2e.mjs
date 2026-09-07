import assert from 'node:assert/strict';
import {
  buildRecallContext,
  selectRecallRecords,
} from './recall_core.js';
import {
  analyzeRecallDelivery,
  detectMacroPlacement,
} from './recall_delivery_core.js';
import {
  planReactivatedRecord,
} from './rehydration_core.js';

function clone(v) {
  return structuredClone(v);
}

function setBySimplePointer(root, path, value) {
  const parts = String(path).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ||= {};
  cur[parts.at(-1)] = value;
}

const archivedSword = {
  id: 'arc_sword',
  status: 'archived',
  sourcePath: '/玩家/武学',
  childKey: '凝血神剑',
  pointer: '/玩家/武学/凝血神剑',
  summary: '凝血神剑｜类型:剑法/指法；品阶:顶尖；阶段:小成；来源:陈近南亲传',
  tags: ['凝血神剑', '剑法', '指法', '陈近南'],
  data: {
    类型: '剑法/指法',
    品阶: '顶尖',
    阶段: '小成',
    来源: '陈近南亲传',
    说明: '旧档案保留的完整历史字段',
  },
  archivedAt: Date.now() - 100000,
};

const stat = {
  玩家: {
    当前主修: '玄天纯阳诀',
    武学: {
      玄天纯阳诀: { 类型: '内功', 阶段: '圆满' },
      凌波微步: { 类型: '轻功', 阶段: '入门' },
    },
  },
  当前任务: { 目标: '追查陈近南留下的旧线索' },
};

const originalCold = JSON.stringify(archivedSword);
const originalStat = JSON.stringify(stat);

// Phase 1: cold object is absent from hot MVU, but a relevant user query should recall it.
let recall = buildRecallContext({
  archives: [archivedSword],
  statData: stat,
  queryText: '我想重新看看凝血神剑，陈近南当时教我的细节是什么？',
});
assert.equal(recall.ranked.length, 1);
assert.equal(recall.ranked[0].record.childKey, '凝血神剑');
assert(recall.text.includes('旧档案保留的完整历史字段'));

// Phase 2: if the old macro is definitely present in prompt configuration, the new auto-prompt yields.
const placement = detectMacroPlacement([
  { name: 'preset', value: { custom: '历史档案：{{varArchiveContext}}' } },
]);
const delivery = analyzeRecallDelivery({
  ranked: recall.ranked,
  legacyMacroEnabled: true,
  legacyMacroText: '名称: 凝血神剑\n原变量: /玩家/武学/凝血神剑',
  macroPlacement: placement,
});
assert.equal(delivery.mode, 'legacy-macro');
assert.equal(delivery.shouldInject, false);

// Phase 3: later the model/story recreates the same pointer with only current fields.
const statReactivated = clone(stat);
setBySimplePointer(statReactivated, archivedSword.pointer, {
  阶段: '圆满',
  最近使用: '本轮重新施展',
});
const plan = planReactivatedRecord(archivedSword, statReactivated);
assert(plan);
assert.equal(plan.action, 'merge-hot-over-cold');
assert.equal(plan.merged.阶段, '圆满');
assert.equal(plan.merged.最近使用, '本轮重新施展');
assert.equal(plan.merged.类型, '剑法/指法');
assert.equal(plan.merged.品阶, '顶尖');
assert.equal(plan.merged.来源, '陈近南亲传');
assert.equal(plan.merged.说明, '旧档案保留的完整历史字段');

// Phase 4: after the planned merge is simulated into hot MVU, cold recall must stop duplicating it.
setBySimplePointer(statReactivated, archivedSword.pointer, plan.merged);
recall = buildRecallContext({
  archives: [archivedSword],
  statData: statReactivated,
  queryText: '凝血神剑现在是什么状态？',
});
assert.equal(recall.ranked.length, 0);
assert.equal(recall.text, '');

// Phase 5: cold-library scale test. Exact target must still be found among thousands of irrelevant records.
const many = [];
for (let i = 0; i < 5000; i++) {
  many.push({
    id: `r${i}`,
    status: 'archived',
    sourcePath: '/人物',
    childKey: `人物${i}`,
    pointer: `/人物/人物${i}`,
    summary: `人物${i}｜普通历史记录`,
    tags: [`人物${i}`, `地区${i % 50}`],
    data: { 关系: i % 100, 备注: `记录${i}` },
    archivedAt: i,
  });
}
many.push({
  id: 'target',
  status: 'archived',
  sourcePath: '/世界档案',
  childKey: '不良人世界',
  pointer: '/世界档案/不良人世界',
  summary: '不良人世界｜与降臣、女帝存在重要旧因果',
  tags: ['不良人', '降臣', '女帝'],
  data: { 降臣: '盟友', 女帝: '重要关系' },
  archivedAt: Date.now(),
});
const t0 = performance.now();
const ranked = selectRecallRecords({
  archives: many,
  statData: {},
  queryText: '回忆不良人世界里降臣和女帝的旧事',
});
const elapsed = performance.now() - t0;
assert(ranked.some(x => x.record.childKey === '不良人世界'));
assert(elapsed < 2000, `5001-record recall unexpectedly slow: ${elapsed}ms`);

// Pure pipeline stages must not mutate their inputs.
assert.equal(JSON.stringify(archivedSword), originalCold);
assert.equal(JSON.stringify(stat), originalStat);

console.log(JSON.stringify({
  ok: true,
  tests: 26,
  firstRecall: '凝血神剑',
  deliveryMode: delivery.mode,
  rehydrationMode: plan.action,
  coldLibraryRecords: many.length,
  recallMs: Math.round(elapsed * 100) / 100,
}));
