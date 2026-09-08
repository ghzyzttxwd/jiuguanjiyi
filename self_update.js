// Variable Archive Bridge v0.5.0 self-update surface.
// Mirrors Tavern Helper's user experience: automatically checks its own remote manifest,
// shows a Chinese "更新" button inside its own settings, and updates without requiring
// the user to open SillyTavern's extension manager.

import { hasNewerVersion, chooseUpdatePath } from './self_update_core.js';

const CURRENT_VERSION = '0.5.0';
const EXTENSION_ID = 'jiuguanjiyi';
const REPO_URL = 'https://github.com/ghzyzttxwd/jiuguanjiyi';
const REMOTE_MANIFEST = 'https://raw.githubusercontent.com/ghzyzttxwd/jiuguanjiyi/main/manifest.json';
const UPDATE_CHECK_MS = 60 * 1000;
const WIDGET_ID = 'vab-self-update';

let latestVersion = CURRENT_VERSION;
let checking = false;
let updating = false;
let lastError = '';
let lastCheckAt = 0;
let timer = null;
let queuedCheck = null;

function toast(kind, message) {
  try {
    const api = window.toastr || window.parent?.toastr;
    if (api?.[kind]) api[kind](message, '变量归档桥');
  } catch { /* no-op */ }
}

async function getRequestHeaders() {
  try {
    const mod = await import('/script.js');
    if (typeof mod.getRequestHeaders === 'function') return mod.getRequestHeaders();
  } catch { /* fall through */ }
  return { 'Content-Type': 'application/json' };
}

async function getExtensionType() {
  try {
    const mod = await import('/scripts/extensions.js');
    const types = mod.extensionTypes || {};
    const key = Object.keys(types).find(name =>
      name === EXTENSION_ID || name.endsWith(`/${EXTENSION_ID}`) || name.endsWith(EXTENSION_ID));
    return key ? types[key] : null;
  } catch {
    return null;
  }
}

function isAndroidRuntime() {
  try {
    return /Android/i.test(navigator.userAgent || '');
  } catch {
    return false;
  }
}

async function fetchLatestVersion() {
  const url = `${REMOTE_MANIFEST}?_=${Date.now()}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`远端版本检查失败：HTTP ${response.status}`);
  const manifest = await response.json();
  const version = String(manifest?.version || '').trim();
  if (!version) throw new Error('远端 manifest 没有 version');
  return version;
}

function rootNode() {
  return document.querySelector(`#${WIDGET_ID}`);
}

function render() {
  const root = rootNode();
  if (!root) return;
  const newer = hasNewerVersion(CURRENT_VERSION, latestVersion);
  const status = root.querySelector('.vab-self-update-status');
  const btn = root.querySelector('.vab-self-update-action');
  const check = root.querySelector('.vab-self-update-check');
  if (!status || !btn || !check) return;

  if (updating) {
    status.textContent = `正在更新到 v${latestVersion}…`;
    btn.textContent = '更新中…';
    btn.disabled = true;
    check.disabled = true;
    btn.style.display = '';
    return;
  }

  check.disabled = checking;
  check.textContent = checking ? '检查中…' : '重新检查';

  if (lastError) {
    status.textContent = `当前 v${CURRENT_VERSION} · 自动检查失败：${lastError}`;
    btn.style.display = 'none';
    return;
  }

  if (newer) {
    status.textContent = `当前 v${CURRENT_VERSION} · 最新 v${latestVersion}`;
    btn.textContent = '更新';
    btn.disabled = false;
    btn.style.display = '';
  } else {
    status.textContent = `当前 v${CURRENT_VERSION} · 已是最新版本 · 自动检查开启`;
    btn.style.display = 'none';
  }
}

