export const DEFAULT_BOOT_GUARD_SETTINGS = Object.freeze({
  healthyGraceMs: 8000,
  staleRecordMs: 24 * 60 * 60 * 1000,
  maxConsecutiveIncompleteBoots: 1,
});

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

export function normalizeBootRecord(record) {
  if (!record || typeof record !== 'object') {
    return {
      phase: 'none',
      sessionId: '',
      startedAt: 0,
      healthyAt: 0,
      stoppedAt: 0,
      incompleteBoots: 0,
      safeMode: false,
      lastError: '',
    };
  }
  const phase = ['none', 'starting', 'healthy', 'stopped', 'failed'].includes(record.phase)
    ? record.phase
    : 'none';
  return {
    phase,
    sessionId: String(record.sessionId || ''),
    startedAt: Math.max(0, Number(record.startedAt) || 0),
    healthyAt: Math.max(0, Number(record.healthyAt) || 0),
    stoppedAt: Math.max(0, Number(record.stoppedAt) || 0),
    incompleteBoots: Math.max(0, Number(record.incompleteBoots) || 0),
    safeMode: !!record.safeMode,
    lastError: String(record.lastError || ''),
  };
}

export function assessPreviousBoot(record, now = Date.now(), settings = {}) {
  const cfg = { ...DEFAULT_BOOT_GUARD_SETTINGS, ...settings };
  const prev = normalizeBootRecord(record);
  const age = prev.startedAt ? Math.max(0, now - prev.startedAt) : Infinity;
  const incomplete = prev.phase === 'starting';
  const stale = age > Math.max(60_000, Number(cfg.staleRecordMs) || DEFAULT_BOOT_GUARD_SETTINGS.staleRecordMs);
  const incompleteBoots = incomplete ? prev.incompleteBoots + 1 : prev.incompleteBoots;
  const safeMode = prev.safeMode || (incomplete && incompleteBoots >= Math.max(1, Number(cfg.maxConsecutiveIncompleteBoots) || 1));

  let reason = '上一会话没有启动异常标记';
  if (prev.safeMode) reason = '之前已经进入安全模式';
  else if (incomplete) reason = stale
    ? '检测到旧的未完成启动记录；为避免循环启动故障，保持安全模式'
    : '上一次启动在健康确认前中断；为避免再次卡启动，进入安全模式';

  return {
    previous: prev,
    incomplete,
    stale,
    incompleteBoots,
    safeMode,
    reason,
  };
}

export function decideAutoStart({ desiredEnabled = false, previousRecord = null, now = Date.now(), settings = {} } = {}) {
  if (!desiredEnabled) {
    return { allow: false, safeMode: false, reason: '用户没有开启持久自动模式' };
  }
  const assessment = assessPreviousBoot(previousRecord, now, settings);
  if (assessment.safeMode) {
    return { allow: false, safeMode: true, reason: assessment.reason, assessment };
  }
  return { allow: true, safeMode: false, reason: '允许尝试自动启动', assessment };
}

export function beginBoot(previousRecord, sessionId, now = Date.now(), settings = {}) {
  const assessment = assessPreviousBoot(previousRecord, now, settings);
  return {
    phase: 'starting',
    sessionId: String(sessionId || ''),
    startedAt: now,
    healthyAt: 0,
    stoppedAt: 0,
    incompleteBoots: assessment.incompleteBoots,
    safeMode: assessment.safeMode,
    lastError: '',
  };
}

export function markBootHealthy(record, now = Date.now()) {
  const next = normalizeBootRecord(record);
  next.phase = 'healthy';
  next.healthyAt = now;
  next.safeMode = false;
  next.incompleteBoots = 0;
  next.lastError = '';
  return next;
}

export function markBootStopped(record, now = Date.now()) {
  const next = normalizeBootRecord(record);
  next.phase = 'stopped';
  next.stoppedAt = now;
  return next;
}

export function markBootFailed(record, error, now = Date.now()) {
  const next = normalizeBootRecord(record);
  next.phase = 'failed';
  next.stoppedAt = now;
  next.safeMode = true;
  next.incompleteBoots = Math.max(1, next.incompleteBoots + 1);
  next.lastError = String(error?.message || error || 'unknown boot failure');
  return next;
}

export function clearBootSafeMode(record) {
  const next = normalizeBootRecord(record);
  next.safeMode = false;
  next.incompleteBoots = 0;
  if (next.phase === 'failed' || next.phase === 'starting') next.phase = 'stopped';
  next.lastError = '';
  return next;
}

export function shouldMarkHealthy(record, now = Date.now(), settings = {}) {
  const cfg = { ...DEFAULT_BOOT_GUARD_SETTINGS, ...settings };
  const current = normalizeBootRecord(record);
  if (current.phase !== 'starting' || !current.startedAt) return false;
  return now - current.startedAt >= Math.max(1000, Number(cfg.healthyGraceMs) || DEFAULT_BOOT_GUARD_SETTINGS.healthyGraceMs);
}

export function bootGuardSummary(record) {
  const r = normalizeBootRecord(record);
  return clone({
    phase: r.phase,
    safeMode: r.safeMode,
    incompleteBoots: r.incompleteBoots,
    startedAt: r.startedAt,
    healthyAt: r.healthyAt,
    stoppedAt: r.stoppedAt,
    lastError: r.lastError,
  });
}
