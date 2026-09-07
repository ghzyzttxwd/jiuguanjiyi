import assert from 'node:assert/strict';
import {
  buildRehydrationPlans,
  formatRehydrationPlan,
  mergeColdBaseWithHot,
  planReactivatedRecord,
  recordPointer,
} from './rehydration_core.js';

const coldPerson = {
  身份: '轮回者',
  关系: { 好感: 80, 信任: 75, 状态: '盟友' },
  装备: { 武器: '长剑', 防具: '白衣' },
  标签: ['旧世界', '重要人物'],
};
const hotPartial = {
  关系: { 好感: 88, 状态: '同行' },
  当前地点: '主神广场',
  标签: ['当前活跃'],
};

const merged = mergeColdBaseWithHot(coldPerson, hotPartial);
assert.equal(merged.身份, '轮回者');
assert.equal(merged.关系.好感, 88);
assert.equal(merged.关系.信任, 75);
assert.equal(merged.关系.状态, '同行');
assert.equal(merged.装备.武器, '长剑');
assert.equal(merged.当前地点, '主神广场');
assert.deepEqual(merged.标签, ['当前活跃']);

const record = {
  id: 'r1',
  status: 'archived',
  sourcePath: '/人物',
  childKey: '降臣',
  pointer: '/人物/降臣',
  data: coldPerson,
};
assert.equal(recordPointer(record), '/人物/降臣');

let plan = planReactivatedRecord(record, { 人物: { 降臣: hotPartial } });
assert(plan);
assert.equal(plan.action, 'merge-hot-over-cold');
assert.equal(plan.merged.身份, '轮回者');
assert.equal(plan.merged.关系.好感, 88);
assert(plan.diff.coldOnly > 0);
assert(plan.diff.hotOnly > 0);
assert(plan.diff.changed > 0);
assert(formatRehydrationPlan(plan).includes('/人物/降臣'));

plan = planReactivatedRecord(record, { 人物: { 降臣: coldPerson } });
assert.equal(plan.action, 'mark-restored');

plan = planReactivatedRecord(
  { ...record, data: ['旧1', '旧2'] },
  { 人物: { 降臣: ['新1'] } },
);
assert.equal(plan.action, 'keep-hot-mark-restored');
assert.deepEqual(plan.merged, ['新1']);

plan = planReactivatedRecord(record, { 人物: {} });
assert.equal(plan, null);

plan = planReactivatedRecord({ ...record, status: 'restored' }, { 人物: { 降臣: hotPartial } });
assert.equal(plan, null);

const escapedRecord = {
  status: 'archived', sourcePath: '/人物', childKey: 'A/B~C', data: { x: 1 },
};
assert.equal(recordPointer(escapedRecord), '/人物/A~1B~0C');

const pollutedCold = JSON.parse('{"安全":1,"__proto__":{"污染":true}}');
const pollutedHot = JSON.parse('{"安全":2,"constructor":{"x":1}}');
const safeMerged = mergeColdBaseWithHot(pollutedCold, pollutedHot);
assert.equal(safeMerged.安全, 2);
assert.equal(Object.prototype.污染, undefined);
assert.equal(Object.prototype.hasOwnProperty.call(safeMerged, '__proto__'), false);
assert.equal(Object.prototype.hasOwnProperty.call(safeMerged, 'constructor'), false);

const archives = [
  record,
  { ...record, id: 'r2' },
  { id: 'r3', status: 'archived', sourcePath: '/人物', childKey: '女帝', pointer: '/人物/女帝', data: { 关系: '盟友' } },
];
let plans = buildRehydrationPlans({
  archives,
  statData: { 人物: { 降臣: hotPartial, 女帝: { 关系: '同行' } } },
});
assert.equal(plans.length, 1);
assert.equal(plans[0].record.id, 'r1');

plans = buildRehydrationPlans({
  archives,
  statData: { 人物: { 降臣: hotPartial, 女帝: { 关系: '同行' } } },
  settings: { maxPlansPerCycle: 3 },
});
assert.equal(plans.length, 2);
assert.equal(new Set(plans.map(x => x.pointer)).size, 2);

console.log(JSON.stringify({
  ok: true,
  tests: 27,
  firstAction: plans[0].action,
  mergedKeys: Object.keys(plans[0].merged),
}));