function ensureWidget() {
  if (document.getElementById(WIDGET_ID)) return true;
  const content = document.querySelector('#vab-settings .inline-drawer-content');
  if (!content) return false;

  const wrap = document.createElement('div');
  wrap.id = WIDGET_ID;
  wrap.style.cssText = 'margin:8px 0 12px;padding:10px;border:1px solid var(--SmartThemeBorderColor,#888);border-radius:10px;';
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <div>
        <b>ℹ️ 扩展信息</b>
        <div class="vab-self-update-status" style="opacity:.8;margin-top:4px;">当前 v${CURRENT_VERSION} · 正在自动检查更新…</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="menu_button vab-self-update-check">重新检查</button>
        <button class="menu_button vab-self-update-action" style="display:none;">更新</button>
      </div>
    </div>
    <div style="opacity:.65;font-size:.9em;margin-top:6px;">自动检查已开启；发现新版本会直接显示“更新”。“重新检查”仅作备用。</div>
  `;
  content.prepend(wrap);

  wrap.querySelector('.vab-self-update-check')?.addEventListener('click', () => checkForUpdate({ force: true }));
  wrap.querySelector('.vab-self-update-action')?.addEventListener('click', () => performUpdate());
  render();
  return true;
}

async function checkForUpdate({ force = false } = {}) {
  if (checking) return latestVersion;
  const now = Date.now();
  if (!force && lastCheckAt && now - lastCheckAt < UPDATE_CHECK_MS) return latestVersion;
  checking = true;
  lastError = '';
  render();
  try {
    latestVersion = await fetchLatestVersion();
    lastCheckAt = Date.now();
    if (hasNewerVersion(CURRENT_VERSION, latestVersion)) {
      const noticeKey = `vab.update.notice.${latestVersion}`;
      if (!sessionStorage.getItem(noticeKey)) {
        sessionStorage.setItem(noticeKey, '1');
        toast('info', `发现新版本 v${latestVersion}，展开“变量归档桥”即可直接点“更新”。`);
      }
    }
    return latestVersion;
  } catch (error) {
    lastError = String(error?.message || error);
    return latestVersion;
  } finally {
    checking = false;
    render();
  }
}

function queueAutoCheck({ force = false } = {}) {
  if (queuedCheck) clearTimeout(queuedCheck);
  queuedCheck = setTimeout(() => {
    queuedCheck = null;
    checkForUpdate({ force }).catch(() => {});
  }, 250);
}

async function postExtension(path, body) {
  const headers = await getRequestHeaders();
  return fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function forceAndroidRefresh(global) {
  const response = await postExtension('/api/extensions/switch', {
    extensionName: EXTENSION_ID,
    branch: 'main',
    global,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `强制更新失败：HTTP ${response.status}`);
  }
}

async function performUpdate() {
  if (updating) return;
  await checkForUpdate({ force: true });
  if (!hasNewerVersion(CURRENT_VERSION, latestVersion)) {
    toast('success', '已经是最新版本。');
    return;
  }

  updating = true;
  lastError = '';
  render();
  try {
    const type = await getExtensionType();
    if (!type) throw new Error('无法识别变量归档桥的安装类型');
    if (type === 'system') throw new Error('系统扩展不能这样更新');
    const global = type === 'global';

    let updateOk = false;
    let backendIsUpToDate = null;
    try {
      const response = await postExtension('/api/extensions/update', {
        extensionName: EXTENSION_ID,
        global,
      });
      updateOk = response.ok;
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        backendIsUpToDate = data?.isUpToDate;
      }
    } catch {
      updateOk = false;
    }

    const path = chooseUpdatePath({
      remoteNewer: true,
      updateOk,
      backendIsUpToDate,
      isAndroid: isAndroidRuntime(),
    });

    if (path === 'force-switch') {
      await forceAndroidRefresh(global);
    } else if (path === 'manual-fallback') {
      throw new Error('酒馆更新接口没有拉到新版本，请稍后再试');
    }

    toast('success', `已更新到 v${latestVersion}，正在刷新页面…`);
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    lastError = String(error?.message || error);
    toast('error', lastError);
  } finally {
    updating = false;
    render();
  }
}

function installLifecycleChecks() {
  window.addEventListener('focus', () => queueAutoCheck({ force: true }));
  window.addEventListener('online', () => queueAutoCheck({ force: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) queueAutoCheck({ force: true });
  });
}

function start() {
  let attempts = 0;
  const attach = () => {
    attempts += 1;
    if (ensureWidget()) {
      checkForUpdate({ force: true });
      installLifecycleChecks();
      if (!timer) timer = setInterval(() => checkForUpdate(), UPDATE_CHECK_MS);
      return;
    }
    if (attempts < 30) setTimeout(attach, 1000);
  };
  attach();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeSelfUpdate = {
  VERSION: CURRENT_VERSION,
  check: () => checkForUpdate({ force: true }),
  update: performUpdate,
  getStatus: () => ({ currentVersion: CURRENT_VERSION, latestVersion, checking, updating, lastError, lastCheckAt }),
};
