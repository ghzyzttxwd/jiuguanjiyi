// Variable Archive Bridge v0.3.1 Hot State Governor — universal analysis-only phase.
// Reads current MVU and reports growth pressure. It never writes MVU, archives, or prompts.
// Card-specific policies are optional adapters; cards without one use conservative generic discovery.

import { analyzeHotState } from './hot_state_governor_core.js';

const VERSION = '0.3.1';
const PANEL_ID = 'vab-governor-settings';
const REFRESH_MS = 5000;
let lastReport = null;
let lastError = '';
let timer = null;
let running = false;

function vab() {
  try {
    return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
  } catch {
    return null;
  }
}

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function readCardPolicy() {
  try {
    const c = ctx();
    if (!c || c.groupId) return null;
    const ch = c.characters?.[c.characterId];
    const ext = ch?.data?.extensions || ch?.extensions || null;
    const policy = ext?.variable_archive_bridge_policy || ext?.vab_policy || null;
    return policy && typeof policy === 'object' ? policy : null;
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function levelText(level) {
  if (level === 'hard') return '🔴 超硬上限';
  if (level === 'warn') return '🟠 超软上限';
  return '🟢 正常';
}

function sourceText(source) {
  if (source === 'card') return '角色卡自带策略';
  if (source === 'builtin-profile') return '已识别适配策略';
  return '通用自动发现';
}

function hostNode() {
  return document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.body;
}

function ensurePanel() {
  if (document.getElementById(PANEL_ID)) return true;
  const host = hostNode();
  if (!host) return false;
  const wrap = document.createElement('div');
  wrap.id = PANEL_ID;
  wrap.innerHTML = `
    <div class="inline-drawer vab-governor-drawer">
      <div class="inline-drawer-toggle inline-drawer-header vab-governor-header">
        <b>🧠 热变量治理 <small>v${VERSION} · 通用只分析</small></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content vab-governor-content" style="display:none">
        <div class="vab-governor-root">等待读取MVU…</div>
      </div>
    </div>`;
  const anchor = document.getElementById('vab-settings');
  if (anchor?.parentNode === host) anchor.insertAdjacentElement('afterend', wrap);
  else host.appendChild(wrap);

  const toggle = wrap.querySelector('.inline-drawer-toggle');
  const content = wrap.querySelector('.inline-drawer-content');
  toggle?.addEventListener('click', () => {
    const hidden = content.style.display === 'none';
    content.style.display = hidden ? 'block' : 'none';
    if (hidden) refreshReport();
  });
  return true;
}

function render() {
  if (!ensurePanel()) return;
  const root = document.querySelector(`#${PANEL_ID} .vab-governor-root`);
  if (!root) return;
  if (lastError) {
    root.innerHTML = `<div class="vab-note">⚠ ${esc(lastError)}</div>`;
    return;
  }
  if (!lastReport) {
    root.innerHTML = '<div class="vab-note">等待读取MVU…</div>';
    return;
  }

  const { summary, collections, histories, profileLabel, policySource } = lastReport;
  const problemRows = collections.filter(x => x.level !== 'ok');
  const collectionHtml = collections.map(row => `
    <div class="vab-governor-row ${row.level}">
      <div><b>${esc(row.label)}</b><small>${esc(row.path)}</small></div>
      <div><span>${levelText(row.level)}</span> · 当前 ${row.count} · 软 ${row.softLimit} · 硬 ${row.hardLimit} · ${fmtBytes(row.bytes)}</div>
      ${row.protectedCount ? `<div class="vab-note">明确保护：${row.protectedCount} 项</div>` : ''}
      <div class="vab-note">${esc(row.strategy)}</div>
    </div>`).join('');

  const historyHtml = histories.length ? histories.slice(0, 30).map(row => `
    <div class="vab-governor-row ${row.level}">
      <div><b>${esc(row.label)}</b> · ${esc(row.ownerKey)}</div>
      <div><span>${levelText(row.level)}</span> · 当前 ${row.count} · 建议热留 ${row.softLimit} · 可历史化约 ${row.excess}</div>
    </div>`).join('') : '<div class="vab-note">当前没有发现超过建议热区的内部历史数组。</div>';

  root.innerHTML = `
    <div class="vab-status-row">
      <span class="vab-badge ok">● 只读分析</span>
      <span class="vab-badge ok">● ${esc(sourceText(policySource))}</span>
    </div>
    <div class="vab-note"><b>这是变量卡通用治理器，不是主神空间专属。</b> 当前策略：${esc(profileLabel || '通用自动发现')}。本阶段绝不删除、归档或改写任何MVU变量。</div>
    <div class="vab-actions"><button class="menu_button vab-governor-refresh">刷新分析</button></div>
    <div class="vab-governor-summary">
      stat_data：${fmtBytes(summary.totalStatBytes)} · 超硬上限 ${summary.hard} 组 · 超软上限 ${summary.warn} 组 · 估算可降温/历史化 ${summary.candidateCount} 项
    </div>
    <details class="vab-section" ${problemRows.length ? 'open' : ''}>
      <summary>集合热区预算（${collections.length}）</summary>
      ${collectionHtml || '<div class="vab-note">当前没有命中已知策略；通用自动发现也未发现明显动态集合。</div>'}
    </details>
    <details class="vab-section" ${histories.length ? 'open' : ''}>
      <summary>活跃对象内部历史（${histories.length}）</summary>
      ${historyHtml}
    </details>
  `;
  root.querySelector('.vab-governor-refresh')?.addEventListener('click', () => refreshReport());
}

export async function refreshReport() {
  if (running) return lastReport;
  running = true;
  try {
    const core = vab();
    if (!core?.refreshCurrent || !core?.getState) throw new Error('变量归档桥核心尚未就绪');
    await core.refreshCurrent({ render: false });
    const state = core.getState();
    const statData = state?.latestMvu?.statData;
    if (!statData) throw new Error('当前聊天还没有可读取的 MVU stat_data');
    lastReport = analyzeHotState(statData, { externalPolicy: readCardPolicy() });
    lastError = '';
    render();
    return lastReport;
  } catch (error) {
    lastError = String(error?.message || error);
    render();
    return null;
  } finally {
    running = false;
  }
}

function start() {
  ensurePanel();
  setTimeout(() => refreshReport(), 1200);
  if (!timer) timer = setInterval(() => {
    if (document.hidden) return;
    const content = document.querySelector(`#${PANEL_ID} .vab-governor-content`);
    if (content && content.style.display !== 'none') refreshReport();
  }, REFRESH_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeHotStateGovernor = {
  VERSION,
  refresh: refreshReport,
  getReport: () => lastReport ? structuredClone(lastReport) : null,
  getStatus: () => ({ running, lastError, hasReport: !!lastReport, readOnly: true, universal: true }),
};
