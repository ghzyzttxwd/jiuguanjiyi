import assert from 'node:assert/strict';
import {
  chooseLifecycleMutation,
  isRehydrationStable,
  planSignature,
  summarizeLifecycleDecision,
  updateRehydrationObservations,
} from './auto_lifecycle_core.js';

const plan = {
  action: 'merge-hot-over-cold',
  pointer: '/人物/降臣',
  hot: { 当前地点: '主神空间', 境界: '宗师' },
  merged: { 身份: '不良人', 当前地点: '主神空间', 境界: '宗师' },
};

let tests = 0;
const ok = (value, message) => { tests++; assert.ok(value, message); };
const eq = (a, b, message) => { tests++; assert.equal(a, b, message); };

// First observation is never enough.
let obs = updateRehydrationObservations({}, [plan], 1000, { minRehydrationStableMs: 500 });
eq(obs[plan.pointer].count, 1);
eq(isRehydrationStable(plan, obs, 1000, { minRehydrationStableMs: 500 }), false);

// Second unchanged observation after stability window is eligible.
obs = updateRehydrationObservations(obs, [plan], 1700, { minRehydrationStableMs: 500 });
eq(obs[plan.pointer].count, 2);
eq(isRehydrationStable(plan, obs, 1700, { minRehydrationStableMs: 500 }), true);

// Signature changes reset the observation chain.
const changedPlan = { ...plan, hot: { 当前地点: '天山', 境界: '大宗师' }, merged: { 身份: '不良人', 当前地点: '天山', 境界: '大宗师' } };
const changedObs = updateRehydrationObservations(obs, [changedPlan], 1800, { minRehydrationStableMs: 500 });
eq(changedObs[plan.pointer].count, 1);
ok(planSignature(plan) !== planSignature(changedPlan));

// Generation, scope switches and old engine all block writes.
eq(chooseLifecycleMutation({ generationActive: true }).action, 'hold');
eq(chooseLifecycleMutation({ scopeStable: false }).action, 'hold');
eq(chooseLifecycleMutation({ legacyAutoEnabled: true }).action, 'hold');

// Cooldown blocks all MVU mutation.
eq(chooseLifecycleMutation({ now: 2000, lastMutationAt: 1500, settings: { actionCooldownMs: 1000 } }).action, 'hold');

// Rehydration waits until stable and blocks archive while waiting.
const archivePreview = {
  action: 'archive',
  container: { path: '/人物', count: 100 },
  candidate: { key: '路人甲', size: 999 },
  reason: '容量过大',
};
let d = chooseLifecycleMutation({
  rehydrationPlans: [plan],
  observations: updateRehydrationObservations({}, [plan], 1000),
  archivePreview,
  now: 1000,
  settings: { minRehydrationStableMs: 500 },
});
eq(d.action, 'wait-rehydration');

// Stable rehydration outranks archive.
const stableObs = updateRehydrationObservations(
  updateRehydrationObservations({}, [plan], 1000, { minRehydrationStableMs: 500 }),
  [plan],
  1700,
  { minRehydrationStableMs: 500 },
);
d = chooseLifecycleMutation({
  rehydrationPlans: [plan],
  observations: stableObs,
  archivePreview,
  now: 1700,
  settings: { minRehydrationStableMs: 500 },
});
eq(d.action, 'rehydrate');
eq(d.plan.pointer, '/人物/降臣');

// Archive is allowed when there is no pending reactivation.
d = chooseLifecycleMutation({ archivePreview, now: 5000, settings: { actionCooldownMs: 0 } });
eq(d.action, 'archive');
eq(d.candidate.key, '路人甲');

// The architecture must never hard-restore cold data merely because its name is mentioned.
d = chooseLifecycleMutation({
  archivePreview: { action: 'restore', record: { childKey: '女帝' }, reason: 'recent mention' },
});
eq(d.action, 'none');
eq(d.suppressed, 'mention-only-restore');
ok(String(d.reason).includes('Prompt召回'));

// No candidate -> no mutation.
eq(chooseLifecycleMutation({ archivePreview: { action: 'none', reason: '无需迁移' } }).action, 'none');

// Summary is stable enough for diagnostics.
ok(summarizeLifecycleDecision({ action: 'rehydrate', plan, reason: 'test' }).includes('/人物/降臣'));
ok(summarizeLifecycleDecision({ action: 'archive', container: { path: '/人物' }, candidate: { key: 'A' }, reason: 'test' }).includes('/人物/A'));

console.log(JSON.stringify({ ok: true, tests, architecture: 'recall != restore; rehydrate > archive; stable-observation gate' }));
