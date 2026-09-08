// Variable Archive Bridge v0.4.1 MVU visibility recovery.
// Fixes a UI/state race where a transient MVU miss can clear latestMvu,
// then the core poll silently recovers the same stat hash without re-rendering.
// Read-only: never writes MVU, archives, prompts, or IndexedDB.

const CHECK_MS = 5000;
const RETRY_DELAYS = [0, 120, 320, 700];
let running = false;
let timer = null;

function core() {
  try {
    return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
  } catch {
    return null;
  }
}

function uiShowsMissingMvu() {
  try {
    const root = document.getElementById('vab-root');
    return !!root && /未检测到MVU|当前没有检测到MVU/.test(root.textContent || '');
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function recover({ force = false } = {}) {
  if (running || document.hidden) return false;
  const vab = core();
  if (!vab?.refreshCurrent || !vab?.getState) return false;

  const before = vab.getState();
  const stateMissing = !before?.latestMvu?.statData;
  const uiMissing = uiShowsMissingMvu();
  if (!force && !stateMissing && !uiMissing) return true;

  running = true;
  try {
    for (const delay of RETRY_DELAYS) {
      if (delay) await sleep(delay);
      try {
        await vab.refreshCurrent({ render: true });
      } catch {
        // Keep retrying: SillyAndroid/Tavern can expose Mvu a little later after reload.
      }
      const now = vab.getState();
      if (now?.latestMvu?.statData) {
        try {
          await window.VariableArchiveBridgeHotStateGovernor?.refresh?.();
        } catch { /* diagnostics only */ }
        return true;
      }
    }
    return false;
  } finally {
    running = false;
  }
}

function start() {
  // Startup probes cover extension reload / plugin load-order races.
  [800, 1800, 3500, 7000].forEach(ms => setTimeout(() => recover({ force: true }), ms));

  // Low-cost watchdog: when everything is healthy, it exits before any refresh call.
  if (!timer) timer = setInterval(() => recover(), CHECK_MS);

  window.addEventListener('focus', () => recover({ force: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recover({ force: true });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

window.VariableArchiveBridgeMvuRecovery = {
  recover: () => recover({ force: true }),
  getStatus: () => ({ running, checkMs: CHECK_MS, readOnly: true }),
};
