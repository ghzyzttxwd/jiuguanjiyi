import {
  DEFAULT_SMART_HOST_SETTINGS,
  collectHotAnchorText,
  discoverContainers,
  selectArchiveCandidate,
  updateActivity,
} from './smart_host_core.js';
import { buildRehydrationPlans } from './rehydration_core.js';
import { executeRehydrationTransaction } from './rehydration_transaction.js';
import { createRehydrationLiveIo, isGenerationActive } from './rehydration_live_adapter.js';
import { SmartHostSafeDiagnostics } from './smart_host_safe.js';
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  chooseLifecycleMutation,
  summarizeLifecycleDecision,
  updateRehydrationObservations,
} from './auto_lifecycle_core.js';

const VERSION = '0.2.0-rc3';
const TRIGGER_DELAY_MS = 1800;
const STABLE_RECHECK_MS = 1400;
const UI_INTERVAL_MS = 4000;
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERRORS_IN_WINDOW = 3;
const ACTIVITY_KEY = 'vab.autoLifecycle.rc.activity.v1';

let mounted = false;
let enabled = false; // session-only, deliberately never persisted
let busy = false;
let generationFlag = false;
let scheduledTimer = null;
let uiTimer = null;
let eventBindings = [];
let statusText = '未启用 · 不会自动修改MVU';
let lastDecision = null;
let lastMutationAt = 0;
let lastMutationMessageCount = -1;
let lastScopeKey = '';
let observations = {};
let errorTimes = [];

const smartSettings = {
  ...DEFAULT_SMART_HOST_SETTINGS,
  minMessagesBeforeArchive: 60,
  minIdleMessages: 40,
  minChildren: 30,
  targetChildren: 20,
  minContainerBytes: 12 * 1024,
};

const lifecycleSettings = {
  ...DEFAULT_LIFECYCLE_SETTINGS,
  minRehydrationObservations: 2,
  minRehydrationStableMs: 1200,
  actionCooldownMs: 30000,
};

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function loadActivity() {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let activity = loadActivity();

function saveActivity() {
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity)); } catch {}
}

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function getVab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function state() {
  return getVab()?.getState?.() || null;
}

function messageCount() {
  return ctx()?.chat?.length ?? 0;
}

function recentContextText(count = 8) {
  return (ctx()?.chat || [])
    .filter(m => m && typeof m.mes === 'string')
    .slice(-Math.max(1, Number(count) || 1))
    .map(m => String(m.mes || ''))
    .join('\n');
}

function protectionText(statData) {
  return [recentContextText(8), collectHotAnchorText(statData)].filter(Boolean).join('\n');
}

function scopeActivity(scopeKey) {
  return activity[scopeKey] ||= {};
}

function refreshActivityAndArchivePreview(s) {
  const stat = s?.latestMvu?.statData;
  const scopeKey = s?.current?.scopeKey;
  if (!stat || !scopeKey) return { action: 'none', reason: '当前没有MVU' };

  const containers = discoverContainers(stat, smartSettings);
  const prior = scopeActivity(scopeKey);
  const next = updateActivity({
    containers,
    prior,
    messageCount: messageCount(),
  });
  activity[scopeKey] = next;
  saveActivity();

  const text = protectionText(stat);
  for (const container of containers) {
    const candidate = selectArchiveCandidate({
      container,
      activity: next[container.path] || {},
      messageCount: messageCount(),
      recentText: text,
      settings: smartSettings,
    });
    if (candidate) {
      return {
        action: 'archive',
        container: { path: container.path, count: container.count, size: container.size },
        candidate,
        reason: `${container.path} 达到容量与闲置阈值`,
      };
    }
  }

  return { action: 'none', reason: '当前无需热→冷迁移' };
}

function buildRehydration(s) {
  return buildRehydrationPlans({
    archives: (s?.archiveCache || []).filter(r => r?.status === 'archived'),
    statData: s?.latestMvu?.statData || null,
    settings: { maxPlansPerCycle: 1 },
  });
}

