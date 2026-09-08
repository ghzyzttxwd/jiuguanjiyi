import assert from 'node:assert/strict';
import {
  assessMasterHealth,
  assessMasterPreflight,
  disableMasterStack,
  enableMasterStack,
} from './memory_master_core.js';

let tests = 0;
const ok = (value, message) => { tests++; assert.ok(value, message); };
const eq = (actual, expected, message) => { tests++; assert.equal(actual, expected, message); };

// Preflight gates.
{
  eq(assessMasterPreflight({}).code, 'no-mvu');
  eq(assessMasterPreflight({ hasMvu: true, legacyAutoEnabled: true }).code, 'legacy-auto');
  eq(assessMasterPreflight({ hasMvu: true, smartHostEnabled: true }).code, 'smart-host-on');
  eq(assessMasterPreflight({ hasMvu: true, manualRehydrationArmed: true }).code, 'manual-writer-armed');
  eq(assessMasterPreflight({ hasMvu: true, recallMode: 'blocked-collision' }).code, 'recall-collision');
  ok(assessMasterPreflight({ hasMvu: true, recallMode: 'legacy-macro' }).ok, 'legacy macro is a safe coordinated mode');
  ok(assessMasterPreflight({ hasMvu: true, recallMode: 'auto-prompt' }).ok, 'auto prompt is safe');
}

// Happy-path activation order is recall -> lifecycle.
{
  const order = [];
  const result = await enableMasterStack({
    preflight: { ok: true },
    enableRecall: async () => { order.push('recall-on'); return true; },
    disableRecall: async () => { order.push('recall-off'); return true; },
    enableLifecycle: async () => { order.push('lifecycle-on'); return true; },
    disableLifecycle: async () => { order.push('lifecycle-off'); return true; },
  });
  ok(result.ok);
  eq(order.join(','), 'recall-on,lifecycle-on');
}

// User cancels lifecycle confirmation -> recall is rolled back.
{
  const order = [];
  const result = await enableMasterStack({
    preflight: { ok: true },
    enableRecall: async () => { order.push('recall-on'); return true; },
    disableRecall: async () => { order.push('recall-off'); return true; },
    enableLifecycle: async () => { order.push('lifecycle-cancel'); return false; },
    disableLifecycle: async () => { order.push('lifecycle-off'); return true; },
  });
  ok(!result.ok);
  eq(result.stage, 'lifecycle');
  ok(result.rolledBack);
  eq(order.join(','), 'recall-on,lifecycle-cancel,recall-off');
}

// Recall failure means lifecycle never starts.
{
  let lifecycleCalls = 0;
  const result = await enableMasterStack({
    preflight: { ok: true },
    enableRecall: async () => false,
    disableRecall: async () => true,
    enableLifecycle: async () => { lifecycleCalls++; return true; },
    disableLifecycle: async () => true,
  });
  ok(!result.ok);
  eq(result.stage, 'recall');
  eq(lifecycleCalls, 0);
}

// Exception after recall activation fails closed and rolls recall back.
{
  const order = [];
  const result = await enableMasterStack({
    preflight: { ok: true },
    enableRecall: async () => { order.push('recall-on'); return true; },
    disableRecall: async () => { order.push('recall-off'); },
    enableLifecycle: async () => { throw new Error('simulated lifecycle fault'); },
    disableLifecycle: async () => { order.push('lifecycle-off'); },
  });
  ok(!result.ok);
  eq(result.stage, 'exception');
  ok(result.rolledBack);
  eq(order.join(','), 'recall-on,recall-off');
}

// Disable order stops writer first, then prompt recall.
{
  const order = [];
  const result = await disableMasterStack({
    disableLifecycle: async () => order.push('lifecycle-off'),
    disableRecall: async () => order.push('recall-off'),
  });
  ok(result.ok);
  eq(order.join(','), 'lifecycle-off,recall-off');
}

// Health is fail-closed if either delegate exits.
{
  ok(assessMasterHealth({ masterEnabled: true, recallEnabled: true, lifecycleEnabled: true }).healthy);
  const recallGone = assessMasterHealth({ masterEnabled: true, recallEnabled: false, lifecycleEnabled: true });
  ok(!recallGone.healthy);
  eq(recallGone.action, 'fail-closed');
  const lifecycleGone = assessMasterHealth({ masterEnabled: true, recallEnabled: true, lifecycleEnabled: false });
  ok(!lifecycleGone.healthy);
  eq(lifecycleGone.action, 'fail-closed');
  ok(assessMasterHealth({ masterEnabled: false, recallEnabled: false, lifecycleEnabled: false }).healthy);
}

console.log(JSON.stringify({
  ok: true,
  tests,
  model: 'preflight -> recall -> lifecycle -> fail-closed health coupling',
}));
