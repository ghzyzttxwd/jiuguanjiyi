import assert from 'node:assert/strict';
import {
  assessPreviousBoot,
  beginBoot,
  bootGuardSummary,
  clearBootSafeMode,
  decideAutoStart,
  markBootFailed,
  markBootHealthy,
  markBootStopped,
  shouldMarkHealthy,
} from './boot_guard_core.js';

const NOW = 1_800_000_000_000;

{
  const d = decideAutoStart({ desiredEnabled: false, previousRecord: null, now: NOW });
  assert.equal(d.allow, false);
  assert.equal(d.safeMode, false);
}

{
  const d = decideAutoStart({ desiredEnabled: true, previousRecord: { phase: 'healthy', startedAt: NOW - 50_000 }, now: NOW });
  assert.equal(d.allow, true);
  assert.equal(d.safeMode, false);
}

{
  const d = decideAutoStart({ desiredEnabled: true, previousRecord: { phase: 'starting', startedAt: NOW - 3_000, incompleteBoots: 0 }, now: NOW });
  assert.equal(d.allow, false);
  assert.equal(d.safeMode, true);
  assert.match(d.reason, /健康确认前中断/);
}

{
  const d = decideAutoStart({ desiredEnabled: true, previousRecord: { phase: 'starting', startedAt: NOW - 3 * 24 * 60 * 60 * 1000, incompleteBoots: 0 }, now: NOW });
  assert.equal(d.allow, false);
  assert.equal(d.safeMode, true);
  assert.match(d.reason, /旧的未完成启动记录/);
}

{
  const start = beginBoot({ phase: 'stopped', incompleteBoots: 0 }, 'session-a', NOW);
  assert.equal(start.phase, 'starting');
  assert.equal(start.sessionId, 'session-a');
  assert.equal(shouldMarkHealthy(start, NOW + 7_999), false);
  assert.equal(shouldMarkHealthy(start, NOW + 8_001), true);
  const healthy = markBootHealthy(start, NOW + 8_500);
  assert.equal(healthy.phase, 'healthy');
  assert.equal(healthy.safeMode, false);
  assert.equal(healthy.incompleteBoots, 0);
  const stopped = markBootStopped(healthy, NOW + 20_000);
  assert.equal(stopped.phase, 'stopped');
}

{
  const start = beginBoot(null, 'session-b', NOW);
  const failed = markBootFailed(start, new Error('boom'), NOW + 1000);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.safeMode, true);
  assert.match(failed.lastError, /boom/);
  const cleared = clearBootSafeMode(failed);
  assert.equal(cleared.safeMode, false);
  assert.equal(cleared.phase, 'stopped');
  assert.equal(cleared.incompleteBoots, 0);
}

{
  const a = assessPreviousBoot({ phase: 'starting', startedAt: NOW - 500, incompleteBoots: 3, safeMode: false }, NOW);
  assert.equal(a.incomplete, true);
  assert.equal(a.incompleteBoots, 4);
  assert.equal(a.safeMode, true);
}

{
  const s = bootGuardSummary({ phase: 'healthy', safeMode: false, incompleteBoots: 0, sessionId: 'secret-session', startedAt: NOW, healthyAt: NOW + 10 });
  assert.equal('sessionId' in s, false);
  assert.equal(s.phase, 'healthy');
}

console.log(JSON.stringify({ ok: true, tests: 8 }));
