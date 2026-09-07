import { planReactivatedRecord } from './rehydration_core.js';

export class RehydrationTransactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RehydrationTransactionError';
    this.code = code;
    this.details = details;
  }
}

function jsonEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function assertIo(io) {
  const required = ['refresh', 'getArchive', 'saveSnapshot', 'writeMerged', 'readHot', 'markRestored', 'rollback'];
  for (const key of required) {
    if (typeof io?.[key] !== 'function') {
      throw new RehydrationTransactionError('bad-io', `事务适配器缺少 ${key}()`);
    }
  }
}

function scopeOf(snapshot) {
  return String(snapshot?.scopeKey || '');
}

async function guardedRefresh(io, expectedScope, phase) {
  const snapshot = await io.refresh();
  const scope = scopeOf(snapshot);
  if (!scope) throw new RehydrationTransactionError('no-scope', `${phase}：无法确定当前聊天scope`);
  if (expectedScope && scope !== expectedScope) {
    throw new RehydrationTransactionError('scope-changed', `${phase}：聊天已切换，事务中止`, {
      expectedScope,
      actualScope: scope,
      phase,
    });
  }
  if (!snapshot?.statData || typeof snapshot.statData !== 'object') {
    throw new RehydrationTransactionError('no-mvu', `${phase}：当前没有可用MVU stat_data`);
  }
  return snapshot;
}

async function rollbackSafely(io, tx, cause) {
  let rollbackError = null;
  try {
    const current = await io.refresh();
    if (scopeOf(current) !== tx.scopeKey) {
      throw new RehydrationTransactionError('rollback-scope-changed', '回滚前聊天已切换，禁止向未知scope写回快照', {
        expectedScope: tx.scopeKey,
        actualScope: scopeOf(current),
      });
    }
    await io.rollback(tx.snapshot, tx.beforeWrite);
    const verify = await io.refresh();
    if (scopeOf(verify) !== tx.scopeKey) {
      throw new RehydrationTransactionError('rollback-scope-changed', '回滚验证时聊天已切换', {
        expectedScope: tx.scopeKey,
        actualScope: scopeOf(verify),
      });
    }
    const restoredHot = await io.readHot(tx.pointer, verify);
    if (!jsonEqual(restoredHot, tx.beforeHot)) {
      throw new RehydrationTransactionError('rollback-verify-failed', '回滚后热节点与写入前不一致', {
        pointer: tx.pointer,
      });
    }
  } catch (error) {
    rollbackError = error;
  }

  if (rollbackError) {
    throw new RehydrationTransactionError('rollback-failed', `事务失败且回滚未能验证：${rollbackError?.message || rollbackError}`, {
      cause: cause?.message || String(cause),
      rollback: rollbackError?.message || String(rollbackError),
      pointer: tx.pointer,
    });
  }
}

export async function executeRehydrationTransaction(io, recordId, options = {}) {
  assertIo(io);
  const started = await guardedRefresh(io, '', '事务开始');
  const scopeKey = scopeOf(started);
  const record = await io.getArchive(recordId, scopeKey);
  if (!record) {
    throw new RehydrationTransactionError('archive-missing', '找不到冷档案记录', { recordId, scopeKey });
  }
  if (record.status !== 'archived') {
    return { status: 'noop', reason: '档案已不是 archived 状态', recordId, scopeKey };
  }

  let plan = planReactivatedRecord(record, started.statData, options);
  if (!plan) {
    return { status: 'noop', reason: '目标节点当前并未重新成为热变量', recordId, scopeKey };
  }

  // Cases that need no MVU mutation: current hot state is already authoritative.
  if (plan.action === 'mark-restored' || plan.action === 'keep-hot-mark-restored' || jsonEqual(plan.merged, plan.hot)) {
    await guardedRefresh(io, scopeKey, '标记前');
    await io.markRestored(record, {
      mode: plan.action,
      pointer: plan.pointer,
      merged: plan.merged,
    });
    return {
      status: 'restored-without-write',
      mode: plan.action,
      pointer: plan.pointer,
      scopeKey,
      wroteMvu: false,
    };
  }

  // The only write path is object merge. Snapshot first, then refresh/re-plan so
  // any state changes that happened while snapshotting are preserved as hot winners.
  const snapshot = await io.saveSnapshot(started, 'before-rehydration-merge');
  const fresh = await guardedRefresh(io, scopeKey, '写入前复核');
  const freshRecord = await io.getArchive(recordId, scopeKey);
  if (!freshRecord || freshRecord.status !== 'archived') {
    return { status: 'noop', reason: '写入前档案状态已变化', recordId, scopeKey };
  }

  plan = planReactivatedRecord(freshRecord, fresh.statData, options);
  if (!plan) {
    return { status: 'noop', reason: '写入前热节点已消失，放弃本次重激活', recordId, scopeKey };
  }
  if (plan.action !== 'merge-hot-over-cold' || jsonEqual(plan.merged, plan.hot)) {
    await io.markRestored(freshRecord, {
      mode: plan.action,
      pointer: plan.pointer,
      merged: plan.merged,
    });
    return {
      status: 'restored-without-write',
      mode: plan.action,
      pointer: plan.pointer,
      scopeKey,
      wroteMvu: false,
    };
  }

  const tx = {
    scopeKey,
    pointer: plan.pointer,
    snapshot,
    beforeWrite: fresh,
    beforeHot: plan.hot,
    intended: plan.merged,
  };

  try {
    await io.writeMerged(plan.pointer, plan.merged, fresh);
    const verify = await guardedRefresh(io, scopeKey, '写入后验证');
    const actual = await io.readHot(plan.pointer, verify);
    if (!jsonEqual(actual, plan.merged)) {
      throw new RehydrationTransactionError('verify-failed', '写入后节点与预期合并结果不一致', {
        pointer: plan.pointer,
      });
    }

    try {
      await io.markRestored(freshRecord, {
        mode: 'merge-hot-over-cold',
        pointer: plan.pointer,
        merged: plan.merged,
      });
    } catch (error) {
      throw new RehydrationTransactionError('archive-commit-failed', `MVU已验证，但冷档案状态提交失败：${error?.message || error}`, {
        pointer: plan.pointer,
      });
    }

    return {
      status: 'committed',
      mode: 'merge-hot-over-cold',
      pointer: plan.pointer,
      scopeKey,
      wroteMvu: true,
      merged: plan.merged,
    };
  } catch (error) {
    await rollbackSafely(io, tx, error);
    if (error instanceof RehydrationTransactionError) throw error;
    throw new RehydrationTransactionError('write-failed', `重激活写入失败并已回滚：${error?.message || error}`, {
      pointer: plan.pointer,
    });
  }
}
