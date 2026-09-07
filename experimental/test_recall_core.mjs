import assert from 'node:assert/strict';
import {
  buildRecallContext,
  formatRecallContext,
  isRecordHot,
  querySignals,
  scoreArchiveRecord,
  selectRecallRecords,
} from './recall_core.js';

const now = Date.now();
const archives = [
  {
    id: 'a1', status: 'archived', sourcePath: '/玩家/武学', childKey: '凝血神剑', pointer: '/玩家/武学/凝血神剑',
    summary: '凝血神剑 | 类型:剑法/指法; 品阶:顶尖; 阶段:小成; 来源:陈近南亲传',
    tags: ['凝血神剑', '剑法', '陈近南'], data: { 类型: '剑法/指法', 品阶: '顶尖', 阶段: '小成' }, archivedAt: now - 1000,
  },
  {
    id: 'a2', status: 'archived', sourcePath: '/人物', childKey: '小龙女', pointer: '/人物/小龙女',
    summary: '小龙女 | 当前为同行轮回者; 与user关系深厚', tags: ['小龙女', '同行', '轮回者'],
    data: { 身份: '轮回者', 关系: '深厚', 状态: '暂时分队' }, archivedAt: now - 2000, pinned: true,
  },
  {
    id: 'a3', status: 'archived', sourcePath: '/世界档案', childKey: '不良人世界', pointer: '/世界档案/不良人世界',
    summary: '不良人世界 | 曾与降臣、女帝建立重要关系', tags: ['不良人', '降臣', '女帝'],
    data: { 降臣: '盟友', 女帝: '深厚关系', 世界状态: '主线偏移' }, archivedAt: now - 3000,
  },
  {
    id: 'a4', status: 'restored', sourcePath: '/人物', childKey: '已恢复人物', pointer: '/人物/已恢复人物',
    summary: '不应召回', tags: ['已恢复人物'], data: { x: 1 }, archivedAt: now,
  },
  {
    id: 'a5', status: 'archived', sourcePath: '/人物', childKey: '镜像人物', pointer: '/人物/镜像人物',
    summary: '已镜像记忆表', tags: ['镜像人物'], data: { x: 2 }, archivedAt: now, mirroredToMemory: true,
  },
];

const stat = {
  玩家: { 武学: { 凌波微步: { 阶段: '入门' } } },
  人物: { 小龙女: { 身份: '轮回者', 当前状态: '同行' } },
};

assert.equal(isRecordHot(archives[1], stat), true);
assert.equal(isRecordHot(archives[0], stat), false);
assert(querySignals('我想起凝血神剑，还有陈近南').text.includes('凝血神剑'));

const swordScore = scoreArchiveRecord(archives[0], '我重新研究一下凝血神剑');
assert(swordScore.score > 1000);
assert(swordScore.reasons.some(x => x.includes('命中名称')));

const hotScore = scoreArchiveRecord(archives[1], '小龙女现在在哪里？', { statData: stat });
assert.equal(hotScore.score, -Infinity);

let ranked = selectRecallRecords({
  archives,
  statData: stat,
  queryText: '回忆一下不良人里我和降臣、女帝的事，再看看凝血神剑。',
});
assert.equal(ranked.length, 2);
assert(ranked.some(x => x.record.childKey === '不良人世界'));
assert(ranked.some(x => x.record.childKey === '凝血神剑'));
assert(!ranked.some(x => x.record.childKey === '小龙女'));
assert(!ranked.some(x => x.record.childKey === '已恢复人物'));

ranked = selectRecallRecords({
  archives,
  statData: {},
  queryText: '今天随便聊聊',
});
assert(ranked.some(x => x.record.childKey === '小龙女'), 'pinned cold record should be eligible as low-priority background context');

ranked = selectRecallRecords({
  archives,
  statData: {},
  queryText: '镜像人物后来怎么样了',
  settings: { skipMirrored: true },
});
assert(!ranked.some(x => x.record.childKey === '镜像人物'));

const formatted = formatRecallContext([
  { record: archives[0], score: 1500, reasons: ['命中名称:凝血神剑'] },
], { maxChars: 2000, maxRecordChars: 900 });
assert(formatted.includes('<variable_cold_archive_recall>'));
assert(formatted.includes('凝血神剑'));
assert(formatted.includes('当前热变量和最新剧情为准'));
assert(formatted.length <= 2000);

const huge = {
  ...archives[2],
  id: 'huge', childKey: '超大世界档案', pointer: '/世界档案/超大世界档案',
  tags: ['超大世界档案'], summary: '超大世界档案', data: { 历史: '大'.repeat(20000) },
};
const built = buildRecallContext({
  archives: [huge, archives[0]],
  statData: {},
  queryText: '超大世界档案和凝血神剑',
  settings: { maxChars: 3000, maxRecordChars: 1200, maxRecords: 6 },
});
assert(built.text.length <= 3000);
assert(built.ranked.length >= 1);
assert(built.text.includes('超大世界档案'));
assert(built.text.includes('本条已截断'));

const dedupe = selectRecallRecords({
  archives: [archives[0], { ...archives[0], id: 'dup', archivedAt: now + 1 }],
  statData: {},
  queryText: '凝血神剑',
});
assert.equal(dedupe.filter(x => x.record.childKey === '凝血神剑').length, 1);

console.log(JSON.stringify({
  ok: true,
  tests: 23,
  top: ranked.map(x => [x.record.childKey, Math.round(x.score)]),
  builtChars: built.chars,
}));