function dualEngineEnabled(s) {
  const legacy = !!s?.settings?.autoArchiveGlobal;
  const experimentalSmart = !!SmartHostSafeDiagnostics?.getSettings?.()?.enabled;
  return legacy || experimentalSmart;
}

function clearScheduled() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}

function scheduleCycle(delay = TRIGGER_DELAY_MS) {
  clearScheduled();
  if (!mounted || !enabled || generationFlag) return;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    runCycle().catch(error => console.warn('[VAB AutoLifecycle RC]', error));
  }, Math.max(300, Number(delay) || TRIGGER_DELAY_MS));
}

function recordFailure(error) {
  const now = Date.now();
  errorTimes = errorTimes.filter(t => now - t <= ERROR_WINDOW_MS);
  errorTimes.push(now);
  if (errorTimes.length >= MAX_ERRORS_IN_WINDOW) {
    enabled = false;
    clearScheduled();
    statusText = `熔断：10分钟内异常${errorTimes.length}次，自动生命周期托管已关闭。最后错误：${error?.message || error}`;
    return true;
  }
  return false;
}

async function refreshStableState() {
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) throw new Error('变量归档桥核心未就绪');
  await vab.refreshCurrent({ render: false });
  return state();
}

async function runCycle({ forcePreview = false } = {}) {
  if (busy) return null;
  if (!enabled && !forcePreview) return null;

  busy = true;
  try {
    const generationActive = generationFlag || await isGenerationActive();
    const s = await refreshStableState();
    const scopeKey = String(s?.current?.scopeKey || '');
    const currentMessages = messageCount();
    if (!scopeKey || !s?.latestMvu?.statData) {
      statusText = '当前没有可管理的MVU';
      lastDecision = { action: 'none', reason: statusText };
      return lastDecision;
    }

    const scopeStable = !lastScopeKey || lastScopeKey === scopeKey;
    if (lastScopeKey !== scopeKey) {
      lastScopeKey = scopeKey;
      observations = {};
      lastMutationMessageCount = -1;
    }

    const rehydrationPlans = buildRehydration(s);
    observations = updateRehydrationObservations(observations, rehydrationPlans, Date.now(), lifecycleSettings);
    const archivePreview = refreshActivityAndArchivePreview(s);

    const decision = chooseLifecycleMutation({
      generationActive,
      scopeStable,
      legacyAutoEnabled: dualEngineEnabled(s),
      rehydrationPlans,
      observations,
      archivePreview,
      now: Date.now(),
      lastMutationAt,
      settings: lifecycleSettings,
    });
    lastDecision = decision;
    statusText = summarizeLifecycleDecision(decision);

    if (forcePreview || !enabled) return decision;

    if (lastMutationMessageCount === currentMessages && ['rehydrate', 'archive'].includes(decision.action)) {
      statusText = '同一消息计数已经执行过一次生命周期迁移，本轮跳过';
      return { action: 'hold', reason: statusText };
    }

    if (decision.action === 'wait-rehydration') {
      scheduleCycle(STABLE_RECHECK_MS);
      return decision;
    }

    if (decision.action === 'rehydrate') {
      const recordId = decision.plan?.record?.id;
      if (!recordId) throw new Error('重激活计划缺少冷档案ID');
      const io = createRehydrationLiveIo();
      // Generic automatic mode is intentionally conservative: current hot MVU is authoritative.
      // It may close an obsolete cold version, but it never resurrects cold-only fields into MVU.
      const result = await executeRehydrationTransaction(io, recordId, { autoConservative: true });
      lastMutationAt = Date.now();
      lastMutationMessageCount = messageCount();
      observations = {};
      errorTimes = [];
      if (result.mode === 'auto-conservative-hot-authoritative') {
        statusText = `✅ 自动重激活安全收口：${result.pointer} · 当前热状态优先，未回灌 ${result.coldOnlyFieldsSkipped || 0} 个冷旧字段`;
      } else {
        statusText = result.status === 'committed'
          ? `✅ 自动重激活完成并验证：${result.pointer}`
          : `✅ 重激活收口完成：${result.pointer || result.reason || result.status}`;
      }
      return { action: 'rehydrated', result };
    }

    if (decision.action === 'archive') {
      const vab = getVab();
      if (!vab?.archiveChild) throw new Error('归档API不可用');
      await vab.archiveChild(decision.container.path, decision.candidate.key, { automatic: true });
      lastMutationAt = Date.now();
      lastMutationMessageCount = messageCount();
      errorTimes = [];
      statusText = `✅ 自动归档完成：${decision.container.path}/${decision.candidate.key}`;
      return { action: 'archived', pointer: `${decision.container.path}/${decision.candidate.key}` };
    }

    return decision;
  } catch (error) {
    const fused = recordFailure(error);
    if (!fused) statusText = `异常：${error?.message || error} · 已记录，达到3次将自动熔断`;
    console.warn('[VAB AutoLifecycle RC]', error);
    return { action: 'error', error: error?.message || String(error) };
  } finally {
    busy = false;
    updateUi();
  }
}

