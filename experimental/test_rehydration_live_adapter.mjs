import assert from 'node:assert/strict';
import { createRehydrationLiveIo } from './rehydration_live_adapter.js';

const clone = v => structuredClone(v);

function get(root, path) {
  const parts = String(path).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function set(root, path, value) {
  const parts = String(path).split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ||= {};
  cur[parts.at(-1)] = clone(value);
}

function makeHarness() {
  const pointer = '/玩家/武学/凝血神剑';
  const state = {
    scopeKey: 'scope-A',
    messageId: 12,
    statData: { 玩家: { 武学: { 凝血神剑: { 阶段: '圆满', 最近使用: '当前剧情' } } } },
    variables: { stat_data: null, other: { keep: true } },
    record: {
      id: 'arc-live-1',
      scopeKey: 'scope-A',
      status: 'archived',
      sourcePath: '/玩家/武学',
      childKey: '凝血神剑',
      pointer,
      data: { 类型: '剑法/指法', 品阶: '顶尖', 阶段: '小成' },
    },
    generation: false,
    writes: 0,
    puts: 0,
    snapshots: 0,
  };
  state.variables.stat_data = clone(state.statData);

  const deps = {
    refreshSnapshot: async () => ({
      scopeKey: state.scopeKey,
      messageId: state.messageId,
      statData: clone(state.statData),
      variables: clone(state.variables),
    }),
    getArchiveById: async id => id === state.record.id ? clone(state.record) : null,
    putArchiveRecord: async rec => {
      state.puts++;
      state.record = clone(rec);
    },
    getVab: () => ({
      saveSnapshot: async reason => {
        state.snapshots++;
        return { scopeKey: state.scopeKey, statData: clone(state.statData), reason };
      },
      refreshCurrent: async () => {},
    }),
    getMvu: () => ({
      replaceMvuData: async (vars, target) => {
        assert.equal(target.message_id, state.messageId);
        state.writes++;
        state.variables = clone(vars);
        state.statData = clone(vars.stat_data);
      },
    }),
    generationFlags: async () => ({ active: state.generation, isSendPress: state.generation, isGroupGenerating: false }),
  };

  return { state, deps, pointer, io: createRehydrationLiveIo(deps) };
}

// 1. Adapter can read archive only inside the requested scope.
{
  const { io } = makeHarness();
  const ok = await io.getArchive('arc-live-1', 'scope-A');
  assert.equal(ok.childKey, '凝血神剑');
  assert.equal(await io.getArchive('arc-live-1', 'scope-B'), null);
}

// 2. Snapshot delegates to VAB and stays explicit.
{
  const { io, state } = makeHarness();
  const snap = await io.saveSnapshot({}, 'contract-test');
  assert.equal(state.snapshots, 1);
  assert.equal(snap.reason, 'contract-test');
}

// 3. Normal guarded MVU write preserves unrelated variable fields.
{
  const { io, state, pointer } = makeHarness();
  const fresh = await io.refresh();
  await io.writeMerged(pointer, { 类型: '剑法/指法', 品阶: '顶尖', 阶段: '圆满', 最近使用: '当前剧情' }, fresh);
  assert.equal(state.writes, 1);
  assert.equal(state.variables.other.keep, true);
  assert.equal(get(state.statData, pointer).阶段, '圆满');
  assert.equal(get(state.statData, pointer).类型, '剑法/指法');
}

// 4. A hot-node race between planning and writing is refused.
{
  const { io, state, pointer } = makeHarness();
  const fresh = await io.refresh();
  set(state.statData, pointer, { 阶段: '剧情刚刚又突破' });
  state.variables.stat_data = clone(state.statData);
  await assert.rejects(() => io.writeMerged(pointer, { 阶段: '旧计划' }, fresh), /竞态/);
  assert.equal(state.writes, 0);
}

// 5. Scope switch is refused before write.
{
  const { io, state, pointer } = makeHarness();
  const fresh = await io.refresh();
  state.scopeKey = 'scope-B';
  await assert.rejects(() => io.writeMerged(pointer, { 阶段: '不应写入' }, fresh), /scope已变化/);
  assert.equal(state.writes, 0);
}

// 6. New MVU message floor is refused before write.
{
  const { io, state, pointer } = makeHarness();
  const fresh = await io.refresh();
  state.messageId = 13;
  await assert.rejects(() => io.writeMerged(pointer, { 阶段: '不应写入' }, fresh), /楼层已变化/);
  assert.equal(state.writes, 0);
}

// 7. Generation in progress blocks writes.
{
  const { io, state, pointer } = makeHarness();
  const fresh = await io.refresh();
  state.generation = true;
  await assert.rejects(() => io.writeMerged(pointer, { 阶段: '不应写入' }, fresh), /正在生成消息/);
  assert.equal(state.writes, 0);
}

// 8. Mark-restored commits only the matching archived record.
{
  const { io, state } = makeHarness();
  const record = await io.getArchive('arc-live-1', 'scope-A');
  await io.markRestored(record, { mode: 'merge-hot-over-cold' });
  assert.equal(state.puts, 1);
  assert.equal(state.record.status, 'restored');
  assert.equal(state.record.rehydratedMeta.mode, 'merge-hot-over-cold');
}

// 9. Archive commit rejects a scope mismatch.
{
  const { io, state } = makeHarness();
  const record = await io.getArchive('arc-live-1', 'scope-A');
  state.scopeKey = 'scope-B';
  await assert.rejects(() => io.markRestored(record, {}), /scope已变化/);
  assert.equal(state.puts, 0);
}

// 10. Rollback restores the exact pre-write stat_data while preserving other variable buckets.
{
  const { io, state, pointer } = makeHarness();
  const beforeWrite = await io.refresh();
  set(state.statData, pointer, { 错误: true });
  state.variables.stat_data = clone(state.statData);
  state.variables.other.keep = 'still-here';
  await io.rollback({}, beforeWrite);
  assert.equal(get(state.statData, pointer).阶段, '圆满');
  assert.equal(state.variables.other.keep, 'still-here');
}

// 11. Rollback refuses to target a stale MVU floor.
{
  const { io, state } = makeHarness();
  const beforeWrite = await io.refresh();
  state.messageId = 99;
  await assert.rejects(() => io.rollback({}, beforeWrite), /旧楼层盲写/);
}

console.log(JSON.stringify({
  ok: true,
  tests: 31,
  contract: 'scope + floor + race + generation guards; explicit archive commit; guarded rollback',
}));
