export function assessMasterPreflight({
  hasMvu = false,
  legacyAutoEnabled = false,
  smartHostEnabled = false,
  manualRehydrationArmed = false,
  recallMode = 'auto-prompt',
} = {}) {
  if (!hasMvu) return { ok: false, code: 'no-mvu', reason: '当前没有可管理的MVU' };
  if (legacyAutoEnabled) return { ok: false, code: 'legacy-auto', reason: '旧版自动归档总开关仍开启' };
  if (smartHostEnabled) return { ok: false, code: 'smart-host-on', reason: '旧智能托管候选仍开启，禁止双写引擎' };
  if (manualRehydrationArmed) return { ok: false, code: 'manual-writer-armed', reason: '手动重激活写入仍处于武装状态' };
  if (recallMode === 'blocked-collision') return { ok: false, code: 'recall-collision', reason: '冷档案Prompt召回通道存在不可安全处理的冲突' };
  return { ok: true, code: 'ok', reason: '统一记忆托管预检通过' };
}

export async function enableMasterStack({
  preflight,
  enableRecall,
  disableRecall,
  enableLifecycle,
  disableLifecycle,
} = {}) {
  if (!preflight?.ok) {
    return { ok: false, stage: 'preflight', reason: preflight?.reason || '预检失败', rolledBack: false };
  }
  if ([enableRecall, disableRecall, enableLifecycle, disableLifecycle].some(fn => typeof fn !== 'function')) {
    return { ok: false, stage: 'contract', reason: '主控组件契约不完整', rolledBack: false };
  }

  let recallOn = false;
  let lifecycleOn = false;
  try {
    recallOn = !!(await enableRecall());
    if (!recallOn) {
      return { ok: false, stage: 'recall', reason: 'Prompt召回协调器未能开启', rolledBack: false };
    }

    lifecycleOn = !!(await enableLifecycle());
    if (!lifecycleOn) {
      await disableRecall();
      return { ok: false, stage: 'lifecycle', reason: '生命周期托管未能开启或用户取消确认', rolledBack: true };
    }

    return { ok: true, stage: 'ready', reason: '召回与生命周期托管均已开启', rolledBack: false };
  } catch (error) {
    let rollbackError = null;
    try { if (lifecycleOn) await disableLifecycle(); } catch (e) { rollbackError = e; }
    try { if (recallOn) await disableRecall(); } catch (e) { rollbackError ||= e; }
    return {
      ok: false,
      stage: 'exception',
      reason: error?.message || String(error),
      rolledBack: recallOn || lifecycleOn,
      rollbackError: rollbackError?.message || (rollbackError ? String(rollbackError) : ''),
    };
  }
}

export async function disableMasterStack({ disableRecall, disableLifecycle } = {}) {
  const errors = [];
  if (typeof disableLifecycle === 'function') {
    try { await disableLifecycle(); } catch (error) { errors.push(`lifecycle:${error?.message || error}`); }
  }
  if (typeof disableRecall === 'function') {
    try { await disableRecall(); } catch (error) { errors.push(`recall:${error?.message || error}`); }
  }
  return {
    ok: errors.length === 0,
    errors,
    reason: errors.length ? `关闭过程中出现异常：${errors.join('；')}` : '统一记忆托管已关闭',
  };
}

export function assessMasterHealth({
  masterEnabled = false,
  recallEnabled = false,
  lifecycleEnabled = false,
} = {}) {
  if (!masterEnabled) return { healthy: true, action: 'none', reason: '主控未启用' };
  if (recallEnabled && lifecycleEnabled) return { healthy: true, action: 'none', reason: '两个子系统均正常' };

  const missing = [];
  if (!recallEnabled) missing.push('Prompt召回');
  if (!lifecycleEnabled) missing.push('生命周期托管');
  return {
    healthy: false,
    action: 'fail-closed',
    reason: `${missing.join('、')}已退出，主控必须联动关闭全部自动功能`,
  };
}
