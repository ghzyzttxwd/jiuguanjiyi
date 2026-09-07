import {
  buildRehydrationPlans,
  formatRehydrationPlan,
} from './rehydration_core.js';

const VERSION = '0.1.0-rc1';
const MAX_PREVIEW_PLANS = 6;
const MAX_PREVIEW_CHARS = 12000;

let mounted = false;
let statusText = '未检查';
let previewText = '';

function getVab() {
  return window.VariableArchiveBridge || null;
}

function state() {
  return getVab()?.getState?.() || null;
}

function clipJson(value, maxChars = 2600) {
  let text = '';
  try { text = JSON.stringify(value, null, 2); }
  catch { text = String(value ?? ''); }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n…[预览已截断]`;
}

function buildPreviewText(plans) {
  if (!plans?.length) return '（当前没有检测到“已归档节点重新成为热变量”的情况）';
  const pieces = [];
  let used = 0;
  for (const [index, plan] of plans.entries()) {
    const piece = [
      `[计划${index + 1}] ${formatRehydrationPlan(plan)}`,
      `原因：${plan.reason}`,
      '合并后预览（只读）：',
      clipJson(plan.merged),
    ].join('\n');
    if (used + piece.length > MAX_PREVIEW_CHARS) break;
    pieces.push(piece);
    used += piece.length;
  }
  return pieces.join('\n\n');
}

async function refreshPreview() {
  const vab = getVab();
  if (!vab?.getState || !vab?.refreshCurrent) {
    statusText = '归档桥核心未就绪';
    previewText = '';
    updateUi();
    return [];
  }

  try {
    await vab.refreshCurrent({ render: false });
    const s = state();
    const statData = s?.latestMvu?.statData || null;
    const archives = (s?.archiveCache || []).filter(r => r?.status === 'archived');
    if (!statData) {
      statusText = '当前没有MVU';
      previewText = '';
      updateUi();
      return [];
    }

    const plans = buildRehydrationPlans({
      archives,
      statData,
      settings: { maxPlansPerCycle: MAX_PREVIEW_PLANS },
    });
    previewText = buildPreviewText(plans);
    statusText = plans.length
      ? `只读发现 ${plans.length} 个重激活节点 · 未修改MVU/冷档案`
      : '只读检查完成 · 当前无需重激活合并';
    updateUi();
    return plans;
  } catch (error) {
    statusText = `只读检查异常：${error?.message || error}`;
    previewText = '';
    updateUi();
    return [];
  }
}

function ensureUi() {
  const host = document.querySelector('#vab-smart-host-safe');
  if (!host || host.querySelector('#vab-rehydration-safe')) return;

  const box = document.createElement('details');
  box.id = 'vab-rehydration-safe';
  box.className = 'vab-section';
  box.open = false;
  box.innerHTML = `
    <summary>♻️ 冷档案重激活合并预览 ${VERSION}</summary>
    <div class="vab-note">只读候选：当一个已归档人物/武学/世界后来被剧情重新写回热变量时，检查应该如何安全合并。对象采用“冷档案补缺字段 + 当前热变量覆盖变化字段”；数组/标量直接以当前热变量为准。本模块没有任何MVU或IndexedDB写入路径。</div>
    <div class="vab-actions">
      <button class="menu_button" data-vab-rehydrate-preview>只读检查重激活</button>
    </div>
    <div class="vab-note" data-vab-rehydrate-status>○ ${statusText}</div>
    <div class="vab-preview"><b>合并计划预览：</b><pre data-vab-rehydrate-text>（尚未检查）</pre></div>`;

  host.appendChild(box);
  box.querySelector('[data-vab-rehydrate-preview]')?.addEventListener('click', () => refreshPreview());
  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-rehydration-safe');
  if (!box) return;
  const status = box.querySelector('[data-vab-rehydrate-status]');
  if (status) status.textContent = `○ ${statusText}`;
  const preview = box.querySelector('[data-vab-rehydrate-text]');
  if (preview) preview.textContent = previewText || '（尚未检查）';
}

export function mountRehydrationSafe() {
  if (mounted) return;
  mounted = true;
  statusText = '未检查 · 只读模式';
  previewText = '';
  ensureUi();
}

export function unmountRehydrationSafe() {
  document.querySelector('#vab-rehydration-safe')?.remove();
  mounted = false;
  statusText = '未检查';
  previewText = '';
}

export const RehydrationSafeDiagnostics = {
  VERSION,
  preview: () => {
    const s = state();
    return buildRehydrationPlans({
      archives: (s?.archiveCache || []).filter(r => r?.status === 'archived'),
      statData: s?.latestMvu?.statData || null,
      settings: { maxPlansPerCycle: MAX_PREVIEW_PLANS },
    });
  },
  getStatus: () => statusText,
};
