import assert from 'node:assert/strict';
import {
  collectHotAnchorText,
  discoverContainers,
  effectiveMinChildren,
  selectArchiveCandidate,
  simulateFutureArchiveCandidate,
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
    当前主修: '武学35',
    武学: dict('武学', 35, i => ({ 阶段: i % 3, 熟练: i, 描述: 'x'.repeat(400) })),
  },
  队伍: { 成员: ['人物40'], 当前目标: '护送人物39' },
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

const hotText = collectHotAnchorText(stat);
assert(hotText.includes('武学35'));
assert(hotText.includes('人物40'));
assert(hotText.includes('人物39'));
assert(!hotText.includes('人物1'));
assert(!hotText.includes('武学1'));

let activity = updateActivity({ containers: found, prior: {}, messageCount: 100 });
const martial = found.find(x => x.path === '/玩家/武学');
assert.equal(selectArchiveCandidate({ container: martial, activity: activity[martial.path], messageCount: 110, settings: { minIdleMessages: 40, minContainerBytes: 0 } }), null);

for (const k of Object.keys(activity[martial.path])) activity[martial.path][k].lastTouched = 50;
let candidate = selectArchiveCandidate({
  container: martial,
  activity: activity[martial.path],
  messageCount: 100,
  recentText: hotText,
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
assert(smallMartial);
{
  const a = updateActivity({containers: smallFound, prior:{}, messageCount:100});
  for (const k of Object.keys(a[smallMartial.path])) a[smallMartial.path][k].lastTouched = 0;
  assert.equal(selectArchiveCandidate({container:smallMartial, activity:a[smallMartial.path], messageCount:200}), null);
}

const beforeSim = JSON.stringify(small);
const simSmall = simulateFutureArchiveCandidate({
  container: smallMartial,
  messageCount: 132,
  futureMessages: 60,
  recentText: '我现在正在用武学8',
});
assert(simSmall);
assert.equal(simSmall.virtualCount, 31);
assert.notEqual(simSmall.candidate.key, '武学8');
assert.equal(JSON.stringify(small), beforeSim);

const simTooSoon = simulateFutureArchiveCandidate({
  container: martial,
  messageCount: 100,
  futureMessages: 10,
  settings: { minIdleMessages: 40, minContainerBytes: 0, minChildren: 30, targetChildren: 20, minMessagesBeforeArchive: 60 },
});
assert.equal(simTooSoon, null);

const hugeRecords = {
  世界档案: dict('世界', 7, i => ({
    名称: `世界${i+1}`,
    历史: 'z'.repeat(9 * 1024),
    结局: '已结束',
  })),
};
const hugeFound = discoverContainers(hugeRecords);
const worlds = hugeFound.find(x => x.path === '/世界档案');
assert(worlds);
assert.equal(effectiveMinChildren(worlds), 5);
let worldActivity = updateActivity({ containers: [worlds], prior: {}, messageCount: 100 });
for (const key of Object.keys(worldActivity[worlds.path])) worldActivity[worlds.path][key].lastTouched = 0;
const worldCandidate = selectArchiveCandidate({
  container: worlds,
  activity: worldActivity[worlds.path],
  messageCount: 100,
  recentText: '世界7刚刚回归主线',
});
assert(worldCandidate);
assert.notEqual(worldCandidate.key, '世界7');

const tinyRecords = { 物品: dict('物品', 7, i => ({ 名称: `物品${i+1}`, 数量: 1 })) };
const tinyFound = discoverContainers(tinyRecords);
const tiny = tinyFound.find(x => x.path === '/物品');
assert(tiny);
assert.equal(effectiveMinChildren(tiny), 30);
let tinyActivity = updateActivity({ containers: [tiny], prior: {}, messageCount: 100 });
for (const key of Object.keys(tinyActivity[tiny.path])) tinyActivity[tiny.path][key].lastTouched = 0;
assert.equal(selectArchiveCandidate({container: tiny, activity: tinyActivity[tiny.path], messageCount: 200}), null);

const stalePrior = {
  '/人物': { 人物1: { hash: 'old', lastTouched: 1 } },
  '/已删除容器': { 旧数据: { hash: 'dead', lastTouched: 1 } },
};
const pruned = updateActivity({ containers: found, prior: stalePrior, messageCount: 200 });
assert(!('/已删除容器' in pruned));
assert('/人物' in pruned);

const stress = { 人物: dict('角色', 5000, i=>({a:i,b:'z'.repeat(100)})) };
const t0 = performance.now();
const stressFound = discoverContainers(stress);
const elapsed = performance.now() - t0;
assert(stressFound.some(x=>x.path === '/人物'));
assert(elapsed < 2000);

console.log(JSON.stringify({
  ok:true,
  tests:34,
  stressMs:Math.round(elapsed),
  discovered:found.map(x=>x.path),
  simulatedCandidate:simSmall?.candidate?.key,
  adaptiveWorldLimit:effectiveMinChildren(worlds),
  hotAnchors:hotText.split('\n').slice(0,8),
}));
