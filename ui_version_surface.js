// Unified visible version surface for Variable Archive Bridge.
// Internal modules keep their own lineage versions; user-facing headers always show the installed plugin release.
// No MutationObserver: patch a few times during startup, then stop.

const FALLBACK_VERSION = '0.8.0';
const MAX_ATTEMPTS = 20;
const RETRY_MS = 750;

let attempts = 0;
let timer = null;

function pluginVersion() {
  try {
    return String(
      window.VariableArchiveBridgeSelfUpdate?.VERSION
      || window.parent?.VariableArchiveBridgeSelfUpdate?.VERSION
      || FALLBACK_VERSION,
    );
  } catch {
    return FALLBACK_VERSION;
  }
}

function patchMainHeader(version) {
  const root = document.querySelector('#vab-settings');
  if (!root) return 0;

  const direct = root.querySelector('.vab-header small');
  if (direct) {
    direct.textContent = `v${version}`;
    return 1;
  }

  // Some Android layouts render the whole drawer title as plain text rather than
  // the desktop .vab-header/small structure. Patch only nodes inside this extension
  // that actually contain the product title, preserving icons/toggles/other children.
  const candidates = root.querySelectorAll('summary, .inline-drawer-header, .inline-drawer-toggle, .vab-header, h3, h4, div');
  for (const el of candidates) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text.includes('变量归档桥')) continue;
    if (!/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.test(text)) continue;

    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const before = String(node.nodeValue || '');
      if (!before.includes('变量归档桥')) continue;
      node.nodeValue = before.replace(/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/, `v${version}`);
      return 1;
    }

    if (el.children.length === 0) {
      el.textContent = text.replace(/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/, `v${version}`);
      return 1;
    }
  }
  return 0;
}

function patchVisibleVersions() {
  const version = pluginVersion();
  let found = 0;

  found += patchMainHeader(version);

  const governor = document.querySelector('#vab-governor-settings .vab-governor-header small');
  if (governor) {
    governor.textContent = `插件 v${version} · 降温预览`;
    found += 1;
  }

  const autoMemory = document.querySelector('#vab-production-auto > summary');
  if (autoMemory) {
    autoMemory.textContent = `🧠📦 自动记忆 · 插件 v${version}`;
    found += 1;
  }

  return found;
}

function schedulePatch() {
  if (timer) clearTimeout(timer);
  const found = patchVisibleVersions();
  attempts += 1;
  if (found >= 3 || attempts >= MAX_ATTEMPTS) return;
  timer = setTimeout(schedulePatch, RETRY_MS);
}

function start() {
  attempts = 0;
  schedulePatch();
  window.addEventListener('focus', patchVisibleVersions);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) patchVisibleVersions();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeUiVersion = {
  getVersion: pluginVersion,
  patch: patchVisibleVersions,
};
