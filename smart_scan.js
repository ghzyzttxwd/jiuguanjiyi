// Variable Archive Bridge v0.2.0 helper
// Adds a no-configuration archive-path scanner to the existing VAB panel.

(function installVabSmartScanner() {
    if (window.__VAB_SMART_SCAN_INSTALLED__) return;
    window.__VAB_SMART_SCAN_INSTALLED__ = true;

    const VERSION = '0.2.0';

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    }

    function byteSize(value) {
        try { return new TextEncoder().encode(JSON.stringify(value)).length; }
        catch (_) { return String(value ?? '').length; }
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    function escapePointerSegment(s) {
        return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
    }

    function discover(statData) {
        if (!statData || typeof statData !== 'object' || Array.isArray(statData)) return [];
        const out = [];
        const visited = new WeakSet();
        const skipKeys = new Set(['元信息', '当前轮回', '当前任务', '当前世界', '状态', '身份']);

        function walk(node, segs, depth) {
            if (!node || typeof node !== 'object' || Array.isArray(node) || visited.has(node) || depth > 4) return;
            visited.add(node);
            const entries = Object.entries(node);
            if (segs.length && entries.length >= 2) {
                const objectish = entries.filter(([, v]) => v && typeof v === 'object').length;
                const scalarCount = entries.filter(([, v]) => v === null || ['string','number','boolean'].includes(typeof v)).length;
                const ratio = objectish / entries.length;
                const last = segs[segs.length - 1];
                if (ratio >= 0.65 && scalarCount <= Math.max(1, Math.floor(entries.length * 0.25)) && !skipKeys.has(last)) {
                    const path = '/' + segs.map(escapePointerSegment).join('/');
                    const size = byteSize(node);
                    const score = ratio * 100 + Math.min(entries.length, 30) + Math.min(size / 1024, 20);
                    out.push({ path, count: entries.length, size, score });
                }
            }
            if (depth >= 4) return;
            for (const [k, v] of entries) {
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, [...segs, k], depth + 1);
            }
        }

        walk(statData, [], 0);
        return out.sort((a,b) => b.score - a.score || b.size - a.size).slice(0, 18);
    }

    function patchPanel() {
        const panel = document.querySelector('#vab-settings');
        if (!panel) return;

        const versionEl = panel.querySelector('.vab-header small');
        if (versionEl && versionEl.textContent !== `v${VERSION}`) versionEl.textContent = `v${VERSION}`;

        const root = panel.querySelector('#vab-root');
        const addRow = root?.querySelector('.vab-add-row');
        if (!root || !addRow) return;
        if (root.querySelector('#vab-smart-scan')) return;

        const box = document.createElement('details');
        box.id = 'vab-smart-scan';
        box.className = 'vab-section';
        box.open = true;
        box.innerHTML = `
          <summary>✨ 不会填路径？自动扫描当前MVU</summary>
          <div class="vab-note">不用去变量管理器找 stat_data。这里只推荐“下面大多是独立对象”的路径；点“添加”只加入白名单，不会立刻删除变量。</div>
          <div class="vab-actions"><button class="menu_button" data-vab-smart-refresh>扫描可归档路径</button></div>
          <div data-vab-smart-list class="vab-child-list"><div class="vab-empty">点上面的“扫描可归档路径”。</div></div>`;
        addRow.insertAdjacentElement('afterend', box);

        const render = () => {
            const list = box.querySelector('[data-vab-smart-list]');
            const state = window.VariableArchiveBridge?.getState?.();
            const stat = state?.latestMvu?.statData;
            const candidates = discover(stat);
            if (!stat) {
                list.innerHTML = '<div class="vab-empty">当前没有检测到MVU，请先进入变量卡聊天并点插件“刷新”。</div>';
                return;
            }
            if (!candidates.length) {
                list.innerHTML = '<div class="vab-empty">当前没有明显需要归档的字典型路径。先正常玩即可，变量变多后再扫描。</div>';
                return;
            }
            list.innerHTML = candidates.map(c => `
              <div class="vab-child-row">
                <div class="vab-child-main"><b>${escapeHtml(c.path)}</b><small>${c.count}个直接子项 · ${formatBytes(c.size)}</small></div>
                <button class="menu_button" data-vab-smart-add="${escapeHtml(c.path)}">添加</button>
              </div>`).join('');
            list.querySelectorAll('[data-vab-smart-add]').forEach(btn => btn.addEventListener('click', () => {
                const input = root.querySelector('#vab-new-path');
                const add = root.querySelector('[data-vab="add-path"]');
                if (!input || !add) return;
                input.value = btn.dataset.vabSmartAdd;
                add.click();
            }));
        };

        box.querySelector('[data-vab-smart-refresh]')?.addEventListener('click', render);
        render();
    }

    const observer = new MutationObserver(() => patchPanel());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(patchPanel, 1500);
    patchPanel();
})();
