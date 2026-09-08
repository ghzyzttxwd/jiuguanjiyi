/*
 * Variable Archive Bridge / 变量归档桥
 * v0.2.0
 *
 * Goal:
 *   Keep MVU stat_data small by moving cold child nodes out of user-designated
 *   archive containers into IndexedDB, with safe restore, snapshots, optional
 *   st-memory-enhancement mirroring, and an on-demand macro for prompt injection.
 *
 * Safety defaults:
 *   - legacy per-container auto archive OFF
 *   - memory mirror OFF
 *   - only direct children of explicitly configured archive containers can be removed by legacy manual tools
 *   - a full MVU snapshot is taken before every archive operation
 *   - v0.2 automatic lifecycle is coordinated separately by production_auto.js
 */

const VAB = (() => {
    'use strict';

    const VERSION = '0.2.0';
    const DB_NAME = 'variable_archive_bridge';
    const DB_VERSION = 1;
    const SETTINGS_KEY = 'vab.settings.v1';
    const TOUCH_KEY = 'vab.touches.v1';
    const POLL_MS = 4000;
    const MAX_UI_CHILDREN = 30;

    const DEFAULT_SETTINGS = {
        autoSnapshot: true,
        snapshotEveryMessages: 10,
        snapshotKeep: 20,
        autoArchiveGlobal: false,
        macroEnabled: true,
        maxInjectRecords: 6,
        maxInjectChars: 12000,
        maxInjectRecordChars: 3500,
        memoryMirrorEnabled: false,
        memoryTableIndex: 0,
        memoryMirrorMaxChars: 4000,
        includeMirroredInMacro: false,
        profiles: {},
    };

    const state = {
        initialized: false,
        db: null,
        current: null,
        archiveCache: [],
        latestMvu: null,
        lastStatHash: '',
        lastMessageCount: -1,
        pollTimer: null,
        macroRegistered: false,
        mvuEventHooked: false,
        busy: false,
        lastError: '',
        diagnostics: [],
        memoryAdapterLoadTried: false,
    };

    // ---------- generic utilities ----------

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function log(message, detail) {
        const line = `${new Date().toLocaleTimeString()} ${message}`;
        state.diagnostics.push(line);
        if (state.diagnostics.length > 80) state.diagnostics.shift();
        if (detail !== undefined) console.log('[VAB]', message, detail);
        else console.log('[VAB]', message);
    }

    function warn(message, detail) {
        state.lastError = message;
        const line = `${new Date().toLocaleTimeString()} ⚠ ${message}`;
        state.diagnostics.push(line);
        if (state.diagnostics.length > 80) state.diagnostics.shift();
        console.warn('[VAB]', message, detail ?? '');
    }

    function toast(kind, message, title = '变量归档桥') {
        const t = window.toastr;
        if (t && typeof t[kind] === 'function') t[kind](message, title);
        else console.log(`[VAB/${kind}] ${title}: ${message}`);
    }

    function deepClone(value) {
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch (_) {}
        }
        return JSON.parse(JSON.stringify(value));
    }

    function byteSize(value) {
        try { return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length; }
        catch (_) { return String(value ?? '').length; }
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    function nodeCount(value, seen = new WeakSet()) {
        if (value === null || typeof value !== 'object') return 1;
        if (seen.has(value)) return 0;
        seen.add(value);
        let n = 1;
        for (const v of Object.values(value)) n += nodeCount(v, seen);
        return n;
    }

    function fnv1a(input) {
        const s = String(input ?? '');
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    function statHash(stat) {
        try {
            const s = JSON.stringify(stat);
            return `${s.length}:${fnv1a(s)}`;
        } catch (_) {
            return `${Date.now()}`;
        }
    }

    function escapePointerSegment(s) {
        return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
    }

    function unescapePointerSegment(s) {
        return String(s).replace(/~1/g, '/').replace(/~0/g, '~');
    }

    function parsePointer(path) {
        if (path === '' || path === '/') return [];
        if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('路径必须使用 JSON Pointer，例如 /世界档案 或 /玩家/能力');
        return path.slice(1).split('/').map(unescapePointerSegment);
    }

    function cssEscape(value) {
        const str = String(value ?? '');
        if (window.CSS?.escape) return window.CSS.escape(str);
        // Conservative attribute-selector escape fallback for older Android WebViews.
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function normalizePointer(path) {
        let p = String(path ?? '').trim();
        if (!p) return '/';
        if (!p.startsWith('/')) p = '/' + p;
        return '/' + parsePointer(p).map(escapePointerSegment).join('/');
    }

    function getByPointer(root, path) {
        let cur = root;
        for (const key of parsePointer(path)) {
            if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
            cur = cur[key];
        }
        return cur;
    }

    function hasByPointer(root, path) {
        return getByPointer(root, path) !== undefined;
    }

    function setByPointer(root, path, value) {
        const segs = parsePointer(path);
        if (!segs.length) throw new Error('禁止直接覆盖 stat_data 根节点');
        let cur = root;
        for (let i = 0; i < segs.length - 1; i++) {
            const k = segs[i];
            if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
            cur = cur[k];
        }
        cur[segs.at(-1)] = value;
    }

    function deleteByPointer(root, path) {
        const segs = parsePointer(path);
        if (!segs.length) throw new Error('禁止删除 stat_data 根节点');
        let cur = root;
        for (let i = 0; i < segs.length - 1; i++) {
            const k = segs[i];
            if (cur === null || typeof cur !== 'object' || !(k in cur)) return false;
            cur = cur[k];
        }
        const k = segs.at(-1);
        if (cur && typeof cur === 'object' && k in cur) {
            if (Array.isArray(cur) && /^\d+$/.test(k)) cur.splice(Number(k), 1);
            else delete cur[k];
            return true;
        }
        return false;
    }

    function childPointer(containerPath, childKey) {
        const base = normalizePointer(containerPath).replace(/\/$/, '');
        return `${base}/${escapePointerSegment(childKey)}`;
    }

    function summarizeNode(childKey, node) {
        const labelKeys = ['名称', '姓名', '标题', 'name', 'title', '世界名称', '角色名', '物品名', '技能名'];
        const primitiveParts = [];
        if (node && typeof node === 'object' && !Array.isArray(node)) {
            for (const k of labelKeys) {
                if (typeof node[k] === 'string' && node[k].trim()) primitiveParts.push(`${k}:${node[k].trim()}`);
            }
            for (const [k, v] of Object.entries(node)) {
                if (primitiveParts.length >= 7) break;
                if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
                    const sv = String(v ?? '').replace(/\s+/g, ' ').trim();
                    if (sv && sv.length <= 100 && !labelKeys.includes(k)) primitiveParts.push(`${k}:${sv}`);
                }
            }
        } else if (Array.isArray(node)) {
            primitiveParts.push(`数组:${node.length}项`);
        } else {
            primitiveParts.push(String(node));
        }
        const body = primitiveParts.join('；');
        const result = `${childKey}${body ? '｜' + body : ''}`;
        return result.length > 520 ? result.slice(0, 517) + '…' : result;
    }

    function extractTags(path, childKey, summary) {
        const parts = [childKey, ...parsePointer(path), ...String(summary).split(/[\s,，。；;：:|｜/\\\[\]{}()（）<>《》"'`]+/)]
            .map(x => String(x).trim())
            .filter(x => x.length >= 2 && x.length <= 32);
        return [...new Set(parts)].slice(0, 30);
    }

    function makeId(prefix = 'vab') {
        return `${prefix}_${Date.now()}_${crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    }

    function downloadText(filename, text, type = 'application/json') {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---------- settings ----------

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return mergeSettings(DEFAULT_SETTINGS, parsed);
        } catch (e) {
            warn('读取设置失败，已使用默认设置', e);
            return deepClone(DEFAULT_SETTINGS);
        }
    }

    function mergeSettings(base, incoming) {
        const out = deepClone(base);
        if (!incoming || typeof incoming !== 'object') return out;
        for (const [k, v] of Object.entries(incoming)) {
            if (k === 'profiles' && v && typeof v === 'object') out.profiles = v;
            else if (k in out) out[k] = v;
        }
        return out;
    }

    let settings = loadSettings();

    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function getProfile(cardKey) {
        if (!settings.profiles[cardKey]) settings.profiles[cardKey] = { containers: [] };
        if (!Array.isArray(settings.profiles[cardKey].containers)) settings.profiles[cardKey].containers = [];
        return settings.profiles[cardKey];
    }

    function loadTouches() {
        try { return JSON.parse(localStorage.getItem(TOUCH_KEY) || '{}'); }
        catch (_) { return {}; }
    }

    let touches = loadTouches();
    function saveTouches() { localStorage.setItem(TOUCH_KEY, JSON.stringify(touches)); }

    // ---------- IndexedDB ----------

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('archives')) {
                    const s = db.createObjectStore('archives', { keyPath: 'id' });
                    s.createIndex('scopeKey', 'scopeKey', { unique: false });
                    s.createIndex('status', 'status', { unique: false });
                    s.createIndex('archivedAt', 'archivedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('snapshots')) {
                    const s = db.createObjectStore('snapshots', { keyPath: 'id' });
                    s.createIndex('scopeKey', 'scopeKey', { unique: false });
                    s.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function txStore(name, mode = 'readonly') {
        const tx = state.db.transaction(name, mode);
        return [tx, tx.objectStore(name)];
    }

    function idbReq(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function putArchive(record) {
        const [, store] = txStore('archives', 'readwrite');
        await idbReq(store.put(record));
    }

    async function deleteArchiveRecord(id) {
        const [, store] = txStore('archives', 'readwrite');
        await idbReq(store.delete(id));
    }

    async function listArchives(scopeKey, includeRestored = false) {
        const [, store] = txStore('archives');
        const all = await idbReq(store.index('scopeKey').getAll(scopeKey));
        return all
            .filter(r => includeRestored || r.status === 'archived')
            .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    }

    async function putSnapshot(record) {
        const [, store] = txStore('snapshots', 'readwrite');
        await idbReq(store.put(record));
    }

    async function listSnapshots(scopeKey) {
        const [, store] = txStore('snapshots');
        const all = await idbReq(store.index('scopeKey').getAll(scopeKey));
        return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    async function pruneSnapshots(scopeKey) {
        const all = await listSnapshots(scopeKey);
        const excess = all.slice(Math.max(1, Number(settings.snapshotKeep) || 20));
        if (!excess.length) return;
        const [, store] = txStore('snapshots', 'readwrite');
        for (const item of excess) store.delete(item.id);
    }

    // ---------- SillyTavern/MVU discovery ----------

    function ctx() {
        try { return window.SillyTavern?.getContext?.() ?? null; }
        catch (_) { return null; }
    }

    function getIdentity() {
        const c = ctx();
        if (!c) return { cardKey: 'no-card', scopeKey: 'no-chat', scopeLabel: '无活动聊天', chatId: '' };
        const isGroup = c.groupId !== null && c.groupId !== undefined && String(c.groupId) !== '';
        let cardLabel = '';
        let cardRaw = '';
        if (isGroup) {
            cardLabel = c.groups?.find?.(g => String(g.id) === String(c.groupId))?.name || `群聊 ${c.groupId}`;
            cardRaw = `group:${c.groupId}`;
        } else {
            const ch = c.characters?.[c.characterId];
            cardLabel = ch?.name || c.name2 || `角色 ${c.characterId ?? '?'}`;
            cardRaw = `char:${c.characterId ?? ''}:${ch?.avatar || cardLabel}`;
        }
        const chatId = String(c.getCurrentChatId?.() || c.chatId || c.chatMetadata?.chat_id || c.chat_metadata?.chat_id || c.chat?.[0]?.send_date || 'unsaved');
        const cardKey = `card_${fnv1a(cardRaw)}`;
        const scopeKey = `${cardKey}:chat_${fnv1a(chatId)}`;
        return { cardKey, cardLabel, scopeKey, scopeLabel: `${cardLabel} / ${chatId}`, chatId };
    }

    function resolveMvu() {
        return window.Mvu || window.parent?.Mvu || null;
    }

    async function findLatestMvu() {
        const mvu = resolveMvu();
        const c = ctx();
        if (!mvu?.getMvuData || !c?.chat?.length) return null;
        for (let i = c.chat.length - 1; i >= 0; i--) {
            try {
                const variables = mvu.getMvuData({ type: 'message', message_id: i });
                if (variables && variables.stat_data && typeof variables.stat_data === 'object') {
                    return { messageId: i, variables, statData: variables.stat_data };
                }
            } catch (_) {}
        }
        return null;
    }

    async function writeMvu(messageId, variables) {
        const mvu = resolveMvu();
        if (!mvu?.replaceMvuData) throw new Error('未找到 Mvu.replaceMvuData，无法写回变量');
        await mvu.replaceMvuData(variables, { type: 'message', message_id: messageId });
    }

    async function refreshCurrent({ render = true } = {}) {
        state.current = getIdentity();
        state.latestMvu = await findLatestMvu();
        state.archiveCache = state.db ? await listArchives(state.current.scopeKey) : [];
        if (state.latestMvu) state.lastStatHash = statHash(state.latestMvu.statData);
        if (render) renderPanel();
        return state.latestMvu;
    }

    // ---------- snapshots ----------

    async function saveSnapshot(reason = 'manual') {
        const latest = await refreshCurrent({ render: false });
        if (!latest) throw new Error('当前聊天没有可用的 MVU stat_data');
        const rec = {
            id: makeId('snap'),
            scopeKey: state.current.scopeKey,
            scopeLabel: state.current.scopeLabel,
            cardKey: state.current.cardKey,
            messageId: latest.messageId,
            messageCount: ctx()?.chat?.length ?? 0,
            createdAt: Date.now(),
            reason,
            size: byteSize(latest.statData),
            statData: deepClone(latest.statData),
        };
        await putSnapshot(rec);
        await pruneSnapshots(state.current.scopeKey);
        log(`已保存变量快照：${reason}`);
        return rec;
    }

    async function restoreSnapshot(snapshotId) {
        const all = await listSnapshots(state.current.scopeKey);
        const rec = all.find(x => x.id === snapshotId);
        if (!rec) throw new Error('快照不存在');
        if (!confirm(`恢复此变量快照？\n${new Date(rec.createdAt).toLocaleString()}\n这会覆盖当前 stat_data。`)) return;
        const latest = await refreshCurrent({ render: false });
        if (!latest) throw new Error('当前没有可写入的 MVU 楼层');
        await saveSnapshot('before-snapshot-restore');
        const vars = deepClone(latest.variables);
        vars.stat_data = deepClone(rec.statData);
        await writeMvu(latest.messageId, vars);
        toast('success', '快照已恢复');
        await refreshCurrent();
    }

    // ---------- archive/restore ----------

    function getContainerConfig(path) {
        const profile = getProfile(state.current.cardKey);
        return profile.containers.find(c => c.path === normalizePointer(path));
    }

    async function archiveChild(containerPath, childKey, { automatic = false } = {}) {
        if (state.busy) return;
        state.busy = true;
        try {
            const latest = await refreshCurrent({ render: false });
            if (!latest) throw new Error('当前聊天没有 MVU stat_data');
            const path = normalizePointer(containerPath);
            const container = getByPointer(latest.statData, path);
            if (!container || typeof container !== 'object' || Array.isArray(container)) throw new Error(`归档容器不存在或不是对象：${path}`);
            if (!(childKey in container)) throw new Error(`目标子项不存在：${childKey}`);
            const node = deepClone(container[childKey]);
            const pointer = childPointer(path, childKey);
            const summary = summarizeNode(childKey, node);
            const record = {
                id: makeId('arc'),
                scopeKey: state.current.scopeKey,
                scopeLabel: state.current.scopeLabel,
                cardKey: state.current.cardKey,
                sourcePath: path,
                childKey,
                pointer,
                data: node,
                summary,
                tags: extractTags(path, childKey, summary),
                size: byteSize(node),
                archivedAt: Date.now(),
                messageId: latest.messageId,
                messageCount: ctx()?.chat?.length ?? 0,
                status: 'pending',
                pinned: false,
                mirroredToMemory: false,
                mirrorError: '',
                automatic,
            };

            // Transactional safety: snapshot + pending cold copy before MVU mutation.
            await saveSnapshot(automatic ? 'before-auto-archive' : 'before-manual-archive');
            await putArchive(record);

            const vars = deepClone(latest.variables);
            const newStat = deepClone(latest.statData);
            if (!deleteByPointer(newStat, pointer)) throw new Error('删除热变量失败');
            vars.stat_data = newStat;
            try {
                await writeMvu(latest.messageId, vars);
            } catch (e) {
                await deleteArchiveRecord(record.id);
                throw e;
            }

            // Verify schema/runtime did not immediately rehydrate the child.
            await sleep(60);
            const verify = await findLatestMvu();
            if (verify && hasByPointer(verify.statData, pointer)) {
                await deleteArchiveRecord(record.id);
                throw new Error(`该节点被变量结构自动补回，不能安全卸载：${pointer}。请只归档 z.record/动态对象类路径。`);
            }

            record.status = 'archived';
            await putArchive(record);

            if (settings.memoryMirrorEnabled) {
                await mirrorRecordToMemory(record, { quiet: true });
            }

            toast('success', `已归档：${childKey}`);
            log(`归档 ${pointer} (${formatBytes(record.size)})`);
        } finally {
            state.busy = false;
            await refreshCurrent();
        }
    }

    async function restoreArchive(recordId) {
        if (state.busy) return;
        state.busy = true;
        try {
            await refreshCurrent({ render: false });
            const all = await listArchives(state.current.scopeKey, true);
            const record = all.find(r => r.id === recordId);
            if (!record) throw new Error('归档记录不存在');
            const latest = state.latestMvu || await findLatestMvu();
            if (!latest) throw new Error('当前聊天没有可写入的 MVU stat_data');
            const target = childPointer(record.sourcePath, record.childKey);
            const existing = getByPointer(latest.statData, target);
            if (existing !== undefined) {
                const same = JSON.stringify(existing) === JSON.stringify(record.data);
                if (same) {
                    toast('info', '该数据已经在热变量中，无需恢复');
                    return;
                }
                if (!confirm(`热变量中已经存在同名节点：${target}\n是否用归档内容覆盖？`)) return;
            }
            await saveSnapshot('before-archive-restore');
            const vars = deepClone(latest.variables);
            const stat = deepClone(latest.statData);
            setByPointer(stat, target, deepClone(record.data));
            vars.stat_data = stat;
            await writeMvu(latest.messageId, vars);
            record.status = 'restored';
            record.restoredAt = Date.now();
            await putArchive(record);
            toast('success', `已恢复：${record.childKey}`);
            log(`恢复 ${target}`);
        } finally {
            state.busy = false;
            await refreshCurrent();
        }
    }

    async function togglePin(recordId) {
        const all = await listArchives(state.current.scopeKey, true);
        const rec = all.find(r => r.id === recordId);
        if (!rec) return;
        rec.pinned = !rec.pinned;
        await putArchive(rec);
        await refreshCurrent();
    }

    // ---------- Memory Enhancement optional bridge ----------

    async function ensureMemoryAdapter() {
        if (window.externalDataAdapter?.processJsonData) return window.externalDataAdapter;
        if (!window.stMemoryEnhancement) return null;
        if (state.memoryAdapterLoadTried) return window.externalDataAdapter || null;
        state.memoryAdapterLoadTried = true;
        try {
            const mod = await import('/scripts/extensions/third-party/st-memory-enhancement/external-data-adapter.js');
            mod.initExternalDataAdapter?.({ debugMode: false });
            return window.externalDataAdapter || mod.externalDataAdapter || null;
        } catch (e) {
            warn('记忆增强已检测到，但外部数据适配器加载失败', e);
            return null;
        }
    }

    function compactMirrorData(record) {
        let json = JSON.stringify(record.data);
        const limit = Math.max(500, Number(settings.memoryMirrorMaxChars) || 4000);
        if (json.length > limit) json = json.slice(0, limit - 1) + '…';
        return [
            record.id,
            record.scopeLabel,
            record.sourcePath,
            record.childKey,
            record.summary,
            json,
            new Date(record.archivedAt).toLocaleString(),
        ];
    }

    async function mirrorRecordToMemory(record, { quiet = false } = {}) {
        if (record.mirroredToMemory) {
            if (!quiet) toast('info', '该档案已经镜像到记忆增强表格，未重复写入');
            return true;
        }
        const adapter = await ensureMemoryAdapter();
        if (!adapter?.processJsonData) {
            if (!quiet) toast('warning', '记忆增强未启用或 externalDataAdapter 不可用');
            return false;
        }
        const tableIndex = Number(settings.memoryTableIndex) || 0;
        const result = await adapter.processJsonData({ type: 'insert', tableIndex, data: compactMirrorData(record) });
        if (result?.success) {
            record.mirroredToMemory = true;
            record.mirroredAt = Date.now();
            record.mirrorError = '';
            await putArchive(record);
            if (!quiet) toast('success', `已镜像到记忆表格 #${tableIndex}`);
            return true;
        }
        record.mirrorError = result?.message || '未知错误';
        await putArchive(record);
        if (!quiet) toast('error', `镜像失败：${record.mirrorError}`);
        return false;
    }

    function getMemoryStatus() {
        if (!window.stMemoryEnhancement) return { available: false, label: '未启用' };
        const version = window.stMemoryEnhancement.VERSION || '?';
        return { available: true, label: `已启用 v${version}` };
    }

    // ---------- macro / relevance ----------

    function recentUserText() {
        const c = ctx();
        if (!c?.chat?.length) return '';
        return c.chat.filter(m => m?.is_user).slice(-2).map(m => String(m.mes || '')).join('\n').toLowerCase();
    }

    function isHot(record) {
        const stat = state.latestMvu?.statData;
        return !!stat && hasByPointer(stat, childPointer(record.sourcePath, record.childKey));
    }

    function relevance(record, text) {
        if (isHot(record)) return -99999; // never duplicate hot data
        let score = record.pinned ? 1000 : 0;
        const lowerKey = String(record.childKey).toLowerCase();
        if (lowerKey.length >= 2 && text.includes(lowerKey)) score += 120;
        for (const tag of record.tags || []) {
            const t = String(tag).toLowerCase();
            if (t.length >= 2 && text.includes(t)) score += Math.min(35, 6 + t.length * 2);
        }
        if (record.mirroredToMemory && !settings.includeMirroredInMacro) score -= 10000;
        return score;
    }

    function formatArchiveForPrompt(record) {
        const max = Math.max(600, Number(settings.maxInjectRecordChars) || 3500);
        let data = JSON.stringify(record.data);
        if (data.length > max) data = data.slice(0, max - 1) + '…';
        return [
            `档案ID: ${record.id}`,
            `原变量: ${childPointer(record.sourcePath, record.childKey)}`,
            `摘要: ${record.summary}`,
            `数据: ${data}`,
        ].join('\n');
    }

    function buildMacroContext() {
        if (!settings.macroEnabled || !state.current) return '';
        const text = recentUserText();
        const candidates = state.archiveCache
            .map(r => ({ r, score: relevance(r, text) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, Number(settings.maxInjectRecords) || 6));
        if (!candidates.length) return '';

        const cap = Math.max(1000, Number(settings.maxInjectChars) || 12000);
        const pieces = [];
        let used = 0;
        for (const { r } of candidates) {
            const p = formatArchiveForPrompt(r);
            if (used + p.length > cap) break;
            pieces.push(p);
            used += p.length;
        }
        if (!pieces.length) return '';
        return `<long_term_archive_context>\n以下是按当前对话按需取回的冷档案。若与当前MVU/stat_data冲突，以当前MVU为准。\n\n${pieces.map((p, i) => `[档案${i + 1}]\n${p}`).join('\n\n')}\n</long_term_archive_context>`;
    }

    function registerMacro() {
        if (state.macroRegistered) return;
        const c = ctx();
        if (!c) return;
        try {
            // SillyTavern Macro Engine 2.0 (preferred on current builds).
            if (c.macros?.register) {
                c.macros.register('varArchiveContext', {
                    description: '按当前对话从 Variable Archive Bridge 冷档案中取回相关上下文。当前MVU优先。',
                    handler: () => buildMacroContext(),
                });
                state.macroRegistered = true;
                log('已通过 Macro Engine 2.0 注册 {{varArchiveContext}}');
                return;
            }
            // Legacy compatibility path.
            if (typeof c.registerMacro === 'function') {
                c.registerMacro('varArchiveContext', () => buildMacroContext(), '按需取回变量冷档案');
                state.macroRegistered = true;
                log('已通过旧版宏API注册 {{varArchiveContext}}');
                return;
            }
            warn('当前 SillyTavern 未暴露宏注册API，{{varArchiveContext}} 暂不可用；归档/恢复本身不受影响');
        } catch (e) {
            // A duplicate registration can occur after extension hot reload. Keep storage features alive.
            state.macroRegistered = true;
            warn('宏注册异常；若是扩展热重载导致同名宏已存在，可忽略。归档/恢复不受影响', e);
        }
    }

    // ---------- monitoring / optional auto archive ----------

    function profileContainers() {
        return state.current ? getProfile(state.current.cardKey).containers : [];
    }

    function updateTouches(oldStat, newStat) {
        if (!state.current || !newStat) return;
        const scope = touches[state.current.scopeKey] ||= {};
        const msgCount = ctx()?.chat?.length ?? 0;
        for (const cfg of profileContainers()) {
            const oldObj = oldStat ? getByPointer(oldStat, cfg.path) : undefined;
            const newObj = getByPointer(newStat, cfg.path);
            if (!newObj || typeof newObj !== 'object' || Array.isArray(newObj)) continue;
            const pathState = scope[cfg.path] ||= {};
            for (const [k, v] of Object.entries(newObj)) {
                const h = statHash(v);
                if (!pathState[k]) pathState[k] = { hash: h, lastTouched: msgCount };
                else if (pathState[k].hash !== h) pathState[k] = { hash: h, lastTouched: msgCount };
            }
            if (oldObj && typeof oldObj === 'object') {
                for (const k of Object.keys(pathState)) if (!(k in newObj)) delete pathState[k];
            }
        }
        saveTouches();
    }

    async function maybeAutoArchive() {
        if (!settings.autoArchiveGlobal || state.busy || !state.latestMvu) return;
        const stat = state.latestMvu.statData;
        const scopeTouch = touches[state.current.scopeKey] || {};
        const msgCount = ctx()?.chat?.length ?? 0;
        for (const cfg of profileContainers()) {
            if (!cfg.auto) continue;
            const obj = getByPointer(stat, cfg.path);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
            const keys = Object.keys(obj);
            const maxChildren = Math.max(1, Number(cfg.maxChildren) || 30);
            const keepRecent = Math.max(0, Number(cfg.keepRecent) || 20);
            const minIdle = Math.max(0, Number(cfg.minIdleMessages) || 40);
            if (keys.length <= maxChildren) continue;
            const t = scopeTouch[cfg.path] || {};
            const candidates = keys
                .map(k => ({ key: k, last: t[k]?.lastTouched ?? msgCount }))
                .filter(x => msgCount - x.last >= minIdle)
                .sort((a, b) => a.last - b.last);
            const targetCount = Math.max(0, keys.length - Math.max(keepRecent, maxChildren));
            if (targetCount <= 0) continue;
            for (const item of candidates.slice(0, targetCount)) {
                await archiveChild(cfg.path, item.key, { automatic: true });
                break; // one per cycle for safety
            }
        }
    }

    async function poll() {
        if (document.hidden || state.busy) return;
        try {
            const identity = getIdentity();
            if (!state.current || identity.scopeKey !== state.current.scopeKey) {
                state.current = identity;
                await refreshCurrent();
                registerMacro();
                return;
            }
            const oldStat = state.latestMvu?.statData ? deepClone(state.latestMvu.statData) : null;
            const latest = await findLatestMvu();
            const msgCount = ctx()?.chat?.length ?? 0;
            if (latest) {
                const h = statHash(latest.statData);
                if (h !== state.lastStatHash) {
                    state.latestMvu = latest;
                    state.lastStatHash = h;
                    updateTouches(oldStat, latest.statData);
                    await maybeAutoArchive();
                    renderPanel();
                } else {
                    state.latestMvu = latest;
                }
            }
            if (msgCount !== state.lastMessageCount) {
                const previous = state.lastMessageCount;
                state.lastMessageCount = msgCount;
                if (previous >= 0 && settings.autoSnapshot && msgCount > 0 && msgCount % Math.max(1, Number(settings.snapshotEveryMessages) || 10) === 0) {
                    await saveSnapshot(`auto-${msgCount}`);
                }
            }
        } catch (e) {
            warn(`轮询失败：${e.message}`, e);
        }
    }

    function hookEvents() {
        const c = ctx();
        try {
            const events = c?.event_types;
            const source = c?.eventSource;
            if (events && source?.on) {
                for (const name of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']) {
                    if (events[name]) source.on(events[name], () => setTimeout(() => refreshCurrent(), 50));
                }
            }
        } catch (e) { warn('SillyTavern 事件监听失败，将使用轮询兜底', e); }

        try {
            const mvu = resolveMvu();
            const eventOn = window.eventOn || window.parent?.eventOn;
            if (!state.mvuEventHooked && mvu?.events?.VARIABLE_UPDATE_ENDED && typeof eventOn === 'function') {
                eventOn(mvu.events.VARIABLE_UPDATE_ENDED, () => setTimeout(() => refreshCurrent(), 30));
                state.mvuEventHooked = true;
                log('已监听 MVU VARIABLE_UPDATE_ENDED');
            }
        } catch (_) {}
    }

    // ---------- import/export ----------

    async function exportCurrentScope() {
        await refreshCurrent({ render: false });
        const archives = await listArchives(state.current.scopeKey, true);
        const snapshots = await listSnapshots(state.current.scopeKey);
        const profile = deepClone(getProfile(state.current.cardKey));
        const payload = {
            format: 'variable-archive-bridge',
            version: VERSION,
            exportedAt: new Date().toISOString(),
            scope: state.current,
            profile,
            archives,
            snapshots,
        };
        downloadText(`VAB_${state.current.cardLabel || 'chat'}_${Date.now()}.json`, JSON.stringify(payload, null, 2));
    }

    async function importPayload(file) {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.format !== 'variable-archive-bridge') throw new Error('不是 Variable Archive Bridge 导出文件');
        if (!confirm(`导入 ${data.archives?.length || 0} 条归档、${data.snapshots?.length || 0} 个快照到当前聊天？`)) return;
        for (const r0 of data.archives || []) {
            const r = deepClone(r0);
            r.id = makeId('arc_import');
            r.scopeKey = state.current.scopeKey;
            r.scopeLabel = state.current.scopeLabel;
            r.cardKey = state.current.cardKey;
            await putArchive(r);
        }
        for (const s0 of data.snapshots || []) {
            const s = deepClone(s0);
            s.id = makeId('snap_import');
            s.scopeKey = state.current.scopeKey;
            s.scopeLabel = state.current.scopeLabel;
            s.cardKey = state.current.cardKey;
            await putSnapshot(s);
        }
        toast('success', '导入完成');
        await refreshCurrent();
    }

    // ---------- UI ----------

    function statusBadge(ok, text) {
        return `<span class="vab-badge ${ok ? 'ok' : 'off'}">${ok ? '●' : '○'} ${escapeHtml(text)}</span>`;
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    }

    function ensurePanel() {
        if (document.getElementById('vab-settings')) return;
        const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.body;
        const wrapper = document.createElement('div');
        wrapper.id = 'vab-settings';
        wrapper.innerHTML = `
        <div class="inline-drawer vab-drawer">
          <div class="inline-drawer-toggle inline-drawer-header vab-header">
            <b>📦 变量归档桥 <small>v${VERSION}</small></b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content vab-content" style="display:none">
            <div id="vab-root">正在初始化…</div>
          </div>
        </div>`;
        host.appendChild(wrapper);
        const toggle = wrapper.querySelector('.inline-drawer-toggle');
        const content = wrapper.querySelector('.inline-drawer-content');
        toggle.addEventListener('click', () => {
            const open = content.style.display !== 'none';
            content.style.display = open ? 'none' : 'block';
            if (!open) refreshCurrent();
        });
    }

    function renderPanel() {
        ensurePanel();
        const root = document.getElementById('vab-root');
        if (!root) return;
        const cur = state.current || getIdentity();
        const latest = state.latestMvu;
        const memory = getMemoryStatus();
        const stat = latest?.statData;
        const statSize = stat ? byteSize(stat) : 0;
        const nodes = stat ? nodeCount(stat) : 0;
        const profile = getProfile(cur.cardKey);
        const containerHtml = profile.containers.length ? profile.containers.map(renderContainer).join('') : '<div class="vab-empty">还没有配置归档容器。先填一个动态对象路径，例如 <code>/世界档案</code>、<code>/长期人物</code>、<code>/玩家/能力</code>。</div>';
        const archiveHtml = state.archiveCache.length ? state.archiveCache.slice(0, 40).map(renderArchiveRecord).join('') : '<div class="vab-empty">当前聊天没有冷归档。</div>';

        root.innerHTML = `
          <div class="vab-status-row">
            ${statusBadge(!!latest, latest ? `MVU ${formatBytes(statSize)} / ${nodes}节点 / 楼${latest.messageId}` : '未检测到MVU')}
            ${statusBadge(memory.available, `记忆增强 ${memory.label}`)}
            ${statusBadge(state.macroRegistered, '宏 varArchiveContext')}
          </div>
          <div class="vab-scope">当前：${escapeHtml(cur.scopeLabel)}</div>

          <div class="vab-actions">
            <button class="menu_button" data-vab="refresh">刷新</button>
            <button class="menu_button" data-vab="snapshot">保存变量快照</button>
            <button class="menu_button" data-vab="export">导出当前档案</button>
            <button class="menu_button" data-vab="import">导入档案</button>
          </div>

          <details class="vab-section" open>
            <summary>归档容器（只允许卸载这些路径的直接子项）</summary>
            <div class="vab-add-row">
              <input id="vab-new-path" class="text_pole" placeholder="/世界档案 或 /玩家/能力">
              <button class="menu_button" data-vab="add-path">添加</button>
            </div>
            <div class="vab-note">安全规则：父节点永远不删；默认不自动归档；每次归档前自动快照；若Schema把节点自动补回，插件会判定失败。</div>
            <div id="vab-container-list">${containerHtml}</div>
          </details>

          <details class="vab-section" open>
            <summary>冷归档（${state.archiveCache.length}）</summary>
            <div id="vab-archive-list">${archiveHtml}</div>
          </details>

          <details class="vab-section">
            <summary>快照与自动策略</summary>
            <label class="checkbox_label"><input id="vab-auto-snap" type="checkbox" ${settings.autoSnapshot ? 'checked' : ''}> 每隔 <input id="vab-snap-every" type="number" min="1" value="${Number(settings.snapshotEveryMessages)||10}" class="vab-num"> 条消息自动快照</label>
            <label class="checkbox_label"><input id="vab-auto-archive-global" type="checkbox" ${settings.autoArchiveGlobal ? 'checked' : ''}> 启用自动归档总开关（实验；各容器还需单独开启）</label>
            <div class="vab-note">自动归档默认关闭。建议先手动运行一段时间，确认你常用卡的动态路径确实可安全删除。</div>
            <div class="vab-actions"><button class="menu_button" data-vab="show-snaps">查看/恢复快照</button></div>
            <div id="vab-snapshot-list"></div>
          </details>

          <details class="vab-section">
            <summary>按需Prompt注入</summary>
            <label class="checkbox_label"><input id="vab-macro-enabled" type="checkbox" ${settings.macroEnabled ? 'checked' : ''}> 启用 <code>{{varArchiveContext}}</code> 宏</label>
            <div class="vab-note">推荐把 <code>{{varArchiveContext}}</code> 放进 Kemini 的“💠自定义缝合处”。只取：置顶档案 + 最近两条用户消息命中的档案；当前MVU里仍存在的同一节点绝不会重复注入。</div>
            <label>最多档案数 <input id="vab-inject-records" class="vab-num" type="number" min="1" max="30" value="${settings.maxInjectRecords}"></label>
            <label>总字符上限 <input id="vab-inject-chars" class="vab-num-wide" type="number" min="1000" step="1000" value="${settings.maxInjectChars}"></label>
            <div class="vab-preview"><b>本轮宏预览：</b><pre>${escapeHtml(buildMacroContext() || '（当前没有需要注入的冷档案）')}</pre></div>
          </details>

          <details class="vab-section">
            <summary>记忆增强表格兼容（可选）</summary>
            <label class="checkbox_label"><input id="vab-memory-mirror" type="checkbox" ${settings.memoryMirrorEnabled ? 'checked' : ''}> 归档后镜像一份摘要到记忆增强表格</label>
            <label>表格索引 <input id="vab-memory-table" class="vab-num" type="number" min="0" value="${settings.memoryTableIndex}"></label>
            <div class="vab-note">预期表格7列：档案ID｜聊天｜变量路径｜子键｜摘要｜压缩JSON｜更新时间。它只是可选镜像；完整原始数据始终保存在本插件IndexedDB。若记忆表格自己也注入Prompt，已镜像记录默认不会再由本插件宏重复注入。</div>
          </details>

          <details class="vab-section">
            <summary>诊断</summary>
            <div class="vab-note">IndexedDB: ${state.db ? '正常' : '未连接'}；归档缓存: ${state.archiveCache.length}；最后错误: ${escapeHtml(state.lastError || '无')}</div>
            <pre class="vab-log">${escapeHtml(state.diagnostics.slice(-20).join('\n') || '暂无日志')}</pre>
          </details>
          <input id="vab-import-file" type="file" accept="application/json,.json" style="display:none">
        `;
        bindPanelEvents(root);
    }

    function renderContainer(cfg) {
        const obj = state.latestMvu?.statData ? getByPointer(state.latestMvu.statData, cfg.path) : undefined;
        const valid = obj && typeof obj === 'object' && !Array.isArray(obj);
        const children = valid ? Object.entries(obj).map(([key, val]) => ({ key, size: byteSize(val), summary: summarizeNode(key, val) })).sort((a, b) => b.size - a.size) : [];
        const childRows = children.slice(0, MAX_UI_CHILDREN).map(item => `
          <div class="vab-child-row">
            <div class="vab-child-main"><b>${escapeHtml(item.key)}</b><small>${formatBytes(item.size)} · ${escapeHtml(item.summary)}</small></div>
            <button class="menu_button" data-vab-archive="${escapeHtml(cfg.path)}" data-vab-key="${escapeHtml(item.key)}">归档</button>
          </div>`).join('');
        return `<div class="vab-container-card">
          <div class="vab-container-head"><b>${escapeHtml(cfg.path)}</b><span>${valid ? `${children.length}项 / ${formatBytes(byteSize(obj))}` : '当前不存在'}</span><button class="vab-icon-btn" data-vab-remove-path="${escapeHtml(cfg.path)}">✕</button></div>
          <div class="vab-container-controls">
            <label><input type="checkbox" data-vab-container-auto="${escapeHtml(cfg.path)}" ${cfg.auto ? 'checked' : ''}>自动</label>
            <label>上限<input type="number" data-vab-container-max="${escapeHtml(cfg.path)}" class="vab-num" min="1" value="${cfg.maxChildren || 30}"></label>
            <label>保留最近<input type="number" data-vab-container-keep="${escapeHtml(cfg.path)}" class="vab-num" min="0" value="${cfg.keepRecent ?? 20}"></label>
            <label>闲置消息<input type="number" data-vab-container-idle="${escapeHtml(cfg.path)}" class="vab-num" min="0" value="${cfg.minIdleMessages ?? 40}"></label>
          </div>
          <div class="vab-child-list">${childRows || '<div class="vab-empty">没有可归档的直接子项。</div>'}${children.length > MAX_UI_CHILDREN ? `<div class="vab-note">只显示最大的 ${MAX_UI_CHILDREN} 项。</div>` : ''}</div>
        </div>`;
    }

    function renderArchiveRecord(r) {
        return `<div class="vab-archive-row">
          <div class="vab-archive-main"><b>${escapeHtml(r.childKey)}</b><small>${escapeHtml(r.sourcePath)} · ${formatBytes(r.size)} · ${new Date(r.archivedAt).toLocaleString()}</small><span>${escapeHtml(r.summary)}</span>${r.mirroredToMemory ? '<em>已镜像记忆表</em>' : ''}</div>
          <div class="vab-row-buttons">
            <button class="menu_button" data-vab-pin="${r.id}">${r.pinned ? '★' : '☆'}</button>
            <button class="menu_button" data-vab-restore="${r.id}">恢复</button>
            <button class="menu_button" data-vab-mirror="${r.id}">镜像</button>
            <button class="menu_button danger_button" data-vab-delete-archive="${r.id}">删档</button>
          </div>
        </div>`;
    }

    function bindPanelEvents(root) {
        root.querySelector('[data-vab="refresh"]')?.addEventListener('click', () => refreshCurrent());
        root.querySelector('[data-vab="snapshot"]')?.addEventListener('click', async () => {
            try { await saveSnapshot('manual'); toast('success', '变量快照已保存'); await refreshCurrent(); } catch (e) { toast('error', e.message); }
        });
        root.querySelector('[data-vab="export"]')?.addEventListener('click', () => exportCurrentScope().catch(e => toast('error', e.message)));
        root.querySelector('[data-vab="import"]')?.addEventListener('click', () => root.querySelector('#vab-import-file')?.click());
        root.querySelector('#vab-import-file')?.addEventListener('change', e => {
            const f = e.target.files?.[0];
            if (f) importPayload(f).catch(err => toast('error', err.message));
            e.target.value = '';
        });
        root.querySelector('[data-vab="add-path"]')?.addEventListener('click', () => {
            try {
                const input = root.querySelector('#vab-new-path');
                const path = normalizePointer(input.value);
                if (path === '/') throw new Error('不能把 stat_data 根节点作为归档容器');
                const p = getProfile(state.current.cardKey);
                if (!p.containers.some(c => c.path === path)) p.containers.push({ path, auto: false, maxChildren: 30, keepRecent: 20, minIdleMessages: 40 });
                saveSettings();
                renderPanel();
            } catch (e) { toast('error', e.message); }
        });
        root.querySelectorAll('[data-vab-remove-path]').forEach(btn => btn.addEventListener('click', () => {
            const path = btn.dataset.vabRemovePath;
            const p = getProfile(state.current.cardKey);
            p.containers = p.containers.filter(c => c.path !== path);
            saveSettings(); renderPanel();
        }));
        root.querySelectorAll('[data-vab-archive]').forEach(btn => btn.addEventListener('click', () => {
            archiveChild(btn.dataset.vabArchive, btn.dataset.vabKey).catch(e => toast('error', e.message));
        }));
        root.querySelectorAll('[data-vab-restore]').forEach(btn => btn.addEventListener('click', () => restoreArchive(btn.dataset.vabRestore).catch(e => toast('error', e.message))));
        root.querySelectorAll('[data-vab-pin]').forEach(btn => btn.addEventListener('click', () => togglePin(btn.dataset.vabPin).catch(e => toast('error', e.message))));
        root.querySelectorAll('[data-vab-mirror]').forEach(btn => btn.addEventListener('click', async () => {
            const r = state.archiveCache.find(x => x.id === btn.dataset.vabMirror);
            if (r) { await mirrorRecordToMemory(r); await refreshCurrent(); }
        }));
        root.querySelectorAll('[data-vab-delete-archive]').forEach(btn => btn.addEventListener('click', async () => {
            const r = state.archiveCache.find(x => x.id === btn.dataset.vabDeleteArchive);
            if (!r) return;
            if (!confirm(`永久删除冷档案“${r.childKey}”？\n如果它不在MVU里，这会丢失该归档数据。`)) return;
            await deleteArchiveRecord(r.id); await refreshCurrent();
        }));

        // global settings
        const saveSimple = () => { saveSettings(); renderPanel(); };
        root.querySelector('#vab-auto-snap')?.addEventListener('change', e => { settings.autoSnapshot = e.target.checked; saveSimple(); });
        root.querySelector('#vab-snap-every')?.addEventListener('change', e => { settings.snapshotEveryMessages = Math.max(1, Number(e.target.value)||10); saveSimple(); });
        root.querySelector('#vab-auto-archive-global')?.addEventListener('change', e => { settings.autoArchiveGlobal = e.target.checked; saveSimple(); });
        root.querySelector('#vab-macro-enabled')?.addEventListener('change', e => { settings.macroEnabled = e.target.checked; saveSimple(); });
        root.querySelector('#vab-inject-records')?.addEventListener('change', e => { settings.maxInjectRecords = Math.max(1, Number(e.target.value)||6); saveSimple(); });
        root.querySelector('#vab-inject-chars')?.addEventListener('change', e => { settings.maxInjectChars = Math.max(1000, Number(e.target.value)||12000); saveSimple(); });
        root.querySelector('#vab-memory-mirror')?.addEventListener('change', e => { settings.memoryMirrorEnabled = e.target.checked; saveSimple(); });
        root.querySelector('#vab-memory-table')?.addEventListener('change', e => { settings.memoryTableIndex = Math.max(0, Number(e.target.value)||0); saveSimple(); });

        // per-container settings
        for (const cfg of profileContainers()) {
            const auto = root.querySelector(`[data-vab-container-auto="${cssEscape(cfg.path)}"]`);
            const max = root.querySelector(`[data-vab-container-max="${cssEscape(cfg.path)}"]`);
            const keep = root.querySelector(`[data-vab-container-keep="${cssEscape(cfg.path)}"]`);
            const idle = root.querySelector(`[data-vab-container-idle="${cssEscape(cfg.path)}"]`);
            auto?.addEventListener('change', e => { cfg.auto = e.target.checked; saveSettings(); });
            max?.addEventListener('change', e => { cfg.maxChildren = Math.max(1, Number(e.target.value)||30); saveSettings(); });
            keep?.addEventListener('change', e => { cfg.keepRecent = Math.max(0, Number(e.target.value)||20); saveSettings(); });
            idle?.addEventListener('change', e => { cfg.minIdleMessages = Math.max(0, Number(e.target.value)||40); saveSettings(); });
        }

        root.querySelector('[data-vab="show-snaps"]')?.addEventListener('click', async () => {
            const box = root.querySelector('#vab-snapshot-list');
            const snaps = await listSnapshots(state.current.scopeKey);
            box.innerHTML = snaps.slice(0, 40).map(s => `<div class="vab-snap-row"><span>${new Date(s.createdAt).toLocaleString()} · ${escapeHtml(s.reason)} · ${formatBytes(s.size)}</span><button class="menu_button" data-vab-snap-restore="${s.id}">恢复</button></div>`).join('') || '<div class="vab-empty">暂无快照</div>';
            box.querySelectorAll('[data-vab-snap-restore]').forEach(b => b.addEventListener('click', () => restoreSnapshot(b.dataset.vabSnapRestore).catch(e => toast('error', e.message))));
        });
    }

    // ---------- init ----------

    async function init() {
        if (state.initialized) return;
        state.initialized = true;
        try {
            ensurePanel();
            state.db = await openDb();
            state.current = getIdentity();
            await refreshCurrent();
            registerMacro();
            hookEvents();
            state.lastMessageCount = ctx()?.chat?.length ?? 0;
            state.pollTimer = setInterval(poll, POLL_MS);
            log('变量归档桥初始化完成');
            renderPanel();
        } catch (e) {
            state.initialized = false;
            warn(`初始化失败：${e.message}`, e);
            toast('error', e.message, '变量归档桥初始化失败');
        }
    }

    return {
        VERSION,
        init,
        refreshCurrent,
        saveSnapshot,
        archiveChild,
        restoreArchive,
        buildMacroContext,
        getState: () => ({ ...state, db: !!state.db, settings: deepClone(settings) }),
        _test: { parsePointer, normalizePointer, getByPointer, setByPointer, deleteByPointer, summarizeNode, relevance, statHash },
    };
})();

// Expose a small diagnostic API.
window.VariableArchiveBridge = VAB;

export async function init() {
    return VAB.init();
}

// Third-party extensions do not reliably receive manifest hooks in every ST build.
// Self-init as well; init() is idempotent.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => VAB.init(), 0), { once: true });
} else {
    setTimeout(() => VAB.init(), 0);
}
