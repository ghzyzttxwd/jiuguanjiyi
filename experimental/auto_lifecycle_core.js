import { stableHash } from './smart_host_core.js';

export const DEFAULT_LIFECYCLE_SETTINGS = Object.freeze({
  minRehydrationObservations: 2,
  minRehydrationStableMs: 1200,
  actionCooldownMs: 30000,
  observationTtlMs: 5 * 60 * 1000,
});

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

export function planSignature(plan) {
  if (!plan?.pointer) return '';
  return `${plan.pointer}:${stableHash({ action: plan.action, hot: plan.hot, merged: plan.merged })}`;
}

export function updateRehydrationObservations(previous = {}, plans = [], now = Date.now(), settings = {}) {
  const cfg = { ...DEFAULT_LIFECYCLE_SETTINGS, ...settings };
  const next = {};
  const live = new Set();

  for (const plan of plans || []) {
    if (!plan?.pointer) continue;
    const signature = planSignature(plan);
    if (!signature) continue;
    live.add(plan.pointer);
    const prior = previous?.[plan.pointer];
    if (prior && prior.signature === signature && now - Number(prior.lastSeenAt || 0) <= cfg.observationTtlMs) {
      next[plan.pointer] = {
        signature,
        count: Number(prior.count || 0) + 1,
        firstSeenAt: Number(prior.firstSeenAt || now),
        lastSeenAt: now,
      };
    } else {
      next[plan.pointer] = {
        signature,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }
  }

  // Do not keep observations for nodes that are no longer reactivation candidates.
  for (const [pointer, obs] of Object.entries(previous || {})) {
    if (live.has(pointer)) continue;
    if (now - Number(obs?.lastSeenAt || 0) > cfg.observationTtlMs) continue;
  }

  return next;
}

export function isRehydrationStable(plan, observations = {}, now = Date.now(), settings = {}) {
  const cfg = { ...DEFAULT_LIFECYCLE_SETTINGS, ...settings };
  if (!plan?.pointer) return false;
  const obs = observations?.[plan.pointer];
  if (!obs || obs.signature !== planSignature(plan)) return false;
  if (Number(obs.count || 0) < Math.max(2, Number(cfg.minRehydrationObservations) || 2)) return false;
  return now - Number(obs.firstSeenAt || now) >= Math.max(0, Number(cfg.minRehydrationStableMs) || 0);
}

export function chooseLifecycleMutation({
  generationActive = false,
  scopeStable = true,
  legacyAutoEnabled = false,
  rehydrationPlans = [],
  observations = {},
  archivePreview = null,
  now = Date.now(),
  lastMutationAt = 0,
  settings = {},
} = {}) {
  const cfg = { ...DEFAULT_LIFECYCLE_SETTINGS, ...settings };

  if (generationActive) return { action: 'hold', reason: '模型正在生成，禁止修改MVU' };
  if (!scopeStable) return { action: 'hold', reason: '聊天scope刚变化，等待下一次稳定事件' };
  if (legacyAutoEnabled) return { action: 'hold', reason: '旧自动归档引擎仍开启，禁止双引擎并发' };
  if (lastMutationAt && now - lastMutationAt < Math.max(0, Number(cfg.actionCooldownMs) || 0)) {
    return { action: 'hold', reason: '仍在变量写入冷却期' };
  }

  const firstPlan = (rehydrationPlans || [])[0] || null;
  if (firstPlan) {
    if (!isRehydrationStable(firstPlan, observations, now, cfg)) {
      return {
        action: 'wait-rehydration',
        plan: firstPlan,
        reason: '检测到冷档案节点重新进入热区，先等待连续稳定观察；期间不做归档写入',
      };
    }
    return {
      action: 'rehydrate',
      plan: firstPlan,
      reason: '重激活节点已连续稳定，优先完成冷历史补缺/状态收口',
    };
  }

  // A mention-only "restore" suggestion from older smart-host experiments is intentionally ignored.
  // Cold data should be recalled into the prompt, not hard-restored into MVU merely because its name was mentioned.
  if (archivePreview?.action === 'restore') {
    return {
      action: 'none',
      reason: '仅命中冷档案提及：禁止硬恢复，交给Prompt召回层处理',
      suppressed: 'mention-only-restore',
    };
  }

  if (archivePreview?.action === 'archive' && archivePreview?.container && archivePreview?.candidate) {
    return {
      action: 'archive',
      container: clone(archivePreview.container),
      candidate: clone(archivePreview.candidate),
      reason: archivePreview.reason || '热区达到容量/闲置阈值',
    };
  }

  return { action: 'none', reason: archivePreview?.reason || '当前无需MVU生命周期迁移' };
}

export function summarizeLifecycleDecision(decision) {
  if (!decision) return '无生命周期决策';
  if (decision.action === 'rehydrate') return `rehydrate · ${decision.plan?.pointer || '未知路径'} · ${decision.reason}`;
  if (decision.action === 'wait-rehydration') return `wait-rehydration · ${decision.plan?.pointer || '未知路径'} · ${decision.reason}`;
  if (decision.action === 'archive') return `archive · ${decision.container?.path || ''}/${decision.candidate?.key || ''} · ${decision.reason}`;
  return `${decision.action} · ${decision.reason || ''}`;
}
