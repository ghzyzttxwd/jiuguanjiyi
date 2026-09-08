import assert from 'node:assert/strict';
import { buildCanaryReport, summarizeCanaryReport } from './canary_report_core.js';

const report = buildCanaryReport({
  generatedAt: 1_800_000_000_000,
  app: { userAgent: 'Android Test', visibility: 'visible', online: true },
  vab: {
    version: '0.1.4', hasMvu: true, mvuBytes: 9100, mvuNodes: 266, archiveCount: 12,
    snapshotCount: 20, busy: false, lastError: '', cardName: '绝不能泄露', chatText: '秘密剧情', scopeKey: 'secret-scope',
  },
  recall: {
    version: '0.2.0-rc3', enabled: true, decisionMode: 'auto-prompt', status: '正常',
    maxRecords: 6, maxChars: 9000, previewText: '不要进入报告',
  },
  lifecycle: {
    version: '0.2.0-rc2', status: '正常', runtime: { mounted: true, enabled: true, eventBindings: 6, recentErrors: 0, lastMutationMessageCount: 132 },
  },
  master: {
    version: '0.2.0-rc3', status: '主控正常', runtime: { mounted: true, masterEnabled: true, eventBindings: 6, healthCheckCount: 9, failClosedCount: 0 },
    health: { healthy: true, action: 'none', reason: '两个子系统均正常' },
    preflight: { ok: true, code: 'ok', reason: '通过' },
  },
  bootGuard: { phase: 'healthy', safeMode: false, incompleteBoots: 0, lastError: '', sessionId: 'secret-session' },
});

assert.equal(report.format, 'vab-canary-report');
assert.equal(report.core.mvuBytes, 9100);
assert.equal(report.master.runtime.enabled, true);
assert.equal(report.master.health.healthy, true);
assert.equal(report.bootGuard.phase, 'healthy');

const serialized = JSON.stringify(report);
for (const forbidden of ['绝不能泄露', '秘密剧情', 'secret-scope', 'secret-session', '不要进入报告']) {
  assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`);
}

const summary = summarizeCanaryReport(report);
assert.match(summary, /主控开启/);
assert.match(summary, /冷档案12/);
assert.match(summary, /未发现诊断红旗/);

const bad = buildCanaryReport({
  vab: { hasMvu: false, lastError: 'core error' },
  master: { runtime: { masterEnabled: true, failClosedCount: 1 } },
  lifecycle: { runtime: { recentErrors: 2 } },
  bootGuard: { safeMode: true },
});
const badSummary = summarizeCanaryReport(bad);
assert.match(badSummary, /无MVU/);
assert.match(badSummary, /核心有错误/);
assert.match(badSummary, /近期异常/);
assert.match(badSummary, /fail-closed/);
assert.match(badSummary, /启动安全模式/);

console.log(JSON.stringify({ ok: true, tests: 14, privacyFieldsExcluded: true }));
