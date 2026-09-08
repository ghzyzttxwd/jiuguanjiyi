// Unified visible version surface for Variable Archive Bridge.
// Internal modules keep their own lineage versions; user-facing headers always show the installed plugin release.
// No MutationObserver: patch a few times during startup, then stop.

const FALLBACK_VERSION = '0.7.0';
const MAX_ATTEMPTS = 16;
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

function patchVisibleVersions() {
  const version = pluginVersion();
  let found = 0;

  const main = document.querySelector('#vab-settings .vab-header small');
  if (main) {
    main.textContent = `v${version}`;
    found += 1;
  }

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
