// Mobile Canary companion loader.
// IMPORTANT: normal startup stays inert. No experimental module is imported until explicit click.

(function installVabMobileCanaryLoader() {
    if (window.__VAB_MOBILE_CANARY_LOADER_INSTALLED__) return;
    window.__VAB_MOBILE_CANARY_LOADER_INSTALLED__ = true;
    window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'loader-mounted';

    let loadedModules = null;
    let loading = false;
    let statusText = 'Canary未加载。稳定版变量归档桥继续独立运行。';

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function getStableVab() {
        try {
            return window.VariableArchiveBridge || window.parent?.VariableArchiveBridge || null;
        } catch {
            return window.VariableArchiveBridge || null;
        }
    }

    function stableReady() {
        try {
            const vab = getStableVab();
            return !!(vab?.getState && vab?.refreshCurrent && vab?.archiveChild);
        } catch {
            return false;
        }
    }

    function getStablePanel() {
        return document.querySelector('#vab-settings');
    }

    function ensureUi() {
        const stablePanel = getStablePanel();
        if (!stablePanel) return;

        const existing = document.querySelector('#vab-mobile-canary-loader');
        if (existing) {
            window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'ui-present';
            return;
        }

        const box = document.createElement('details');
        box.id = 'vab-mobile-canary-loader';
        box.className = 'vab-section';
        box.open = true;
        box.innerHTML = `
          <summary>🧪 Mobile Canary 伴侣</summary>
          <div class="vab-note">
            这是独立Canary伴侣，不包含稳定版归档核心。正常启动只显示这个入口，不加载RC模块、不修改MVU。若Canary有问题，只需删除本伴侣扩展，稳定版仍保留。
          </div>
          <div class="vab-actions">
            <button class="menu_button" data-vab-canary-load>加载统一主控RC</button>
            <button class="menu_button" data-vab-canary-unload disabled>卸载统一主控RC</button>
          </div>
          <div class="vab-note" data-vab-canary-loader-status>${escapeHtml(statusText)}</div>
          <div id="vab-rc-host"></div>`;

        // Critical isolation: mount as a sibling of the stable VAB panel.
        // Stable v0.1.4 may rerender #vab-root with innerHTML, so anything inserted inside
        // #vab-root can be erased. A sibling survives those rerenders.
        stablePanel.insertAdjacentElement('beforebegin', box);
        window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'ui-mounted';

        const loadBtn = box.querySelector('[data-vab-canary-load]');
        const unloadBtn = box.querySelector('[data-vab-canary-unload]');
        const status = box.querySelector('[data-vab-canary-loader-status]');

        const sync = () => {
            if (status) status.textContent = statusText;
            if (loadBtn) loadBtn.disabled = loading || !!loadedModules || !stableReady();
            if (unloadBtn) unloadBtn.disabled = loading || !loadedModules;
        };

        loadBtn?.addEventListener('click', async () => {
            if (loading || loadedModules) return;
            if (!stableReady()) {
                statusText = '稳定版变量归档桥尚未就绪，Canary拒绝加载。';
                sync();
                return;
            }

            loading = true;
            statusText = '正在载入最小Canary栈；所有自动开关保持关闭…';
            window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'rc-loading';
            sync();

            let recall = null;
            let autoLifecycle = null;
            let memoryMaster = null;
            let canaryReport = null;
            try {
                recall = await import('./experimental/recall_safe.js');
                autoLifecycle = await import('./experimental/auto_lifecycle_safe.js');
                memoryMaster = await import('./experimental/memory_master_safe.js');
                canaryReport = await import('./experimental/canary_report_safe.js');

                if (typeof recall.mountRecallSafe !== 'function') throw new Error('召回RC缺少mount');
                if (typeof autoLifecycle.mountAutoLifecycleSafe !== 'function') throw new Error('生命周期RC缺少mount');
                if (typeof memoryMaster.mountMemoryMasterSafe !== 'function') throw new Error('主控RC缺少mount');
                if (typeof canaryReport.mountCanaryReportSafe !== 'function') throw new Error('诊断RC缺少mount');

                recall.mountRecallSafe();
                autoLifecycle.mountAutoLifecycleSafe();
                memoryMaster.mountMemoryMasterSafe();
                canaryReport.mountCanaryReportSafe();

                loadedModules = { recall, autoLifecycle, memoryMaster, canaryReport };
                statusText = '✅ Canary栈已载入，但自动功能仍关闭。先用“统一安全预检”，需要时再开最上方统一主控。';
                window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'rc-loaded';
            } catch (error) {
                try { canaryReport?.unmountCanaryReportSafe?.(); } catch {}
                try { await memoryMaster?.unmountMemoryMasterSafe?.(); } catch {}
                try { autoLifecycle?.unmountAutoLifecycleSafe?.(); } catch {}
                try { await recall?.unmountRecallSafe?.(); } catch {}
                loadedModules = null;
                statusText = `Canary载入失败并已回滚：${error?.message || error}`;
                window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'rc-load-failed';
                console.error('[VAB Mobile Canary]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        unloadBtn?.addEventListener('click', async () => {
            if (loading || !loadedModules) return;
            loading = true;
            statusText = '正在卸载Canary栈…';
            sync();
            try {
                loadedModules.canaryReport?.unmountCanaryReportSafe?.();
                await loadedModules.memoryMaster?.unmountMemoryMasterSafe?.();
                loadedModules.autoLifecycle?.unmountAutoLifecycleSafe?.();
                await loadedModules.recall?.unmountRecallSafe?.();
                loadedModules = null;
                statusText = 'Canary栈已卸载。稳定版变量归档桥未受影响。';
                window.__VAB_MOBILE_CANARY_BOOT_STATE__ = 'ui-mounted';
            } catch (error) {
                statusText = `Canary卸载异常：${error?.message || error}`;
                console.error('[VAB Mobile Canary]', error);
            } finally {
                loading = false;
                sync();
            }
        });

        sync();
    }

    // No MutationObserver. One low-frequency presence check only.
    const timer = setInterval(ensureUi, 3000);
    window.__VAB_MOBILE_CANARY_LOADER_TIMER__ = timer;
    ensureUi();
})();
