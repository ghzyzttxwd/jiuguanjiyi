// Variable Archive Bridge v0.1.4 safety gate
// This file stays inert on normal startup: no experimental module is imported automatically.
// The RC stack is loaded only after an explicit user click and all automatic features stay OFF.

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
          <summary>🧪 统一自动记忆 RC 安全入口</summary>
          <div class="vab-note">
            正常启动不会载入实验模块。只有你主动点击“加载统一主控RC”时，才载入最小Canary栈：冷档案Prompt召回 + 生命周期引擎 + 统一主控。旧智能托管、手动重激活、只读重激活工具不会被挂载，减少计时器、事件监听和相互干扰。所有自动开关仍默认关闭，重启后不会自动再次载入。
          </div>
          <div class="vab-actions">
            <button class="menu_button" data-vab-safe-load>加载统一主控RC</button>
            <button class="menu_button" data-vab-safe-unload disabled>卸载统一主控RC</button>
          </div>
          <div class="vab-note" data-vab-safe-loader-status>${escapeHtml(statusText)}</div>
          <div id="vab-rc-host"></div>`;

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
            statusText = '正在载入最小Canary栈（仅载入，自动功能全部保持关闭）…';
            sync();

            let recall = null;
            let autoLifecycle = null;
            let memoryMaster = null;
            try {
                recall = await import('./experimental/recall_safe.js');
                if (typeof recall.mountRecallSafe !== 'function') {
                    throw new Error('冷档案召回候选缺少 mountRecallSafe()');
                }
                recall.mountRecallSafe();

                autoLifecycle = await import('./experimental/auto_lifecycle_safe.js');
                if (typeof autoLifecycle.mountAutoLifecycleSafe !== 'function') {
                    throw new Error('统一生命周期候选缺少 mountAutoLifecycleSafe()');
                }
                autoLifecycle.mountAutoLifecycleSafe();

                memoryMaster = await import('./experimental/memory_master_safe.js');
                if (typeof memoryMaster.mountMemoryMasterSafe !== 'function') {
                    throw new Error('统一自动记忆主控候选缺少 mountMemoryMasterSafe()');
                }
                memoryMaster.mountMemoryMasterSafe();

                loadedModules = { recall, autoLifecycle, memoryMaster };
                statusText = '统一主控RC已载入；所有自动功能仍关闭。最上方“统一自动记忆主控”是唯一推荐总开关；主控只弹一次确认并直接调用子系统API。';
            } catch (error) {
                try { await memoryMaster?.unmountMemoryMasterSafe?.(); } catch {}
                try { autoLifecycle?.unmountAutoLifecycleSafe?.(); } catch {}
                try { await recall?.unmountRecallSafe?.(); } catch {}
                loadedModules = null;
                statusText = `载入失败并已回滚RC栈：${error?.message || error}`;
                console.error('[VAB Safe Loader]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        unloadBtn?.addEventListener('click', async () => {
            if (loading || !loadedModules) return;
            loading = true;
            statusText = '正在卸载统一主控RC…';
            sync();
            try {
                await loadedModules.memoryMaster?.unmountMemoryMasterSafe?.();
                loadedModules.autoLifecycle?.unmountAutoLifecycleSafe?.();
                await loadedModules.recall?.unmountRecallSafe?.();
                loadedModules = null;
                statusText = '统一主控RC已卸载。重启也不会自动加载。';
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
