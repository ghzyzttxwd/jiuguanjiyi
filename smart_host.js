// Variable Archive Bridge v0.2.0 smart hosting
// Generic MVU lifecycle manager: discover -> cool -> archive -> restore on demand.

(function installVabSmartHost() {
    if (window.__VAB_SMART_HOST_INSTALLED__) return;
    window.__VAB_SMART_HOST_INSTALLED__ = true;

    const VERSION = '0.2.0';
    const SETTINGS_KEY = 'vab.smartHost.settings.v1';
    const ACTIVITY_KEY = 'vab.smartHost.activity.v1';
    const LOOP_MS = 6000;

    const defaults = {
        enabled: false,
        autoRestore: true,
        minIdleMessages: 30,
        minChildren: 24,
        targetChildren: 18,
        maxActionGapMs: 12000,
        recentMentionMessages: 6,
    };

    let cfg = loadJson(SETTINGS_KEY, defaults);
    cfg = { ...defaults, ...cfg };
    let activity = loadJson(ACTIVITY_KEY, {});
    let lastActionAt = 0;
    let lastStatus = '待机';
    let loopBusy = false;

    function loadJson(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || '') || structuredClone(fallback); }
        catch (_) { return structuredClone(fallback); }
    }
    function saveCfg() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); }
    function saveActivity() { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity)); }
    function escapeHtml(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
    function byteSize(v) { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch (_) { return 0; } }
    function hash(v) {
        let s; try { s = JSON.stringify(v); } catch (_) { s = String(v); }
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
    }
    function escPtr(s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }
    function unescPtr(s) { return String(s).replace(/~1/g, '/').replace(/~0/g, '~'); }
    function parsePtr(path) { return String(path || '').split('/').slice(1).map(unescPtr); }
    function getByPtr(root, path) {
        let cur = root;
        for (const seg of parsePtr(path)) {
            if (cur == null || typeof cur !== 'object') return undefined;
            cur = cur[seg];
        }
        return cur;
    }
    function hasByPtr(root, path) { return getByPtr(root, path) !== undefined; }

    function ctx() {
        try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
        catch (_) { return null; }
    }

    function recentUserText(n = cfg.recentMentionMessages) {
        const chat = ctx()?.chat || [];
        return chat.filter(m => m && m.is_user).slice(-Math.max(1, n)).map(m => String(m.mes || '')).join('\n');
    }

    function currentMessageCount() { return ctx()?.chat?.length ?? 0; }

    function protectedPath(path) {
        const last = parsePtr(path).at(-1) || '';
        return /^(当前|current|状态|status|元信息|metadata|身份|identity|任务|task)$/i.test(last);
    }

    function discover(statData) {
        if (!statData || typeof statData !== 'object' || Array.isArray(statData)) return [];
        const out = [];
        const seen = new WeakSet();
        function walk(node, segs, depth) {
            if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node) || depth > 4) return;
            seen.add(node);
            const entries = Object.entries(node);
            if (segs.length && entries.length >= 2) {
                const objectish = entries.filter(([,v]) => v && typeof v === 'object' && !Array.isArray(v)).length;
                const scalars = entries.filter(([,v]) => v == null || ['string','number','boolean'].includes(typeof v)).length;
                const ratio = objectish / entries.length;
                const path = '/' + segs.map(escPtr).join('/');
                if (ratio >= 0.60 && scalars <= Math.max(2, Math.floor(entries.length * 0.30)) && !protectedPath(path)) {
                    out.push({ path, node, entries, size: byteSize(node) });
                }
            }
            if (depth >= 4) return;
            for (const [k,v] of entries) if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, [...segs, k], depth + 1);
        }
        walk(statData, [], 0);
        return out.sort((a,b) => b.size - a.size);
    }

    function scopeActivity(scopeKey) { return activity[scopeKey] ||= {}; }

    function observeActivity(state) {
        const stat = state?.latestMvu?.statData;
        const scopeKey = state?.current?.scopeKey;
        if (!stat || !scopeKey) return;
        const msgCount = currentMessageCount();
        const root = scopeActivity(scopeKey);
        for (const c of discover(stat)) {
            const cstate = root[c.path] ||= {};
            for (const [key,val] of c.entries) {
                const hv = hash(val);
                if (!cstate[key] || cstate[key].hash !== hv) cstate[key] = { hash: hv, lastTouched: msgCount };
            }
            for (const oldKey of Object.keys(cstate)) if (!(oldKey in c.node)) delete cstate[oldKey];
        }
        saveActivity();
    }

    function adaptiveLimit(container) {
        const count = container.entries.length || 1;
        const avg = container.size / count;
        // Bigger records get a lower hot-set ceiling; tiny records can stay hot longer.
        if (avg >= 4096) return Math.max(10, Math.min(cfg.minChildren, 14));
        if (avg >= 2048) return Math.max(12, Math.min(cfg.minChildren, 18));
        if (avg >= 1024) return Math.max(16, Math.min(cfg.minChildren, 22));
        return Math.max(20, cfg.minChildren);
    }

    function mentioned(text, key) {
        const k = String(key || '').trim();
        if (k.length < 2) return false;
        return text.includes(k);
    }

    async function tryAutoRestore(vab, state) {
        if (!cfg.autoRestore) return false;
        const text = recentUserText(3);
        if (!text.trim()) return false;
        const stat = state.latestMvu?.statData;
        const archives = (state.archiveCache || []).filter(r => r.status === 'archived');
        for (const r of archives) {
            if (!mentioned(text, r.childKey)) continue;
            if (hasByPtr(stat, r.pointer)) continue;
            lastStatus = `正在恢复：${r.childKey}`;
            patchPanel();
            await vab.restoreArchive(r.id);
            lastActionAt = Date.now();
            lastStatus = `已自动恢复：${r.childKey}`;
            return true;
        }
        return false;
    }

    async function tryAutoArchive(vab, state) {
        const stat = state.latestMvu?.statData;
        const scopeKey = state.current?.scopeKey;
        if (!stat || !scopeKey) return false;
        const msgCount = currentMessageCount();
        const text = recentUserText();
        const root = scopeActivity(scopeKey);

        for (const c of discover(stat)) {
            const limit = adaptiveLimit(c);
            if (c.entries.length <= limit) continue;
            const target = Math.max(8, Math.min(cfg.targetChildren, limit));
            const need = c.entries.length - target;
            if (need <= 0) continue;
            const cstate = root[c.path] || {};
            const candidates = c.entries
                .map(([key,val]) => ({ key, size: byteSize(val), last: cstate[key]?.lastTouched ?? msgCount }))
                .filter(x => msgCount - x.last >= cfg.minIdleMessages)
                .filter(x => !mentioned(text, x.key))
                .sort((a,b) => a.last - b.last || b.size - a.size);
            if (!candidates.length) continue;
            const pick = candidates[0];
            lastStatus = `正在归档：${pick.key}`;
            patchPanel();
            await vab.archiveChild(c.path, pick.key, { automatic: true });
            lastActionAt = Date.now();
            lastStatus = `已自动归档：${pick.key}`;
            return true; // One mutation per cycle for transactional safety.
        }
        return false;
    }

    async function runCycle({ force = false } = {}) {
        if (loopBusy || !cfg.enabled) return;
        if (!force && Date.now() - lastActionAt < cfg.maxActionGapMs) return;
        const vab = window.VariableArchiveBridge;
        if (!vab?.getState || !vab?.archiveChild || !vab?.restoreArchive) return;
        loopBusy = true;
        try {
            await vab.refreshCurrent?.({ render: false });
            let state = vab.getState();
            if (!state?.latestMvu?.statData || !state?.current?.scopeKey) {
                lastStatus = '未检测到当前MVU';
                return;
            }
            observeActivity(state);
            if (await tryAutoRestore(vab, state)) return;
            state = vab.getState();
            if (await tryAutoArchive(vab, state)) return;
            lastStatus = '智能托管正常 · 本轮无需迁移';
        } catch (e) {
            lastStatus = `托管异常：${e?.message || e}`;
            console.warn('[VAB SmartHost]', e);
        } finally {
            loopBusy = false;
            patchPanel();
        }
    }

    function patchVersion(panel) {
        const v = panel.querySelector('.vab-header small');
        if (v) v.textContent = `v${VERSION}`;
    }

    function patchPanel() {
        const panel = document.querySelector('#vab-settings');
        if (!panel) return;
        patchVersion(panel);
        const root = panel.querySelector('#vab-root');
        if (!root) return;
        let box = root.querySelector('#vab-smart-host');
        if (!box) {
            box = document.createElement('details');
            box.id = 'vab-smart-host';
            box.className = 'vab-section';
            box.open = true;
            box.innerHTML = `
              <summary>🧠 智能托管（推荐日常使用）</summary>
              <label class="checkbox_label"><input type="checkbox" data-vab-host-enabled> 智能托管总开关</label>
              <label class="checkbox_label"><input type="checkbox" data-vab-host-restore> 提到冷档案时自动恢复为热变量</label>
              <div class="vab-note">只需开一次。插件会自动识别任意变量卡里的增长型对象容器；仅在数据明显变多且长期闲置时迁出，每次只处理1项，且沿用归档桥的“先快照、再迁移、再验证”事务安全链。当前/状态/身份等核心节点默认保护。</div>
              <div class="vab-actions"><button class="menu_button" data-vab-host-run>立即检查一次</button></div>
              <div class="vab-status-row"><span class="vab-badge ${cfg.enabled ? 'ok' : 'off'}" data-vab-host-status></span></div>
              <details><summary>高级阈值（一般不用动）</summary>
                <label>至少闲置消息 <input class="vab-num" type="number" min="5" data-vab-host-idle></label>
                <label>小对象热区基准 <input class="vab-num" type="number" min="10" data-vab-host-min></label>
                <label>归档后目标项数 <input class="vab-num" type="number" min="5" data-vab-host-target></label>
              </details>`;
            const smartScan = root.querySelector('#vab-smart-scan');
            if (smartScan) smartScan.insertAdjacentElement('beforebegin', box);
            else root.prepend(box);

            box.querySelector('[data-vab-host-enabled]')?.addEventListener('change', e => {
                cfg.enabled = !!e.target.checked; saveCfg(); lastStatus = cfg.enabled ? '智能托管已开启' : '智能托管已关闭'; patchPanel();
                if (cfg.enabled) setTimeout(() => runCycle({ force: true }), 100);
            });
            box.querySelector('[data-vab-host-restore]')?.addEventListener('change', e => { cfg.autoRestore = !!e.target.checked; saveCfg(); });
            box.querySelector('[data-vab-host-run]')?.addEventListener('click', () => runCycle({ force: true }));
            box.querySelector('[data-vab-host-idle]')?.addEventListener('change', e => { cfg.minIdleMessages = Math.max(5, Number(e.target.value)||30); saveCfg(); });
            box.querySelector('[data-vab-host-min]')?.addEventListener('change', e => { cfg.minChildren = Math.max(10, Number(e.target.value)||24); saveCfg(); });
            box.querySelector('[data-vab-host-target]')?.addEventListener('change', e => { cfg.targetChildren = Math.max(5, Number(e.target.value)||18); saveCfg(); });
        }

        const enabled = box.querySelector('[data-vab-host-enabled]'); if (enabled) enabled.checked = !!cfg.enabled;
        const restore = box.querySelector('[data-vab-host-restore]'); if (restore) restore.checked = !!cfg.autoRestore;
        const idle = box.querySelector('[data-vab-host-idle]'); if (idle) idle.value = cfg.minIdleMessages;
        const min = box.querySelector('[data-vab-host-min]'); if (min) min.value = cfg.minChildren;
        const target = box.querySelector('[data-vab-host-target]'); if (target) target.value = cfg.targetChildren;
        const status = box.querySelector('[data-vab-host-status]');
        if (status) {
            status.className = `vab-badge ${cfg.enabled ? 'ok' : 'off'}`;
            status.textContent = `${cfg.enabled ? '●' : '○'} ${escapeHtml(lastStatus)}`;
        }
    }

    const obs = new MutationObserver(patchPanel);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(patchPanel, 1200);
    setInterval(() => runCycle(), LOOP_MS);
    patchPanel();

    window.VariableArchiveSmartHost = {
        VERSION,
        run: () => runCycle({ force: true }),
        getSettings: () => ({ ...cfg }),
        setEnabled: (v) => { cfg.enabled = !!v; saveCfg(); patchPanel(); },
    };
})();
