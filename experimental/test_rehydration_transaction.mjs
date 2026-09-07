import assert from 'node:assert/strict';
import {
  executeRehydrationTransaction,
  RehydrationTransactionError,
} from './rehydration_transaction.js';

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
function set(root, path, value) {
  const ps = parts(path);
  let cur = root;
  for (let i = 0; i < ps.length - 1; i++) cur = cur[ps[i]] ||= {};
  cur[ps.at(-1)] = clone(value);
}

function makeHarness({
  hot = { 阶段: '圆满', 最近使用: '新剧情' },
  cold = { 类型: '剑法/指法', 品阶: '顶尖', 阶段: '小成', 来源: '陈近南亲传' },
  scopeKey = 'scope-A',
  onSnapshot = null,
  corruptWrite = false,
  failMark = false,
  failRollback = false,
} = {}) {
  const pointer = '/玩家/武学/凝血神剑';
  const box = {
    scopeKey,
    statData: { 玩家: { 武学: {} } },
    record: {
      id: 'arc1', status: 'archived', sourcePath: '/玩家/武学', childKey: '凝血神剑', pointer,
      data: clone(cold),
    },
    writes: 0,
    snapshots: 0,
    marks: 0,
    rollbacks: 0,
  };
  if (hot !== undefined) set(box.statData, pointer, hot);

  const io = {
    async refresh() {
      return { scopeKey: box.scopeKey, statData: clone(box.statData), messageId: 132 };
    },
    async getArchive(id, requestedScope) {
      if (id !== box.record.id || requestedScope !== box.scopeKey) return null;
      return box.record;
    },
    async saveSnapshot(before, reason) {
      box.snapshots++;
      const snap = { scopeKey: before.scopeKey, statData: clone(before.statData), reason };
      if (onSnapshot) await onSnapshot(box);
      return snap;
    },
    async writeMerged(path, merged) {
      box.writes++;
      set(box.statData, path, corruptWrite ? { 错误: true } : merged);
    },
    async readHot(path, snapshot) {
      return clone(get(snapshot.statData, path));
    },
    async markRestored(record, meta) {
      box.marks++;
      if (failMark) throw new Error('simulated mark failure');
      record.status = 'restored';
      record.rehydratedMeta = clone(meta);
    },
    async rollback(snapshot, beforeWrite) {
      box.rollbacks++;
      if (failRollback) throw new Error('simulated rollback failure');
      box.statData = clone(beforeWrite.statData);
    },
  };

  return { io, box, pointer };
}

// 1. Normal object merge commits once and preserves current hot fields.
{
  const { io, box, pointer } = makeHarness();
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'committed');
  assert.equal(result.wroteMvu, true);
  assert.equal(box.writes, 1);
  assert.equal(box.snapshots, 1);
  assert.equal(box.marks, 1);
  assert.equal(box.rollbacks, 0);
  assert.equal(box.record.status, 'restored');
  const value = get(box.statData, pointer);
  assert.equal(value.阶段, '圆满');
  assert.equal(value.最近使用, '新剧情');
  assert.equal(value.类型, '剑法/指法');
  assert.equal(value.来源, '陈近南亲传');
}

// 2. If hot state changes while snapshotting, write-time re-plan preserves the newer hot value.
{
  const { io, box, pointer } = makeHarness({
    onSnapshot: async state => {
      set(state.statData, '/玩家/武学/凝血神剑', { 阶段: '大成后突破', 最近使用: '快照期间的新变化' });
    },
  });
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'committed');
  const value = get(box.statData, pointer);
  assert.equal(value.阶段, '大成后突破');
  assert.equal(value.最近使用, '快照期间的新变化');
  assert.equal(value.品阶, '顶尖');
}

// 3. Exact hot/cold equality only marks archive restored; no MVU write or snapshot.
{
  const cold = { 类型: '内功', 阶段: '圆满' };
  const { io, box } = makeHarness({ hot: cold, cold });
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'restored-without-write');
  assert.equal(box.writes, 0);
  assert.equal(box.snapshots, 0);
  assert.equal(box.marks, 1);
  assert.equal(box.record.status, 'restored');
}

// 4. Arrays/scalars are atomic current state: keep hot and only close cold status.
{
  const { io, box, pointer } = makeHarness({ hot: ['新1'], cold: ['旧1', '旧2'] });
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'restored-without-write');
  assert.equal(box.writes, 0);
  assert.deepEqual(get(box.statData, pointer), ['新1']);
}

// 5. If target is still absent, rehydration does nothing. Plain restore is a different workflow.
{
  const { io, box } = makeHarness({ hot: undefined });
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'noop');
  assert.equal(box.writes, 0);
  assert.equal(box.marks, 0);
}

// 6. Scope switch after snapshot aborts before any MVU write.
{
  const { io, box } = makeHarness({ onSnapshot: async state => { state.scopeKey = 'scope-B'; } });
  await assert.rejects(
    () => executeRehydrationTransaction(io, 'arc1'),
    error => error instanceof RehydrationTransactionError && error.code === 'scope-changed',
  );
  assert.equal(box.writes, 0);
  assert.equal(box.marks, 0);
  assert.equal(box.record.status, 'archived');
}

// 7. Verification mismatch triggers rollback and keeps archive authoritative.
{
  const { io, box, pointer } = makeHarness({ corruptWrite: true });
  const before = clone(box.statData);
  await assert.rejects(
    () => executeRehydrationTransaction(io, 'arc1'),
    error => error instanceof RehydrationTransactionError && error.code === 'verify-failed',
  );
  assert.equal(box.writes, 1);
  assert.equal(box.rollbacks, 1);
  assert.deepEqual(box.statData, before);
  assert.equal(box.record.status, 'archived');
  assert.equal(get(box.statData, pointer).阶段, '圆满');
}

// 8. Archive-state commit failure after a verified MVU write also rolls MVU back.
{
  const { io, box } = makeHarness({ failMark: true });
  const before = clone(box.statData);
  await assert.rejects(
    () => executeRehydrationTransaction(io, 'arc1'),
    error => error instanceof RehydrationTransactionError && error.code === 'archive-commit-failed',
  );
  assert.equal(box.rollbacks, 1);
  assert.deepEqual(box.statData, before);
  assert.equal(box.record.status, 'archived');
}

// 9. If rollback itself cannot be verified, escalate explicitly instead of pretending success.
{
  const { io, box } = makeHarness({ corruptWrite: true, failRollback: true });
  await assert.rejects(
    () => executeRehydrationTransaction(io, 'arc1'),
    error => error instanceof RehydrationTransactionError && error.code === 'rollback-failed',
  );
  assert.equal(box.rollbacks, 1);
  assert.equal(box.record.status, 'archived');
}

// 10. Already-restored archive is a no-op.
{
  const { io, box } = makeHarness();
  box.record.status = 'restored';
  const result = await executeRehydrationTransaction(io, 'arc1');
  assert.equal(result.status, 'noop');
  assert.equal(box.writes, 0);
}

// 11. Missing archive fails before snapshot/write.
{
  const { io, box } = makeHarness();
  await assert.rejects(
    () => executeRehydrationTransaction(io, 'missing'),
    error => error instanceof RehydrationTransactionError && error.code === 'archive-missing',
  );
  assert.equal(box.snapshots, 0);
  assert.equal(box.writes, 0);
}

console.log(JSON.stringify({ ok: true, tests: 38, transactionModel: 'snapshot -> replan -> write -> verify -> commit-or-rollback' }));
