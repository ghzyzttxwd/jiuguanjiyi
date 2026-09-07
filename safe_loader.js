// Variable Archive Bridge v0.1.4 safety gate
// This file is intentionally tiny and inert: it never loads Smart Host automatically.
// The experimental module is imported only after an explicit user click.

(function installVabSafeLoader() {
    if (window.__VAB_SAFE_LOADER_INSTALLED__) return;
    window.__VAB_SAFE_LOADER_INSTALLED__ = true;

    let loadedModule = null;
    let loading = false;
    let statusText = '未加载。重启酒馆后仍保持未加载。';

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function ensureUi() {
        const root = document.querySelector('#vab-settings #vab-root');
        if (!root || root.querySelector('#vab-safe-loader')) return;

        const box = document.createElement('details');
        box.id = 'vab-safe-loader';
        box.className = 'vab-section';
        box.open = true;
        box.innerHTML = `
          <summary>🧪 智能托管安全测试入口</summary>
          <div class="vab-note">
            这里不会自动启动任何实验逻辑。只有你主动点击“加载候选模块”时，才临时载入安全候选版；默认仍不开启自动托管。重启酒馆后不会自动再次载入。
          </div>
          <div class="vab-actions">
            <button class="menu_button" data-vab-safe-load>加载候选模块</button>
            <button class="menu_button" data-vab-safe-unload disabled>卸载候选模块</button>
          </div>
          <div class="vab-note" data-vab-safe-loader-status>${escapeHtml(statusText)}</div>`;

        const anchor = root.querySelector('#vab-smart-scan');
        if (anchor) anchor.insertAdjacentElement('beforebegin', box);
        else root.prepend(box);

        const loadBtn = box.querySelector('[data-vab-safe-load]');
        const unloadBtn = box.querySelector('[data-vab-safe-unload]');
        const status = box.querySelector('[data-vab-safe-loader-status]');

        const sync = () => {
            if (status) status.textContent = statusText;
            if (loadBtn) loadBtn.disabled = loading || !!loadedModule;
            if (unloadBtn) unloadBtn.disabled = loading || !loadedModule;
        };

        loadBtn?.addEventListener('click', async () => {
            if (loading || loadedModule) return;
            loading = true;
            statusText = '正在载入候选模块（只加载，不自动开启托管）…';
            sync();
            try {
                const mod = await import('./experimental/smart_host_safe.js');
                if (typeof mod.mountSmartHostSafe !== 'function') {
                    throw new Error('候选模块缺少 mountSmartHostSafe()');
                }
                mod.mountSmartHostSafe();
                loadedModule = mod;
                statusText = '候选模块已载入；智能托管仍默认关闭。先只用“只读检查”。';
            } catch (error) {
                loadedModule = null;
                statusText = `载入失败：${error?.message || error}`;
                console.error('[VAB Safe Loader]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        unloadBtn?.addEventListener('click', () => {
            try {
                loadedModule?.unmountSmartHostSafe?.();
                loadedModule = null;
                statusText = '候选模块已卸载。重启也不会自动加载。';
            } catch (error) {
                statusText = `卸载异常：${error?.message || error}`;
                console.error('[VAB Safe Loader]', error);
            }
            sync();
        });

        sync();
    }

    // No MutationObserver: one lightweight UI check only.
    const timer = setInterval(ensureUi, 3000);
    window.__VAB_SAFE_LOADER_TIMER__ = timer;
    ensureUi();
})();