function bindEvent(name, handler) {
  const c = ctx();
  const source = c?.eventSource;
  if (!name || !source?.on) return;
  source.on(name, handler);
  eventBindings.push({ source, name, handler });
}

function hookEvents() {
  if (eventBindings.length) return;
  const e = ctx()?.event_types || ctx()?.eventTypes || {};

  const generationStarted = () => {
    generationFlag = true;
    clearScheduled();
    if (enabled) statusText = '模型正在生成 · 生命周期托管暂停';
    updateUi();
  };
  const generationEnded = () => {
    generationFlag = false;
    if (enabled) scheduleCycle(TRIGGER_DELAY_MS);
    updateUi();
  };
  const stableMessage = () => {
    if (enabled && !generationFlag) scheduleCycle(TRIGGER_DELAY_MS);
  };
  const chatChanged = () => {
    clearScheduled();
    observations = {};
    lastScopeKey = '';
    lastMutationMessageCount = -1;
    statusText = enabled ? '聊天已切换 · 等待下一次稳定事件' : '未启用 · 不会自动修改MVU';
    updateUi();
  };

  bindEvent(e.GENERATION_STARTED, generationStarted);
  bindEvent(e.GENERATION_STOPPED, generationEnded);
  bindEvent(e.GENERATION_ENDED, generationEnded);
  bindEvent(e.CHARACTER_MESSAGE_RENDERED, stableMessage);
  bindEvent(e.MESSAGE_RECEIVED, stableMessage);
  bindEvent(e.MESSAGE_UPDATED, stableMessage);
  bindEvent(e.CHAT_CHANGED, chatChanged);
}

function unhookEvents() {
  for (const { source, name, handler } of eventBindings) {
    try { source?.removeListener?.(name, handler); } catch {}
  }
  eventBindings = [];
  generationFlag = false;
}

async function setEnabled(value, { skipConfirm = false } = {}) {
  if (!value) {
    enabled = false;
    clearScheduled();
    statusText = '未启用 · 不会自动修改MVU';
    updateUi();
    return enabled;
  }
  if (busy || await isGenerationActive()) {
    enabled = false;
    statusText = '无法开启：当前正在生成或事务执行中';
    updateUi();
    return enabled;
  }
  const s = await refreshStableState();
  if (dualEngineEnabled(s)) {
    enabled = false;
    statusText = '无法开启：旧自动归档或智能托管RC仍开启，禁止双写引擎';
    updateUi();
    return enabled;
  }
  const ok = skipConfirm || confirm([
    '这是统一自动生命周期托管候选版。',
    '',
    '仅本次页面会话有效，刷新/重启后自动关闭。',
    '它会自动执行：安全热→冷归档，以及“节点重新进入热区”后的重激活收口。',
    '自动重激活采用保守模式：当前热MVU永远是权威，不会把冷档案里已经消失的旧字段擅自写回。',
    '聊天里只是提到冷档案名字也不会硬恢复；相关旧事实只交给Prompt召回层。',
    '每次最多处理1个生命周期动作，并受生成期锁、scope锁、稳定观察、冷却和熔断保护。',
    '',
    '是否仅在本次页面会话开启？',
  ].join('\n'));
  enabled = !!ok;
  statusText = enabled
    ? '已开启 · session-only · 自动重激活采用热状态权威的保守收口'
    : '未启用 · 不会自动修改MVU';
  if (enabled) scheduleCycle(TRIGGER_DELAY_MS);
  updateUi();
  return enabled;
}

