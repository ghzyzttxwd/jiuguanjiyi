import { buildRehydrationPlans, formatRehydrationPlan } from './rehydration_core.js';
import { executeRehydrationTransaction } from './rehydration_transaction.js';
import { createRehydrationLiveIo, isGenerationActive } from './rehydration_live_adapter.js';

const VERSION = '0.1.0-rc1';
const MAX_PLANS = 6;

let mounted = false;
let armed = false;
let busy = false;
let statusText = '未武装 · 不会写入';
let plans = [];

function getVab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function state() {
  return getVab()?.getState?.() || null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function scanPlans() {
  const vab = getVab();
  if (!vab?.refreshCurrent || !vab?.getState) {
    statusText = '归档桥核心未就绪';
    plans = [];
    updateUi();
    return [];
  }
  try {
    await vab.refreshCurrent({ render: false });
    const s = state();
    plans = buildRehydrationPlans({
      archives: (s?.archiveCache || []).filter(r => r?.status === 'archived'),
      statData: s?.latestMvu?.statData || null,
      settings: { maxPlansPerCycle: MAX_PLANS },
    });
    statusText = plans.length
      ? `发现 ${plans.length} 个可处理重激活节点 · ${armed ? '已武装，仅允许单条手动执行' : '未武装，不会写入'}`
      : `当前无可处理节点 · ${armed ? '已武装' : '未武装'}`;
    updateUi();
    return plans;
  } catch (error) {
    plans = [];
    statusText = `扫描失败：${error?.message || error}`;
    updateUi();
    return [];
  }
}

async function setArmed(value) {
  if (!value) {
    armed = false;
    statusText = '未武装 · 不会写入';
    updateUi();
    return;
  }
  if (busy) return;
  if (await isGenerationActive()) {
    armed = false;
    statusText = '无法武装：当前正在生成消息';
    updateUi();
    return;
  }
  const ok = confirm([
    '这是实验性的“冷档案重激活写入”候选。',
    '',
    '武装只对本次页面会话有效，不会持久化。',
    '即使武装，也不会自动批量写入；每一条仍需你单独点击并再次确认。',
    '执行前会保存MVU快照；写入后会验证；异常会尝试事务回滚。',
    '',
    '是否仅在本次会话允许手动执行？',
  ].join('\n'));
  armed = !!ok;
  statusText = armed ? '已武装 · 仅允许单条手动执行 · 重载后自动解除' : '未武装 · 不会写入';
  updateUi();
}

async function executeOne(recordId) {
  if (!armed || busy) return;
  const plan = plans.find(p => p?.record?.id === recordId);
  if (!plan) {
    statusText = '计划已经过期，请重新扫描';
    updateUi();
    return;
  }
  if (await isGenerationActive()) {
    statusText = '已拒绝执行：当前正在生成消息';
    updateUi();
    return;
  }

  const d = plan.diff || {};
  const ok = confirm([
    '确认执行这一条重激活事务？',
    '',
    `路径：${plan.pointer}`,
    `动作：${plan.action}`,
    `冷档案独有字段：${d.coldOnly || 0}`,
    `热变量新增字段：${d.hotOnly || 0}`,
    `变化字段：${d.changed || 0}`,
    '',
    '规则：冷档案只补缺；当前热变量值永远优先。',
    '执行前快照，写入后验证，异常尝试回滚。',
  ].join('\n'));
  if (!ok) return;

  busy = true;
  statusText = `事务执行中：${plan.pointer}`;
  updateUi();
  try {
    const io = createRehydrationLiveIo();
    const result = await executeRehydrationTransaction(io, recordId);
    if (result.status === 'committed') {
      statusText = `✅ 已事务合并并验证：${result.pointer}`;
    } else if (result.status === 'restored-without-write') {
      statusText = `✅ 无需改MVU，已关闭对应冷档案：${result.pointer}`;
    } else {
      statusText = `ℹ️ 未执行写入：${result.reason || result.status}`;
    }
  } catch (error) {
    const code = error?.code ? `[${error.code}] ` : '';
    statusText = `❌ 事务失败：${code}${error?.message || error}`;
    console.error('[VAB Rehydration Live Safe]', error);
  } finally {
    busy = false;
    await scanPlans();
  }
}

function planRow(plan) {
  const d = plan.diff || {};
  return `<div class="vab-child-row">
    <div class="vab-child-main">
      <b>${escapeHtml(plan.record?.childKey || plan.pointer)}</b>
      <small>${escapeHtml(formatRehydrationPlan(plan))}</small>
      <span>${escapeHtml(plan.reason || '')}</span>
      <small>冷独有 ${d.coldOnly || 0} · 热新增 ${d.hotOnly || 0} · 已变化 ${d.changed || 0}</small>
    </div>
    <button class="menu_button" data-vab-rehydrate-live="${escapeHtml(plan.record?.id || '')}" ${(!armed || busy) ? 'disabled' : ''}>执行此条</button>
  </div>`;
}

function ensureUi() {
  const host = document.querySelector('#vab-smart-host-safe');
  if (!host || host.querySelector('#vab-rehydration-live-safe')) return;

  const box = document.createElement('details');
  box.id = 'vab-rehydration-live-safe';
  box.className = 'vab-section';
  box.open = false;
  box.innerHTML = `
    <summary>🧯 重激活事务写入候选 ${VERSION}</summary>
    <div class="vab-note">这是第二道安全门。正常启动不会载入；载入后也默认未武装。只有“本次会话武装” + “单条执行” + 二次确认同时满足，才会调用事务写入。不会批量执行，不会持久化武装状态。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-rehydrate-arm> 本次会话允许手动重激活写入</label>
    <div class="vab-actions">
      <button class="menu_button" data-vab-rehydrate-live-scan>扫描可执行计划</button>
    </div>
    <div class="vab-note" data-vab-rehydrate-live-status>○ ${escapeHtml(statusText)}</div>
    <div data-vab-rehydrate-live-list><div class="vab-empty">尚未扫描。</div></div>`;

  host.appendChild(box);
  box.querySelector('[data-vab-rehydrate-arm]')?.addEventListener('change', async e => {
    await setArmed(!!e.target.checked);
  });
  box.querySelector('[data-vab-rehydrate-live-scan]')?.addEventListener('click', () => scanPlans());
  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-rehydration-live-safe');
  if (!box) return;
  const arm = box.querySelector('[data-vab-rehydrate-arm]');
  if (arm && arm.checked !== armed) arm.checked = armed;
  if (arm) arm.disabled = busy;
  const status = box.querySelector('[data-vab-rehydrate-live-status]');
  if (status) status.textContent = `${armed ? '●' : '○'} ${statusText}`;
  const list = box.querySelector('[data-vab-rehydrate-live-list]');
  if (list) {
    list.innerHTML = plans.length
      ? plans.map(planRow).join('')
      : '<div class="vab-empty">当前没有可执行计划。</div>';
    list.querySelectorAll('[data-vab-rehydrate-live]').forEach(btn => {
      btn.addEventListener('click', () => executeOne(btn.dataset.vabRehydrateLive));
    });
  }
}

export function mountRehydrationLiveSafe() {
  if (mounted) return;
  mounted = true;
  armed = false;
  busy = false;
  plans = [];
  statusText = '未武装 · 不会写入';
  ensureUi();
}

export function unmountRehydrationLiveSafe() {
  armed = false;
  busy = false;
  plans = [];
  document.querySelector('#vab-rehydration-live-safe')?.remove();
  mounted = false;
  statusText = '未武装 · 不会写入';
}

export const RehydrationLiveSafeDiagnostics = {
  VERSION,
  isArmed: () => armed,
  isBusy: () => busy,
  getStatus: () => statusText,
  scanPlans,
};
