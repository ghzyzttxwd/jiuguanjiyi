import { buildCanaryReport, summarizeCanaryReport } from './canary_report_core.js';
import { RecallSafeDiagnostics } from './recall_safe.js';
import { AutoLifecycleSafeDiagnostics } from './auto_lifecycle_safe.js';
import { MemoryMasterSafeDiagnostics } from './memory_master_safe.js';

const VERSION = '0.1.0-rc1';
const UI_INTERVAL_MS = 8000;

let mounted = false;
let uiTimer = null;
let lastReport = null;
let statusText = '尚未生成诊断';

function getVab() {
  return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
}

function byteSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; }
  catch { return 0; }
}

function nodeCount(value, maxNodes = 100000) {
  if (value == null || typeof value !== 'object') return value === undefined ? 0 : 1;
  let count = 0;
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length && count < maxNodes) {
    const current = stack.pop();
    if (current && typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      count++;
      for (const child of Object.values(current)) stack.push(child);
    } else {
      count++;
    }
  }
  return count;
}

function collectReport() {
  const vab = getVab();
  const s = vab?.getState?.() || {};
  const stat = s?.latestMvu?.statData || null;
  const recallSettings = RecallSafeDiagnostics.getSettings?.() || {};
  const recallDecision = RecallSafeDiagnostics.getDecision?.() || null;
  const lifecycleRuntime = AutoLifecycleSafeDiagnostics.getRuntime?.() || {};
  const masterRuntime = MemoryMasterSafeDiagnostics.getRuntime?.() || {};

  return buildCanaryReport({
    app: {
      userAgent: navigator?.userAgent || '',
      visibility: document?.visibilityState || '',
      online: navigator?.onLine,
    },
    vab: {
      version: vab?.VERSION || '',
      hasMvu: !!stat,
      mvuBytes: stat ? byteSize(stat) : 0,
      mvuNodes: stat ? nodeCount(stat) : 0,
      archiveCount: Array.isArray(s?.archiveCache) ? s.archiveCache.length : 0,
      snapshotCount: 0,
      busy: !!s?.busy,
      lastError: s?.lastError || '',
    },
    recall: {
      version: RecallSafeDiagnostics.VERSION,
      enabled: RecallSafeDiagnostics.isEnabled?.(),
      decisionMode: recallDecision?.mode || '',
      status: RecallSafeDiagnostics.getStatus?.() || '',
      maxRecords: recallSettings.maxRecords,
      maxChars: recallSettings.maxChars,
    },
    lifecycle: {
      version: AutoLifecycleSafeDiagnostics.VERSION,
      status: AutoLifecycleSafeDiagnostics.getStatus?.() || '',
      runtime: lifecycleRuntime,
    },
    master: {
      version: MemoryMasterSafeDiagnostics.VERSION,
      status: MemoryMasterSafeDiagnostics.getStatus?.() || '',
      runtime: masterRuntime,
      health: MemoryMasterSafeDiagnostics.getHealth?.() || null,
      preflight: MemoryMasterSafeDiagnostics.getPreflight?.() || null,
    },
    bootGuard: null,
  });
}

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

function uiHost() {
  return document.querySelector('#vab-rc-host') || document.querySelector('#vab-settings #vab-root');
}

function ensureUi() {
  const host = uiHost();
  if (!host) return;
  if (host.querySelector('#vab-canary-report-safe')) {
    updateUi();
    return;
  }

  const box = document.createElement('details');
  box.id = 'vab-canary-report-safe';
  box.className = 'vab-section';
  box.open = false;
  box.innerHTML = `
    <summary>🩺 Canary诊断 ${VERSION}</summary>
    <div class="vab-note">只输出运行状态、计数、版本和错误摘要；不会写入角色名、聊天正文、冷档案内容、变量子键、Prompt正文或scope ID。用于手机实机验收时快速定位问题。</div>
    <div class="vab-actions">
      <button class="menu_button" data-vab-canary-generate>生成诊断</button>
      <button class="menu_button" data-vab-canary-copy disabled>复制诊断JSON</button>
    </div>
    <div class="vab-note" data-vab-canary-status>${statusText}</div>
    <pre data-vab-canary-output style="max-height:260px;overflow:auto;white-space:pre-wrap">（尚未生成）</pre>`;
  host.appendChild(box);

  box.querySelector('[data-vab-canary-generate]')?.addEventListener('click', () => {
    lastReport = collectReport();
    statusText = summarizeCanaryReport(lastReport);
    updateUi();
  });
  box.querySelector('[data-vab-canary-copy]')?.addEventListener('click', async () => {
    if (!lastReport) return;
    const ok = await copyText(JSON.stringify(lastReport, null, 2));
    statusText = ok ? '诊断JSON已复制' : '复制失败；可以直接截图下面的诊断内容';
    updateUi();
  });
  updateUi();
}

function updateUi() {
  const box = document.querySelector('#vab-canary-report-safe');
  if (!box) return;
  const status = box.querySelector('[data-vab-canary-status]');
  if (status) status.textContent = statusText;
  const out = box.querySelector('[data-vab-canary-output]');
  if (out) out.textContent = lastReport ? JSON.stringify(lastReport, null, 2) : '（尚未生成）';
  const copy = box.querySelector('[data-vab-canary-copy]');
  if (copy) copy.disabled = !lastReport;
}

export function mountCanaryReportSafe() {
  if (mounted) return;
  mounted = true;
  lastReport = null;
  statusText = '尚未生成诊断';
  ensureUi();
  uiTimer = setInterval(ensureUi, UI_INTERVAL_MS);
}

export function unmountCanaryReportSafe() {
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
  document.querySelector('#vab-canary-report-safe')?.remove();
  lastReport = null;
  mounted = false;
}

export const CanaryReportSafeDiagnostics = {
  VERSION,
  collect: collectReport,
  getLastReport: () => lastReport,
};
