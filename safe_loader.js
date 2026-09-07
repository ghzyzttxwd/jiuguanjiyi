// Variable Archive Bridge v0.1.4 safety gate
// This file stays inert on normal startup: no experimental module is imported automatically.
// Candidate modules are loaded only after an explicit user click and all risky switches stay OFF.

(function installVabSafeLoader() {
    if (window.__VAB_SAFE_LOADER_INSTALLED__) return;
    window.__VAB_SAFE_LOADER_INSTALLED__ = true;

    let loadedModules = null;
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
            正常启动不会载入任何实验模块。只有你主动点击“加载候选模块”时，才临时载入智能托管与冷档案召回候选；两者的实际自动开关仍保持关闭。重启酒馆后不会自动再次载入。
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
            if (loadBtn) loadBtn.disabled = loading || !!loadedModules;
            if (unloadBtn) unloadBtn.disabled = loading || !loadedModules;
        };

        loadBtn?.addEventListener('click', async () => {
            if (loading || loadedModules) return;
            loading = true;
            statusText = '正在载入安全候选模块（只加载，自动功能全部保持关闭）…';
            sync();

            let smart = null;
            let recall = null;
            try {
                smart = await import('./experimental/smart_host_safe.js');
                if (typeof smart.mountSmartHostSafe !== 'function') {
                    throw new Error('智能托管候选缺少 mountSmartHostSafe()');
                }
                smart.mountSmartHostSafe();

                recall = await import('./experimental/recall_safe.js');
                if (typeof recall.mountRecallSafe !== 'function') {
                    throw new Error('冷档案召回候选缺少 mountRecallSafe()');
                }
                recall.mountRecallSafe();

                loadedModules = { smart, recall };
                statusText = '候选模块已载入；智能托管与实际Prompt召回都仍关闭。可只用“只读检查/预览”。';
            } catch (error) {
                try { await recall?.unmountRecallSafe?.(); } catch {}
                try { smart?.unmountSmartHostSafe?.(); } catch {}
                loadedModules = null;
                statusText = `载入失败并已回滚候选模块：${error?.message || error}`;
                console.error('[VAB Safe Loader]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        unloadBtn?.addEventListener('click', async () => {
            if (loading || !loadedModules) return;
            loading = true;
            statusText = '正在卸载候选模块…';
            sync();
            try {
                await loadedModules.recall?.unmountRecallSafe?.();
                loadedModules.smart?.unmountSmartHostSafe?.();
                loadedModules = null;
                statusText = '候选模块已卸载。重启也不会自动加载。';
            } catch (error) {
                statusText = `卸载异常：${error?.message || error}`;
                console.error('[VAB Safe Loader]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        sync();
    }

    // No MutationObserver: one lightweight UI presence check only.
    const timer = setInterval(ensureUi, 3000);
    window.__VAB_SAFE_LOADER_TIMER__ = timer;
    ensureUi();
})();
