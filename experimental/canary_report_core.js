function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value) { return !!value; }

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function pickRuntime(runtime = {}) {
  return {
    mounted: bool(runtime.mounted),
    enabled: bool(runtime.enabled ?? runtime.masterEnabled),
    busy: bool(runtime.busy),
    generationActive: bool(runtime.generationFlag ?? runtime.generationActive),
    eventBindings: Math.max(0, finite(runtime.eventBindings)),
    scheduled: bool(runtime.scheduled ?? runtime.healthScheduled),
    recentErrors: Math.max(0, finite(runtime.recentErrors)),
    failClosedCount: Math.max(0, finite(runtime.failClosedCount)),
    healthCheckCount: Math.max(0, finite(runtime.healthCheckCount)),
    observationCount: Math.max(0, finite(runtime.observationCount)),
    lastMutationMessageCount: finite(runtime.lastMutationMessageCount, -1),
  };
}

export function buildCanaryReport({
  generatedAt = Date.now(),
  app = {},
  vab = {},
  recall = {},
  lifecycle = {},
  master = {},
  bootGuard = null,
} = {}) {
  const report = {
    format: 'vab-canary-report',
    version: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    app: {
      userAgent: cleanText(app.userAgent, 240),
      visibility: cleanText(app.visibility, 30),
      online: app.online === undefined ? null : bool(app.online),
    },
    core: {
      version: cleanText(vab.version, 40),
      hasMvu: bool(vab.hasMvu),
      mvuBytes: Math.max(0, finite(vab.mvuBytes)),
      mvuNodes: Math.max(0, finite(vab.mvuNodes)),
      archiveCount: Math.max(0, finite(vab.archiveCount)),
      snapshotCount: Math.max(0, finite(vab.snapshotCount)),
      coreBusy: bool(vab.busy),
      lastError: cleanText(vab.lastError, 300),
    },
    recall: {
      version: cleanText(recall.version, 40),
      enabled: bool(recall.enabled),
      decisionMode: cleanText(recall.decisionMode, 80),
      status: cleanText(recall.status, 300),
      maxRecords: Math.max(0, finite(recall.maxRecords)),
      maxChars: Math.max(0, finite(recall.maxChars)),
    },
    lifecycle: {
      version: cleanText(lifecycle.version, 40),
      status: cleanText(lifecycle.status, 300),
      runtime: pickRuntime(lifecycle.runtime),
    },
    master: {
      version: cleanText(master.version, 40),
      status: cleanText(master.status, 300),
      runtime: pickRuntime(master.runtime),
      health: master.health ? {
        healthy: bool(master.health.healthy),
        action: cleanText(master.health.action, 60),
        reason: cleanText(master.health.reason, 240),
      } : null,
      preflight: master.preflight ? {
        ok: bool(master.preflight.ok),
        code: cleanText(master.preflight.code, 80),
        reason: cleanText(master.preflight.reason, 240),
      } : null,
    },
    bootGuard: bootGuard ? {
      phase: cleanText(bootGuard.phase, 40),
      safeMode: bool(bootGuard.safeMode),
      incompleteBoots: Math.max(0, finite(bootGuard.incompleteBoots)),
      lastError: cleanText(bootGuard.lastError, 240),
    } : null,
  };

  // Deliberately no card name, chat text, archive content, child keys, prompt text, or raw scope IDs.
  return report;
}

export function summarizeCanaryReport(report) {
  const r = report || {};
  const flags = [];
  if (!r.core?.hasMvu) flags.push('无MVU');
  if (r.core?.lastError) flags.push('核心有错误');
  if (r.master?.runtime?.recentErrors > 0 || r.lifecycle?.runtime?.recentErrors > 0) flags.push('近期异常');
  if (r.master?.runtime?.failClosedCount > 0) flags.push('发生过fail-closed');
  if (r.bootGuard?.safeMode) flags.push('启动安全模式');
  const state = r.master?.runtime?.enabled ? '主控开启' : '主控关闭';
  return `${state} · MVU ${r.core?.mvuBytes || 0}B/${r.core?.mvuNodes || 0}节点 · 冷档案${r.core?.archiveCount || 0} · ${flags.length ? flags.join('、') : '未发现诊断红旗'}`;
}
