import { collectHotAnchorText } from './smart_host_core.js';
import { buildRecallContext, DEFAULT_RECALL_SETTINGS } from './recall_core.js';

const VERSION = '0.1.0-rc1';
const PROMPT_KEY = 'vab_cold_recall';
const SETTINGS_KEY = 'vab.recall.safe.settings.v1';
const UI_INTERVAL_MS = 4000;

let mounted = false;
let uiTimer = null;
let enabled = false;
let statusText = '未启用';
let previewText = '';
let bindings = [];
let promptEnums = null;

const defaults = {
  enabled: false,
  maxRecords: 6,
  maxChars: 9000,
  maxRecordChars: 2600,
  minScore: 120,
  includePinnedWithoutMatch: true,
  skipMirroredWhenMemoryActive: true,
  depth: 4,
};

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...defaults, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...defaults };
  }
}

let cfg = { ...loadSettings(), enabled: false };

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cfg, enabled: false })); } catch {}
}

function ctx() {
  try {
    return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function getVab() {
  return window.VariableArchiveBridge || null;
}

function state() {
  return getVab()?.getState?.() || null;
}

function recentContextText(count = 8) {
  const chat = ctx()?.chat || [];
  return chat
    .filter(m => m && typeof m.mes === 'string')
    .slice(-Math.max(1, count))
    .map(m => String(m.mes || ''))
    .join('\n');
}

function recallQuery(statData) {
  return [recentContextText(8), collectHotAnchorText(statData)].filter(Boolean).join('\n');
}

function memoryEnhancementActive() {
  try {
    return !!(window.stMemoryEnhancement || window.parent?.stMemoryEnhancement);
  } catch {
    return false;
  }
}

function buildCurrentRecall() {
  const s = state();
  const statData = s?.latestMvu?.statData || null;
  const archives = s?.archiveCache || [];
  const queryText = recallQuery(statData);
  const settings = {
    ...DEFAULT_RECALL_SETTINGS,
    maxRecords: cfg.maxRecords,
    maxChars: cfg.maxChars,
    maxRecordChars: cfg.maxRecordChars,
    minScore: cfg.minScore,
    includePinnedWithoutMatch: cfg.includePinnedWithoutMatch,
    skipMirrored: cfg.skipMirroredWhenMemoryActive && memoryEnhancementActive(),
  };
  return buildRecallContext({ archives, statData, queryText, settings });
}

async function resolvePromptEnums() {
  if (promptEnums) return promptEnums;
  const c = ctx();
  if (!c?.setExtensionPrompt) throw new Error('当前 SillyTavern 未暴露 setExtensionPrompt');
  try {
    const script = await import('/script.js');
    const position = script?.extension_prompt_types?.IN_PROMPT;
    const role = script?.extension_prompt_roles?.SYSTEM;
    if (position === undefined) throw new Error('未找到 extension_prompt_types.IN_PROMPT');
    promptEnums = { position, role };
    return promptEnums;
  } catch (error) {
    throw new Error(`无法解析安全Prompt注入常量：${error?.message || error}`);
  }
}

async function clearInjection() {
  const c = ctx();
  if (!c?.setExtensionPrompt) return;
  try {
    const enums = await resolvePromptEnums();
    c.setExtensionPrompt(PROMPT_KEY, '', enums.position, cfg.depth, false, enums.role);
  } catch (error) {
    console.warn('[VAB Recall Safe] clear injection failed', error);
  }
}

async function refreshInjection({ reason = 'event', forcePreview = false } = {}) {
  const result = buildCurrentRecall();
  previewText = result.text;

  if (!enabled) {
    if (forcePreview) {
      statusText = result.ranked.length
        ? `只读预览：命中 ${result.ranked.length} 条冷档案 / ${result.chars}字符 · 未注入模型`
        : '只读预览：当前没有相关冷档案 · 未注入模型';
    }
    updateUi();
    return result;
  }

  const c = ctx();
  if (!c?.setExtensionPrompt) {
    enabled = false;
    statusText = '自动召回已关闭：当前 SillyTavern 没有 setExtensionPrompt API';
    updateUi();
    return result;
  }

  try {
    const enums = await resolvePromptEnums();
    c.setExtensionPrompt(PROMPT_KEY, result.text || '', enums.position, cfg.depth, false, enums.role);
    statusText = result.ranked.length
      ? `已准备召回 ${result.ranked.length} 条 / ${result.chars}字符 · ${reason}`
      : `本轮无相关冷档案，已清空召回Prompt · ${reason}`;
  } catch (error) {
    enabled = false;
    cfg.enabled = false;
    saveSettings();
    await clearInjection();
    statusText = `自动召回异常并已关闭：${error?.message || error}`;
  }
  updateUi();
  return result;
}

async function setEnabled(value) {
  if (!value) {
    enabled = false;
    cfg.enabled = false;
    saveSettings();
    await clearInjection();
    statusText = '未启用 · 已清空本插件Prompt';
    updateUi();
    return;
  }

  try {
    await resolvePromptEnums();
    enabled = true;
    cfg.enabled = false; // never persist experimental enable across reloads
    saveSettings();
    await refreshInjection({ reason: '手动开启' });
  } catch (error) {
    enabled = false;
    statusText = `无法开启：${error?.message || error}`;
    updateUi();
  }
}

function bindEvent(name, handler) {
  const c = ctx();
  const source = c?.eventSource;
  if (!name || !source?.on) return;
  source.on(name, handler);
  bindings.push({ source, name, handler });
}

function hookEvents() {
  if (bindings.length) return;
  const c = ctx();
  const e = c?.eventTypes || c?.event_types || {};

  const sync = () => {
    if (enabled) refreshInjection({ reason: '消息更新' }).catch(err => console.warn('[VAB Recall Safe]', err));
  };
  const clearOnChat = () => {
    clearInjection().finally(() => {
      previewText = '';
      if (enabled) setTimeout(() => refreshInjection({ reason: '聊天切换' }), 250);
    });
  };
  const finalBeforePrompt = () => {
    if (enabled) refreshInjection({ reason: '生成前最终同步' }).catch(err => console.warn('[VAB Recall Safe]', err));
  };

  bindEvent(e.MESSAGE_SENT, sync);
  bindEvent(e.USER_MESSAGE_RENDERED, sync);
  bindEvent(e.MESSAGE_UPDATED, sync);
  bindEvent(e.MESSAGE_EDITED, sync);
  bindEvent(e.CHAT_CHANGED, clearOnChat);
  bindEvent(e.GENERATE_BEFORE_COMBINE_PROMPTS, finalBeforePrompt);
}

function unhookEvents() {
  for (const { source, name, handler } of bindings) {
    try { source?.removeListener?.(name, handler); } catch {}
  }
  bindings = [];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ensureUi() {
  const host = document.querySelector('#vab-smart-host-safe');
  if (!host) return;
  if (host.querySelector('#vab-recall-safe')) {
    updateUi();
    return;
  }

  const box = document.createElement('details');
  box.id = 'vab-recall-safe';
  box.className = 'vab-section';
  box.open = false;
  box.innerHTML = `
    <summary>🗃️ 冷档案自动召回候选 ${VERSION}</summary>
    <div class="vab-note">这是读穿层：冷档案仍留在 IndexedDB，需要时只把相关内容送进本轮Prompt，不恢复成MVU热变量。默认关闭实际注入；先用只读预览。重启后实际注入永远恢复关闭。</div>
    <label class="checkbox_label"><input type="checkbox" data-vab-recall-enabled> 实际Prompt自动召回（实验）</label>
    <label class="checkbox_label"><input type="checkbox" data-vab-recall-pinned> 无关键词时允许置顶档案作为背景召回</label>
    <label class="checkbox_label"><input type="checkbox" data-vab-recall-skip-mirror> 检测到记忆增强时跳过已镜像档案</label>
    <div class="vab-actions">
      <button class="menu_button" data-vab-recall-preview>只读召回预览</button>
      <button class="menu_button" data-vab-recall-clear>清空本插件Prompt</button>
    </div>
    <div class="vab-note" data-vab-recall-status></div>
    <details>
      <summary>召回预算</summary>
      <label>最多档案 <input class="vab-num" type="number" min="1" max="20" data-vab-recall-records></label>
      <label>总字符上限 <input class="vab-num-wide" type="number" min="1000" step="500" data-vab-recall-chars></label>
      <label>单档案字符上限 <input class="vab-num-wide" type="number" min="500" step="100" data-vab-recall-record-chars></label>
    </details>
    <div class="vab-preview"><b>当前只读预览：</b><pre data-vab-recall-preview-text>（尚未检查）</pre></div>`;

  host.appendChild(box);

  box.querySelector('[data-vab-recall-enabled]')?.addEventListener('change', e => setEnabled(e.target.checked));
  box.querySelector('[data-vab-recall-pinned]')?.addEventListener('change', e => {
    cfg.includePinnedWithoutMatch = !!e.target.checked;
    saveSettings();
    refreshInjection({ forcePreview: !enabled, reason: '设置变化' });
  });
  box.querySelector('[data-vab-recall-skip-mirror]')?.addEventListener('change', e => {
    cfg.skipMirroredWhenMemoryActive = !!e.target.checked;
    saveSettings();
    refreshInjection({ forcePreview: !enabled, reason: '设置变化' });
  });
  box.querySelector('[data-vab-recall-preview]')?.addEventListener('click', () => refreshInjection({ forcePreview: true, reason: '只读预览' }));
  box.querySelector('[data-vab-recall-clear]')?.addEventListener('click', async () => {
    await clearInjection();
    statusText = enabled ? '已手动清空；下一次消息/生成前会按需重建' : '已清空本插件Prompt';
    updateUi();
  });

  const bindNum = (selector, key, min, fallback) => {
    box.querySelector(selector)?.addEventListener('change', e => {
      cfg[key] = Math.max(min, Number(e.target.value) || fallback);
      saveSettings();
      refreshInjection({ forcePreview: !enabled, reason: '预算变化' });
    });
  };
  bindNum('[data-vab-recall-records]', 'maxRecords', 1, 6);
  bindNum('[data-vab-recall-chars]', 'maxChars', 1000, 9000);
  bindNum('[data-vab-recall-record-chars]', 'maxRecordChars', 500, 2600);

  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-recall-safe');
  if (!box) return;
  const checked = (sel, value) => {
    const el = box.querySelector(sel);
    if (el && el.checked !== !!value) el.checked = !!value;
  };
  const value = (sel, v) => {
    const el = box.querySelector(sel);
    if (el && el.value !== String(v)) el.value = String(v);
  };
  checked('[data-vab-recall-enabled]', enabled);
  checked('[data-vab-recall-pinned]', cfg.includePinnedWithoutMatch);
  checked('[data-vab-recall-skip-mirror]', cfg.skipMirroredWhenMemoryActive);
  value('[data-vab-recall-records]', cfg.maxRecords);
  value('[data-vab-recall-chars]', cfg.maxChars);
  value('[data-vab-recall-record-chars]', cfg.maxRecordChars);
  const status = box.querySelector('[data-vab-recall-status]');
  if (status) status.textContent = `${enabled ? '●' : '○'} ${statusText}`;
  const preview = box.querySelector('[data-vab-recall-preview-text]');
  if (preview) preview.textContent = previewText || '（当前没有需要召回的冷档案）';
}

export function mountRecallSafe() {
  if (mounted) return;
  mounted = true;
  enabled = false;
  cfg.enabled = false;
  saveSettings();
  statusText = '未启用 · 实际Prompt注入保持关闭';
  hookEvents();
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
}

export async function unmountRecallSafe() {
  enabled = false;
  cfg.enabled = false;
  saveSettings();
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  unhookEvents();
  await clearInjection();
  document.querySelector('#vab-recall-safe')?.remove();
  previewText = '';
  mounted = false;
}

export const RecallSafeDiagnostics = {
  VERSION,
  PROMPT_KEY,
  getSettings: () => clone(cfg),
  getStatus: () => statusText,
  preview: () => buildCurrentRecall(),
  isEnabled: () => enabled,
};
