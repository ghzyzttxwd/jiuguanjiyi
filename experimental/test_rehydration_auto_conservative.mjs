import assert from 'node:assert/strict';
import { executeRehydrationTransaction } from './rehydration_transaction.js';

function clone(v) { return structuredClone(v); }
function parts(path) { return String(path).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~')); }
function get(root, path) {
  let cur = root;
  for (const p of parts(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function harness({ hot, cold }) {
  const pointer = '/人物/降臣';
  const box = {
    scopeKey: 'scope-A',
    statData: { 人物: { 降臣: clone(hot) } },
    record: {
      id: 'arc1', status: 'archived', sourcePath: '/人物', childKey: '降臣', pointer,
      data: clone(cold),
    },
    writes: 0,
    snapshots: 0,
    marks: 0,
  };

  const io = {
    async refresh() { return { scopeKey: box.scopeKey, statData: clone(box.statData), messageId: 132 }; },
    async getArchive(id, requestedScope) {
      if (id !== box.record.id || requestedScope !== box.scopeKey) return null;
      return clone(box.record);
    },
    async saveSnapshot() { box.snapshots++; return { scopeKey: box.scopeKey, statData: clone(box.statData) }; },
    async writeMerged() { box.writes++; throw new Error('automatic conservative test must never write MVU'); },
    async readHot(path, snapshot) { return clone(get(snapshot.statData, path)); },
    async markRestored(record, meta) {
      box.marks++;
      box.record.status = 'restored';
      box.record.rehydratedMeta = clone(meta);
    },
    async rollback() { throw new Error('rollback should not be needed without an MVU write'); },
  };

  return { io, box, pointer };
}

// Cold archive contains fields that disappeared in the new hot object. Automatic mode must not revive them.
{
  const hot = { 当前身份: '轮回者', 立场: '暂时合作', 最近事件: '重新进入主线' };
  const cold = { 当前身份: '旧世界NPC', 立场: '旧盟友', 旧伤: '寒毒未愈', 私人物品: '旧药囊' };
  const { io, box, pointer } = harness({ hot, cold });
  const before = clone(box.statData);
  const result = await executeRehydrationTransaction(io, 'arc1', { autoConservative: true });

  assert.equal(result.status, 'restored-without-write');
  assert.equal(result.mode, 'auto-conservative-hot-authoritative');
  assert.equal(result.wroteMvu, false);
  assert.equal(result.skippedColdMerge, true);
  assert.equal(box.writes, 0);
  assert.equal(box.snapshots, 0);
  assert.equal(box.marks, 1);
  assert.equal(box.record.status, 'restored');
  assert.deepEqual(box.statData, before);
  assert.equal(get(box.statData, pointer).旧伤, undefined);
  assert.equal(get(box.statData, pointer).私人物品, undefined);
  assert.equal(get(box.statData, pointer).当前身份, '轮回者');
  assert.equal(box.record.rehydratedMeta.mode, 'auto-conservative-hot-authoritative');
}

// If hot and cold already match, normal no-write close remains valid in conservative mode.
{
  const hot = { 姓名: '降臣', 状态: '同行' };
  const { io, box } = harness({ hot, cold: hot });
  const result = await executeRehydrationTransaction(io, 'arc1', { autoConservative: true });
  assert.equal(result.status, 'restored-without-write');
  assert.equal(result.wroteMvu, false);
  assert.equal(box.writes, 0);
  assert.equal(box.snapshots, 0);
  assert.equal(box.marks, 1);
}

// Manual/default mode remains capable of a real merge; conservative behavior is opt-in for automation only.
{
  const hot = { 当前身份: '轮回者' };
  const cold = { 当前身份: '旧NPC', 历史事实: '曾在旧世界相识' };
  const pointer = '/人物/降臣';
  const box = {
    scopeKey: 'scope-A',
    statData: { 人物: { 降臣: clone(hot) } },
    record: { id: 'arc1', status: 'archived', sourcePath: '/人物', childKey: '降臣', pointer, data: clone(cold) },
    writes: 0, snapshots: 0, marks: 0,
  };
  const io = {
    async refresh() { return { scopeKey: box.scopeKey, statData: clone(box.statData), messageId: 132 }; },
    async getArchive() { return clone(box.record); },
    async saveSnapshot(before) { box.snapshots++; return { scopeKey: before.scopeKey, statData: clone(before.statData) }; },
    async writeMerged(path, merged) {
      box.writes++;
      box.statData.人物.降臣 = clone(merged);
    },
    async readHot(path, snapshot) { return clone(get(snapshot.statData, path)); },
    async markRestored(record, meta) { box.marks++; box.record.status = 'restored'; box.record.rehydratedMeta = clone(meta); },
    async rollback(snapshot, beforeWrite) { box.statData = clone(beforeWrite.statData); },
  };
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'committed');
  assert.equal(result.wroteMvu, true);
  assert.equal(box.writes, 1);
  assert.equal(box.snapshots, 1);
  assert.equal(box.statData.人物.降臣.当前身份, '轮回者');
  assert.equal(box.statData.人物.降臣.历史事实, '曾在旧世界相识');
}

console.log(JSON.stringify({ ok: true, tests: 24, automaticPolicy: 'hot-authoritative-no-cold-field-resurrection' }));
