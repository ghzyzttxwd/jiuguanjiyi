// Variable Archive Bridge v0.4.0 Hot State Governor — universal cooling-preview phase.
// Reads current MVU, scores heat, and previews a warm index/cooling plan.
// It NEVER writes MVU or archives in this phase.

import { analyzeHotState } from './hot_state_governor_core.js';
import { buildCoolingPreview } from './hot_state_preview_core.js';

const VERSION = '0.4.0';
const PANEL_ID = 'vab-governor-settings';
const HEAT_TOUCH_KEY = 'vab.heat.touches.v1';
let lastReport = null;
let lastPreview = null;
let lastError = '';
let running = false;
const sectionState = {
  collectionsOpen: false,
  historiesOpen: false,
  coolingOpen: false,
  catalogOpen: false,
};

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

function recentConversationText() {
  try {
    const chat = ctx()?.chat || [];
    return chat.slice(-6).map(m => String(m?.mes || '')).join('\n').toLowerCase();
  } catch {
    return '';
  }
}

function messageCount() {
  try { return ctx()?.chat?.length || 0; }
  catch { return 0; }
}

function fnv1a(input) {
  const s = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function nodeHash(value) {
  try {
    const json = JSON.stringify(value);
    return `${json.length}:${fnv1a(json)}`;
  } catch {
    return String(Date.now());
  }
}

function loadHeatTouches() {
  try { return JSON.parse(localStorage.getItem(HEAT_TOUCH_KEY) || '{}'); }
  catch { return {}; }
}

function saveHeatTouches(all) {
  try { localStorage.setItem(HEAT_TOUCH_KEY, JSON.stringify(all)); }
  catch { /* best effort only */ }
}

function getByPointer(root, path) {
  if (!root || typeof path !== 'string' || !path.startsWith('/')) return undefined;
  const keys = path.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function observeHeatTouches(statData, report, scopeKey, msgCount) {
  if (!scopeKey) return {};
  const all = loadHeatTouches();
  const scope = all[scopeKey] ||= {};
  for (const row of report?.collections || []) {
    const container = getByPointer(statData, row.path);
    if (!container || typeof container !== 'object') continue;
    const pathState = scope[row.path] ||= {};
    const entries = Array.isArray(container) ? container.map((v, i) => [String(i), v]) : Object.entries(container);
    const liveKeys = new Set();
    for (const [key, node] of entries) {
      liveKeys.add(key);
      const hash = nodeHash(node);
      const old = pathState[key];
      if (!old) pathState[key] = { hash, lastChanged: msgCount, lastSeen: msgCount };
      else {
        if (old.hash !== hash) {
          old.hash = hash;
          old.lastChanged = msgCount;
        }
        old.lastSeen = msgCount;
      }
    }
    for (const key of Object.keys(pathState)) if (!liveKeys.has(key)) delete pathState[key];
  }
  saveHeatTouches(all);
  return scope;
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
        <b>🧠 热变量治理 <small>v${VERSION} · 降温预览</small></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content vab-governor-content" style="display:none">
        <div class="vab-governor-root">等待读取MVU…</div>
      </div>
    </div>`;
  const anchor = document.getElementById('vab-settings');
  if (anchor?.parentNode === host) anchor.insertAdjacentElement('afterend', wrap);
  else host.appendChild(wrap);
  return true;
}

function rememberSectionState(root) {
  for (const key of Object.keys(sectionState)) {
    const name = key.replace(/Open$/, '');
    const section = root?.querySelector(`[data-vab-section="${name}"]`);
    if (section) sectionState[key] = !!section.open;
  }
}

function bindSectionState(root) {
  for (const key of Object.keys(sectionState)) {
    const name = key.replace(/Open$/, '');
    const section = root?.querySelector(`[data-vab-section="${name}"]`);
    section?.addEventListener('toggle', () => { sectionState[key] = !!section.open; });
  }
}

function heatReasonText(item) {
  return item?.reasons?.length ? item.reasons.join('、') : '无额外活跃信号';
}

function coolingPreviewHtml(preview) {
  const active = (preview?.collections || []).filter(row => row.cooling.length);
  if (!active.length) {
    return '<div class="vab-note">当前所有集合都在软上限以内，不需要降温。以后超过软上限时，这里会按“当前相关 / 最近提及 / 最近变化 / 新近加入”排序并列出候选。</div>';
  }
  return active.map(row => {
    const kept = row.kept.slice(0, 10).map(x => `${esc(x.key)}(${Math.round(x.score)})`).join('、');
    const cool = row.cooling.slice(0, 12).map(x => `
      <div class="vab-child-row">
        <div class="vab-child-main"><b>${esc(x.key)}</b><small>热度 ${Math.round(x.score)} · ${fmtBytes(x.bytes)} · ${esc(heatReasonText(x))}</small></div>
      </div>`).join('');
    return `<div class="vab-container-card">
      <div class="vab-container-head"><b>${esc(row.label)}</b><span>${esc(row.path)} · 预计降温 ${row.cooling.length}项 / ${fmtBytes(row.coolingBytes)}</span></div>
      <div class="vab-note">预计热留：${kept || '无'}${row.kept.length > 10 ? '…' : ''}</div>
      <div class="vab-note"><b>降温候选：</b></div>${cool}
    </div>`;
  }).join('');
}

function catalogHtml(preview) {
  const items = preview?.warmIndex || [];
  if (!items.length) return '<div class="vab-note">当前没有需要建立温索引的降温候选。</div>';
  return items.slice(0, 40).map(item => `
    <div class="vab-child-row">
      <div class="vab-child-main"><b>${esc(item.key)}</b><small>${esc(item.sourcePath)} · ${fmtBytes(item.bytes)} · ${esc(item.summary)}</small></div>
    </div>`).join('') + (items.length > 40 ? `<div class="vab-note">另有 ${items.length - 40} 项未显示。</div>` : '');
}

function render() {
  if (!ensurePanel()) return;
  const root = document.querySelector(`#${PANEL_ID} .vab-governor-root`);
  if (!root) return;
  rememberSectionState(root);
  if (lastError) {
    root.innerHTML = `<div class="vab-note">⚠ ${esc(lastError)}</div>`;
    return;
  }
  if (!lastReport || !lastPreview) {
    root.innerHTML = '<div class="vab-note">等待读取MVU…</div>';
    return;
  }

  const { summary, collections, histories, profileLabel, policySource } = lastReport;
  const previewSummary = lastPreview.summary;
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
      <span class="vab-badge ok">● 只读预览</span>
      <span class="vab-badge ok">● ${esc(sourceText(policySource))}</span>
    </div>
    <div class="vab-note"><b>这是变量卡通用治理器，不是任何单一卡专属。</b> 当前策略：${esc(profileLabel || '通用自动发现')}。v0.4 只计算热度、温索引和降温计划，绝不删除、归档或改写MVU。</div>
    <div class="vab-actions"><button class="menu_button vab-governor-refresh">刷新分析</button></div>
    <div class="vab-governor-summary">
      stat_data：${fmtBytes(summary.totalStatBytes)} · 动态集合 ${collections.length} · 当前降温候选 ${previewSummary.totalCandidateCount} 项 · 预计可移出约 ${fmtBytes(previewSummary.totalEstimatedBytes)}
    </div>
    <details class="vab-section" data-vab-section="collections" ${sectionState.collectionsOpen ? 'open' : ''}>
      <summary>集合热区预算（${collections.length}）</summary>
      ${collectionHtml || '<div class="vab-note">当前没有识别到动态集合。</div>'}
    </details>
    <details class="vab-section" data-vab-section="cooling" ${sectionState.coolingOpen ? 'open' : ''}>
      <summary>🔥 热度排序与降温预览（${previewSummary.candidateCount}）</summary>
      ${coolingPreviewHtml(lastPreview)}
    </details>
    <details class="vab-section" data-vab-section="catalog" ${sectionState.catalogOpen ? 'open' : ''}>
      <summary>📇 温索引预览（${lastPreview.warmIndex.length}）</summary>
      <div class="vab-note">正式降温后只保留这种轻量目录用于“我会哪些武功 / 我认识哪些人”之类的目录查询；完整JSON仍进入冷档案。</div>
      ${catalogHtml(lastPreview)}
    </details>
    <details class="vab-section" data-vab-section="histories" ${sectionState.historiesOpen ? 'open' : ''}>
      <summary>活跃对象内部历史（${histories.length}）</summary>
      ${historyHtml}
    </details>
  `;
  root.querySelector('.vab-governor-refresh')?.addEventListener('click', () => refreshReport());
  bindSectionState(root);
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
    const scopeKey = state?.current?.scopeKey || state?.current?.chatId || 'unknown-scope';
    const msgCount = messageCount();
    const touchMap = observeHeatTouches(statData, lastReport, scopeKey, msgCount);
    lastPreview = buildCoolingPreview(statData, lastReport, {
      recentText: recentConversationText(),
      touchMap,
      messageCount: msgCount,
    });
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
  // No repeating UI redraw. Refresh occurs when the governor drawer opens or the user taps refresh.
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeHotStateGovernor = {
  VERSION,
  refresh: refreshReport,
  getReport: () => lastReport ? structuredClone(lastReport) : null,
  getPreview: () => lastPreview ? structuredClone(lastPreview) : null,
  getStatus: () => ({ running, lastError, hasReport: !!lastReport, hasPreview: !!lastPreview, readOnly: true, universal: true }),
};