function uiHost() {
  return document.querySelector('#vab-rc-host')
    || document.querySelector('#vab-smart-host-safe')
    || document.querySelector('#vab-settings #vab-root');
}

function ensureUi() {
  const host = uiHost();
  if (!host) return;
  if (host.querySelector('#vab-auto-lifecycle-safe')) {
    updateUi();
    return;
  }

  const box = document.createElement('details');
  box.id = 'vab-auto-lifecycle-safe';
  box.className = 'vab-section';
  box.open = false;
  box.innerHTML = `
    <summary>🧬 统一生命周期托管 ${VERSION}</summary>
    <div class="vab-note">RC3：冷档案“被提到”≠恢复MVU。自动模式只在归档节点真正重新出现后收口旧版本，而且以当前热MVU为唯一权威：不会自动把冷档案独有、可能已过期的字段回灌。需要主动合并旧字段时只保留给高级人工事务。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-lifecycle-enable> 本次页面会话启用自动生命周期托管（实验）</label>
    <div class="vab-actions"><button class="menu_button" data-vab-lifecycle-preview>统一只读检查</button></div>
    <div class="vab-note">保护：生成期间禁止处理；聊天切换首轮禁止处理；重激活需连续稳定观察；30秒动作冷却；同一消息计数最多1次迁移；10分钟3次异常自动熔断。启用状态绝不写入localStorage。</div>
    <div class="vab-note" data-vab-lifecycle-status>○ ${statusText}</div>`;
  host.appendChild(box);

  box.querySelector('[data-vab-lifecycle-enable]')?.addEventListener('change', async e => setEnabled(!!e.target.checked));
  box.querySelector('[data-vab-lifecycle-preview]')?.addEventListener('click', async () => {
    const result = await runCycle({ forcePreview: true });
    if (result) statusText = `只读：${summarizeLifecycleDecision(result)} · 未修改MVU`;
    updateUi();
  });
  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-auto-lifecycle-safe');
  if (!box) return;
  const toggle = box.querySelector('[data-vab-lifecycle-enable]');
  if (toggle && toggle.checked !== enabled) toggle.checked = enabled;
  if (toggle) toggle.disabled = busy;
  const status = box.querySelector('[data-vab-lifecycle-status]');
  if (status) status.textContent = `${enabled ? '●' : '○'} ${statusText}`;
}

export function mountAutoLifecycleSafe() {
  if (mounted) return;
  mounted = true;
  enabled = false;
  busy = false;
  statusText = '未启用 · 不会自动修改MVU';
  observations = {};
  lastScopeKey = '';
  hookEvents();
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
}

export function unmountAutoLifecycleSafe() {
  enabled = false;
  clearScheduled();
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  unhookEvents();
  observations = {};
  document.querySelector('#vab-auto-lifecycle-safe')?.remove();
  mounted = false;
  statusText = '未启用 · 不会自动修改MVU';
}

export async function setLifecycleEnabledSession(value, options = {}) {
  return await setEnabled(!!value, options);
}

export const AutoLifecycleSafeDiagnostics = {
  VERSION,
  isEnabled: () => enabled,
  getStatus: () => statusText,
  getRuntime: () => ({
    mounted,
    enabled,
    busy,
    generationFlag,
    scheduled: !!scheduledTimer,
    lastMutationAt,
    lastMutationMessageCount,
    lastScopeKey,
    observationCount: Object.keys(observations).length,
    recentErrors: errorTimes.length,
  }),
  getLastDecision: () => clone(lastDecision),
  preview: () => runCycle({ forcePreview: true }),
  setEnabled: setLifecycleEnabledSession,
};
