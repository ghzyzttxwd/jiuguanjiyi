// Variable Archive Bridge v0.7.0 auto-cooling scheduler pure logic.
// Decides whether an already-validated safe-cooling plan may run automatically.
// No browser APIs and no MVU writes in this file.

export const DEFAULT_AUTO_COOLING_POLICY = Object.freeze({
  minMessagesBeforeAuto: 20,
  minIdleMessagesSoft: 16,
  minIdleMessagesHard: 8,
  maxHeatScoreSoft: 30,
  maxHeatScoreHard: 55,
});

const RECENT_REASON_RE = /(最近对话|刚发生变量变化|近期变量变化|较近期变量变化|仍较新|最近加入|较新加入|当前\/主修\/同行\/进行中保护)/;

export function candidateIdleAge(candidate) {
  const value = Number(candidate?.ageMessages);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

export function evaluateAutoCooling({
  enabled = true,
  generationActive = false,
  messageCount = 0,
  armedMessageCount = -1,
  plan = null,
  policy = DEFAULT_AUTO_COOLING_POLICY,
} = {}) {
  if (!enabled) return { allow: false, reason: '自动降温未启用' };
  if (generationActive) return { allow: false, reason: '模型正在生成' };
  if (!plan || plan.status !== 'ready' || !plan.candidate) {
    return { allow: false, reason: plan?.reason || '当前没有可执行的降温候选' };
  }

  const count = Math.max(0, Number(messageCount) || 0);
  const armedAt = Number(armedMessageCount);
  const minMessages = Math.max(0, Number(policy?.minMessagesBeforeAuto) || 0);
  if (count < minMessages) return { allow: false, reason: `聊天楼层未达到自动降温门槛 ${minMessages}` };
  if (Number.isFinite(armedAt) && armedAt >= 0 && count <= armedAt) {
    return { allow: false, reason: '启用/切换聊天后尚未产生新的稳定消息' };
  }

  const candidate = plan.candidate;
  if (candidate.protectedNode) return { allow: false, reason: '候选属于保护节点' };
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
  if (reasons.some(x => RECENT_REASON_RE.test(String(x)))) {
    return { allow: false, reason: '候选仍有近期活跃信号' };
  }

  const hard = Math.max(0, Number(candidate.hardExceeded) || 0) > 0;
  const idleAge = candidateIdleAge(candidate);
  if (idleAge === null) return { allow: false, reason: '候选缺少可靠的闲置年龄，保守跳过' };
  const minIdle = hard
    ? Math.max(0, Number(policy?.minIdleMessagesHard) || 0)
    : Math.max(0, Number(policy?.minIdleMessagesSoft) || 0);
  if (idleAge < minIdle) return { allow: false, reason: `候选只闲置 ${idleAge} 条消息，至少需要 ${minIdle}` };

  const heat = Math.max(0, Number(candidate.heatScore) || 0);
  const maxHeat = hard
    ? Math.max(0, Number(policy?.maxHeatScoreHard) || 0)
    : Math.max(0, Number(policy?.maxHeatScoreSoft) || 0);
  if (heat > maxHeat) return { allow: false, reason: `候选热度 ${heat} 高于自动降温上限 ${maxHeat}` };

  return {
    allow: true,
    reason: hard ? '硬上限压力下的稳定冷候选' : '软上限压力下的稳定冷候选',
    hardPressure: hard,
    idleAge,
    heatScore: heat,
  };
}
