import assert from 'node:assert/strict';
import {
  discoverContainers,
  selectArchiveCandidate,
  updateActivity,
  textMentionsKey,
  isProtectedPath,
} from './smart_host_core.js';

function dict(prefix, n, payload = i => ({ level: i % 9, note: `n${i}` })) {
  return Object.fromEntries(Array.from({length:n}, (_,i)=>[`${prefix}${i+1}`, payload(i)]));
}

const stat = {
  玩家: {
    当前状态: { hp: 100, mp: 50 },
    武学: dict('武学', 35, i => ({ 阶段: i % 3, 熟练: i, 描述: 'x'.repeat(400) })),
  },
  人物: dict('人物', 40, i => ({ 关系: i, 地点: '城', 备注: 'y'.repeat(300) })),
  当前世界: { 名称: '测试', 状态: { 天气: '晴' } },
};

const found = discoverContainers(stat, { minChildren: 30 });
assert(found.some(x => x.path === '/玩家/武学'));
assert(found.some(x => x.path === '/人物'));
assert(!found.some(x => x.path.includes('当前状态')));
assert(!found.some(x => x.path.includes('当前世界')));
assert.equal(isProtectedPath('/玩家/当前状态'), true);
assert.equal(isProtectedPath('/当前世界/人物'), true);
assert.equal(textMentionsKey('我去找人物9', '人物9'), true);
assert.equal(textMentionsKey('我去找人物9', '人物8'), false);

let activity = updateActivity({ containers: found, prior: {}, messageCount: 100 });
const martial = found.find(x => x.path === '/玩家/武学');
assert.equal(selectArchiveCandidate({ container: martial, activity: activity[martial.path], messageCount: 110, settings: { minIdleMessages: 40, minContainerBytes: 0 } }), null);

for (const k of Object.keys(activity[martial.path])) activity[martial.path][k].lastTouched = 50;
let candidate = selectArchiveCandidate({
  container: martial,
  activity: activity[martial.path],
  messageCount: 100,
  recentText: '我现在主要使用武学35',
  settings: { minIdleMessages: 40, minContainerBytes: 0, minChildren: 30, targetChildren: 20, minMessagesBeforeArchive: 60 },
});
assert(candidate);
assert.notEqual(candidate.key, '武学35');

candidate = selectArchiveCandidate({
  container: martial,
  activity: activity[martial.path],
  messageCount: 30,
  settings: { minIdleMessages: 1, minContainerBytes: 0, minChildren: 30, targetChildren: 20, minMessagesBeforeArchive: 60 },
});
assert.equal(candidate, null);

const small = { 玩家: { 武学: dict('武学', 8) } };
const smallFound = discoverContainers(small);
const smallMartial = smallFound.find(x=>x.path === '/玩家/武学');
if (smallMartial) {
  const a = updateActivity({containers: smallFound, prior:{}, messageCount:100});
  for (const k of Object.keys(a[smallMartial.path])) a[smallMartial.path][k].lastTouched = 0;
  assert.equal(selectArchiveCandidate({container:smallMartial, activity:a[smallMartial.path], messageCount:200}), null);
}

const stress = { 人物: dict('角色', 5000, i=>({a:i,b:'z'.repeat(100)})) };
const t0 = performance.now();
const stressFound = discoverContainers(stress);
const elapsed = performance.now() - t0;
assert(stressFound.some(x=>x.path === '/人物'));
assert(elapsed < 2000);

console.log(JSON.stringify({ok:true, tests:14, stressMs:Math.round(elapsed), discovered:found.map(x=>x.path)}));
