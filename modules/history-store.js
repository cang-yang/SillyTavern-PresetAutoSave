/**
 * SillyTavern Preset Auto Save - History Store
 * 历史快照存储模块
 *
 * 存储架构:
 *   - 后端: localforage (IndexedDB) / localStorage 降级
 *   - 命名空间: PresetAutoSave / history
 *   - Key 格式: "<apiId>::<presetName>"
 *   - Value: snapshot[] 数组（按时间倒序）
 *
 * 快照结构:
 *   {
 *     id: string,           // 唯一ID
 *     presetName: string,   // 预设名
 *     apiId: string,        // API类型
 *     timestamp: number,    // 时间戳（ms）
 *     trigger: string,      // 'auto' | 'switch_guard' | 'manual'
 *     preset: object,       // 完整预设数据
 *     size: number,         // 数据大小（字节）
 *     hash: string,         // 内容哈希（用于去重）
 *   }
 */

import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { createStorage } from './compatibility.js';

const STORAGE_NAME = 'PresetAutoSave';
const STORE_NAME = 'history';
const KEY_DELIMITER = '::';

// =====================================================
// 触发类型
// =====================================================
export const TRIGGER = Object.freeze({
    AUTO: 'auto',                   // 自动保存
    SWITCH_GUARD: 'switch_guard',   // 切换保护
    MANUAL: 'manual',               // 手动快照
});

/** trigger -> i18n key 映射，渲染时再用 t() 翻译 */
export const TRIGGER_LABEL_KEYS = Object.freeze({
    auto: 'Trigger Auto',
    switch_guard: 'Trigger Switch Guard',
    manual: 'Trigger Manual',
});

/** @deprecated 兼容旧引用，请使用 TRIGGER_LABEL_KEYS + t() */
export const TRIGGER_LABELS = Object.freeze({
    auto: '自动保存',
    switch_guard: '切换前备份',
    manual: '手动快照',
});

// =====================================================
// 状态
// =====================================================
let _store = null;
let _initialized = false;
let _keysCache = null;
let _keysCacheTime = 0;
const KEYS_CACHE_TTL = 5000;  // 5秒

// =====================================================
// 初始化
// =====================================================
export async function initHistoryStore() {
    try {
        _store = createStorage(STORAGE_NAME, STORE_NAME);
        _initialized = true;

        const stats = await getStats();
        logger.success(
            `History store ready: ${stats.snapshotCount} snapshots, ` +
            `${stats.presetCount} presets, ${stats.totalSizeFormatted}`
        );
    } catch (e) {
        logger.error('Failed to init history store:', e);
        _initialized = false;
    }
}

// =====================================================
// 工具函数（部分导出供 auto-save 使用）
// =====================================================
function makeKey(apiId, presetName) {
    return `${apiId}${KEY_DELIMITER}${presetName}`;
}

function parseKey(key) {
    const idx = key.indexOf(KEY_DELIMITER);
    if (idx < 0) return null;
    return {
        apiId: key.slice(0, idx),
        presetName: key.slice(idx + KEY_DELIMITER.length),
    };
}

function generateId() {
    return 'snap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/**
 * 稳定的 JSON.stringify（key 排序，保证相同对象产生相同字符串）
 */
export function stableStringify(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        return '[' + obj.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * 计算预设内容哈希（FNV-1a 32-bit）
 */
export function hashPreset(obj) {
    if (!obj) return '';
    const str = stableStringify(obj);
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 计算两份预设之间的修改摘要（人类可读）
 * 返回结构化数据，UI 层负责渲染
 *
 * @param {object|null} prev - 上一份快照的 preset
 * @param {object|null} curr - 当前 preset
 * @returns {{
 *   tags: Array<{type:string, label:string, count?:number}>,  // 修改类型标签
 *   details: Array<{key:string, from:any, to:any}>,            // 字段级变更明细（最多保留 6 项）
 *   promptChange: {added:number, removed:number, modified:number, reordered:boolean}|null,
 *   isFirst: boolean
 * }}
 */
export function computeChangeSummary(prev, curr) {
    const result = {
        tags: [],
        details: [],
        promptChange: null,
        isFirst: false,
    };

    if (!curr || typeof curr !== 'object') return result;
    if (!prev || typeof prev !== 'object') {
        result.isFirst = true;
        result.tags.push({ type: 'first', label: 'Initial' });
        return result;
    }

    // 1. Prompts 数组比较
    const prevPrompts = Array.isArray(prev.prompts) ? prev.prompts : [];
    const currPrompts = Array.isArray(curr.prompts) ? curr.prompts : [];
    const promptDiff = comparePrompts(prevPrompts, currPrompts);
    if (promptDiff.added || promptDiff.removed || promptDiff.modified) {
        result.promptChange = promptDiff;
        if (promptDiff.added) result.tags.push({ type: 'prompt-add', label: 'Prompt+', count: promptDiff.added });
        if (promptDiff.removed) result.tags.push({ type: 'prompt-del', label: 'Prompt-', count: promptDiff.removed });
        if (promptDiff.modified) result.tags.push({ type: 'prompt-edit', label: 'PromptEdit', count: promptDiff.modified });
    }

    // 2. Prompt order 比较（顺序变化）
    const prevOrder = extractOrder(prev.prompt_order);
    const currOrder = extractOrder(curr.prompt_order);
    const orderChanged = prevOrder.length !== currOrder.length || prevOrder.some((id, i) => id !== currOrder[i]);
    if (orderChanged) {
        if (result.promptChange) {
            result.promptChange.reordered = true;
        } else {
            result.promptChange = { added: 0, removed: 0, modified: 0, reordered: true };
        }
        // 只有当 prompts 数组没变化但顺序变了时才单独打标签
        if (!result.tags.some(t => t.type.startsWith('prompt-'))) {
            result.tags.push({ type: 'prompt-reorder', label: 'Reorder' });
        }
    }

    // 3. 启用状态变化（prompt_order 中的 enabled 字段）
    const enabledDiff = compareEnabled(prev.prompt_order, curr.prompt_order);
    if (enabledDiff.toggled > 0) {
        result.tags.push({ type: 'prompt-toggle', label: 'Toggle', count: enabledDiff.toggled });
    }

    // 4. 标量字段比较（temperature 之类）
    const scalarDiff = compareScalars(prev, curr);
    if (scalarDiff.length > 0) {
        result.details = scalarDiff.slice(0, 6);
        // 给整体打个 settings 标签（区别于 prompt 修改）
        if (!result.tags.some(t => t.type === 'settings')) {
            result.tags.push({ type: 'settings', label: 'Settings', count: scalarDiff.length });
        }
    }

    // 没有任何检测到的修改，但 hash 已经不一样了 -> 给个 minor 标签
    if (result.tags.length === 0) {
        result.tags.push({ type: 'minor', label: 'Minor' });
    }

    return result;
}

/**
 * 比较 prompts 数组（按 identifier 匹配）
 */
function comparePrompts(prev, curr) {
    const prevMap = new Map();
    for (const p of prev) {
        if (p && p.identifier) prevMap.set(p.identifier, p);
    }
    const currMap = new Map();
    for (const p of curr) {
        if (p && p.identifier) currMap.set(p.identifier, p);
    }

    let added = 0, removed = 0, modified = 0;
    for (const id of currMap.keys()) {
        if (!prevMap.has(id)) added++;
        else {
            // 比较内容
            const a = prevMap.get(id);
            const b = currMap.get(id);
            if (!shallowPromptEqual(a, b)) modified++;
        }
    }
    for (const id of prevMap.keys()) {
        if (!currMap.has(id)) removed++;
    }
    return { added, removed, modified, reordered: false };
}

function shallowPromptEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    // 关键字段：name, content, role, system_prompt, marker, injection_position
    const keys = ['name', 'content', 'role', 'system_prompt', 'marker', 'injection_position', 'injection_depth', 'forbid_overrides'];
    for (const k of keys) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

/**
 * 提取 prompt_order 的 identifier 顺序（不含 enabled 状态）
 */
function extractOrder(prompt_order) {
    if (!Array.isArray(prompt_order) || !prompt_order.length) return [];
    const first = prompt_order[0];
    if (!first || !Array.isArray(first.order)) return [];
    return first.order.map(o => o?.identifier).filter(Boolean);
}

/**
 * 比较 enabled 切换数
 */
function compareEnabled(prevOrder, currOrder) {
    const prevMap = new Map();
    if (Array.isArray(prevOrder) && prevOrder[0]?.order) {
        for (const o of prevOrder[0].order) {
            if (o?.identifier) prevMap.set(o.identifier, !!o.enabled);
        }
    }
    let toggled = 0;
    if (Array.isArray(currOrder) && currOrder[0]?.order) {
        for (const o of currOrder[0].order) {
            if (!o?.identifier) continue;
            if (prevMap.has(o.identifier) && prevMap.get(o.identifier) !== !!o.enabled) {
                toggled++;
            }
        }
    }
    return { toggled };
}

/**
 * 字段级 diff（仅标量类型 + 数组长度）
 */
const SUMMARY_IGNORED_KEYS = new Set([
    'prompts', 'prompt_order', 'extensions',
    // 噪音字段
    'preset_settings_openai', 'name',
    // 内部
    'bias_presets', 'bias_preset_selected',
]);

function compareScalars(prev, curr) {
    const out = [];
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
    for (const k of allKeys) {
        if (SUMMARY_IGNORED_KEYS.has(k)) continue;
        const a = prev[k];
        const b = curr[k];
        if (deepEqualStrict(a, b)) continue;

        // 仅记录人类可读类型
        const ta = typeof a, tb = typeof b;
        if ((ta === 'function') || (tb === 'function')) continue;
        // 复杂对象只记录有/无变化，不展开
        if (typeof a === 'object' || typeof b === 'object') {
            // 数组：只记录长度变化
            if (Array.isArray(a) || Array.isArray(b)) {
                const la = Array.isArray(a) ? a.length : 0;
                const lb = Array.isArray(b) ? b.length : 0;
                if (la !== lb) out.push({ key: k, from: `[${la}]`, to: `[${lb}]` });
                continue;
            }
            out.push({ key: k, from: '(object)', to: '(object)' });
            continue;
        }
        out.push({ key: k, from: a, to: b });
    }
    // 排序：把"用户最常关心的"放前面
    const PRIORITY = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'max_context_unlocked', 'openai_max_tokens', 'openai_max_context', 'reasoning_effort'];
    out.sort((a, b) => {
        const ai = PRIORITY.indexOf(a.key);
        const bi = PRIORITY.indexOf(b.key);
        if (ai !== bi) {
            if (ai < 0) return 1;
            if (bi < 0) return -1;
            return ai - bi;
        }
        return a.key.localeCompare(b.key);
    });
    return out;
}

function deepEqualStrict(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    return stableStringify(a) === stableStringify(b);
}

async function ensureStore() {
    if (!_initialized || !_store) {
        throw new Error('HistoryStore not initialized');
    }
}

async function getKeys(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _keysCache && (now - _keysCacheTime) < KEYS_CACHE_TTL) {
        return _keysCache;
    }
    _keysCache = await _store.keys();
    _keysCacheTime = now;
    return _keysCache;
}

function invalidateKeysCache() {
    _keysCache = null;
}

function isQuotaError(e) {
    return e && (
        e.name === 'QuotaExceededError' ||
        e.code === 22 ||
        e.code === 1014 ||
        /quota|exceed/i.test(e.message || '')
    );
}

// =====================================================
// 核心: 添加快照
// =====================================================
/**
 * 添加快照
 *
 * 智能行为:
 *   - 内容与最新快照相同 -> 跳过 (返回 null)
 *   - 在合并窗口内且触发类型相同 -> 替换最新快照（更新时间戳）
 *   - 否则创建新快照，并按上限自动裁剪旧记录
 *
 * @param {string} presetName 预设名
 * @param {string} apiId API类型
 * @param {object} preset 完整预设数据
 * @param {string} trigger 触发类型
 * @returns {Promise<object|null>} 创建的快照（跳过时返回 null）
 */
export async function addSnapshot(presetName, apiId, preset, trigger = TRIGGER.AUTO) {
    await ensureStore();

    if (!presetName || !apiId || !preset) {
        logger.warn('addSnapshot: invalid params', { presetName, apiId, hasPreset: !!preset });
        return null;
    }

    // 空预设保护：避免存入 {} 这类无效快照
    if (typeof preset !== 'object' || Array.isArray(preset)) {
        logger.warn(`addSnapshot: preset is not a plain object, type=${typeof preset}`);
        return null;
    }
    const presetKeys = Object.keys(preset);
    if (presetKeys.length < 5) {
        logger.warn(
            `addSnapshot: rejecting preset with only ${presetKeys.length} fields ` +
            `(${presetKeys.slice(0, 5).join(',')}). This is likely a bad snapshot from a broken read.`
        );
        return null;
    }

    const key = makeKey(apiId, presetName);
    const list = (await _store.getItem(key)) || [];
    const settings = getSettings();
    const now = Date.now();
    const presetStr = stableStringify(preset);
    const hash = computeHashFromString(presetStr);
    const size = presetStr.length;

    // 1. 去重: 与最新一条相同则跳过
    if (settings.skipUnchangedSave && list.length > 0 && list[0].hash === hash) {
        logger.debug(`Snapshot skipped (unchanged): ${presetName}`);
        return null;
    }

    // 计算修改摘要（对比上一条快照）
    const previousSnapshot = list.length > 0 ? list[0] : null;
    const summary = computeChangeSummary(previousSnapshot?.preset, preset);

    // 2. 合并窗口: 在窗口期内且触发类型相同 -> 替换最新
    const mergeWindowMs = settings.mergeWindowSec * 1000;
    if (mergeWindowMs > 0 && list.length > 0 && list[0].trigger === trigger) {
        const elapsed = now - list[0].timestamp;
        if (elapsed < mergeWindowMs) {
            // 合并时摘要应基于"被合并条之前的那一条"
            const baseSnapshot = list.length > 1 ? list[1] : null;
            const mergedSummary = computeChangeSummary(baseSnapshot?.preset, preset);
            const merged = {
                ...list[0],
                timestamp: now,
                preset: structuredClone(preset),
                hash,
                size,
                summary: mergedSummary,
            };
            list[0] = merged;
            await safeSetItem(key, list);
            logger.debug(`Snapshot merged (within ${settings.mergeWindowSec}s): ${presetName}`);
            return merged;
        }
    }

    // 3. 创建新快照
    const snapshot = {
        id: generateId(),
        presetName,
        apiId,
        timestamp: now,
        trigger,
        preset: structuredClone(preset),
        hash,
        size,
        summary,
    };

    list.unshift(snapshot);

    // 4. 按上限裁剪
    const max = settings.maxHistoryPerPreset;
    if (list.length > max) {
        list.length = max;
    }

    await safeSetItem(key, list);
    logger.debug(`Snapshot added: ${presetName} (total: ${list.length}/${max}) tags=${summary.tags.map(t => t.label).join(',')}`);
    return snapshot;
}

/** 复用 hashPreset 但避免再次序列化 */
function computeHashFromString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * 安全的 setItem，处理配额超限
 */
async function safeSetItem(key, value) {
    try {
        await _store.setItem(key, value);
        invalidateKeysCache();
    } catch (e) {
        if (isQuotaError(e)) {
            logger.warn('Storage quota exceeded, attempting emergency cleanup...');
            await emergencyCleanup();
            try {
                await _store.setItem(key, value);
                invalidateKeysCache();
            } catch (e2) {
                logger.error('Storage still failing after cleanup:', e2);
                throw new Error('Storage quota exceeded after cleanup');
            }
        } else {
            throw e;
        }
    }
}

/**
 * 紧急清理：每个预设只保留最近10条
 */
async function emergencyCleanup() {
    const keys = await getKeys(true);
    let removed = 0;
    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        if (list.length > 10) {
            removed += list.length - 10;
            list.length = 10;
            await _store.setItem(key, list);
        }
    }
    invalidateKeysCache();
    logger.warn(`Emergency cleanup: removed ${removed} snapshots`);
}

// =====================================================
// 查询
// =====================================================
/**
 * 获取某预设的所有快照（按时间倒序）
 */
export async function getSnapshots(apiId, presetName) {
    await ensureStore();
    const key = makeKey(apiId, presetName);
    const list = await _store.getItem(key);
    return Array.isArray(list) ? list : [];
}

/**
 * 获取所有快照（跨预设、跨API，按时间倒序）
 */
export async function getAllSnapshots() {
    await ensureStore();
    const keys = await getKeys();
    const all = [];

    for (const key of keys) {
        const list = await _store.getItem(key);
        if (Array.isArray(list)) {
            all.push(...list);
        }
    }

    return all.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 根据 ID 查找快照
 */
export async function getSnapshotById(snapshotId) {
    await ensureStore();
    const keys = await getKeys();

    for (const key of keys) {
        const list = await _store.getItem(key);
        if (!Array.isArray(list)) continue;
        const found = list.find(s => s.id === snapshotId);
        if (found) return found;
    }

    return null;
}

/**
 * 获取所有有历史记录的预设的概览
 * @returns {Promise<Array<{apiId, presetName, count, latest, size}>>}
 */
export async function getPresetList() {
    await ensureStore();
    const keys = await getKeys();
    const result = [];

    for (const key of keys) {
        const parsed = parseKey(key);
        if (!parsed) continue;
        const list = await _store.getItem(key);
        if (Array.isArray(list) && list.length > 0) {
            result.push({
                apiId: parsed.apiId,
                presetName: parsed.presetName,
                count: list.length,
                latest: list[0].timestamp,
                size: list.reduce((sum, s) => sum + (s.size || 0), 0),
            });
        }
    }

    return result.sort((a, b) => b.latest - a.latest);
}

/**
 * 按时间分组（今天/昨天/本周/更早）
 */
export function groupByTime(snapshots) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const dayOfWeek = now.getDay() || 7;
    const startOfWeek = startOfToday - (dayOfWeek - 1) * 86400000;

    const groups = {
        today: [],
        yesterday: [],
        thisWeek: [],
        earlier: [],
    };

    for (const snap of snapshots) {
        const ts = snap.timestamp;
        if (ts >= startOfToday) {
            groups.today.push(snap);
        } else if (ts >= startOfYesterday) {
            groups.yesterday.push(snap);
        } else if (ts >= startOfWeek) {
            groups.thisWeek.push(snap);
        } else {
            groups.earlier.push(snap);
        }
    }

    return groups;
}

/**
 * 筛选快照
 * @param {object} filter
 * @param {string} [filter.apiId]
 * @param {string} [filter.presetName]
 * @param {string} [filter.trigger]
 * @param {number} [filter.startTime]
 * @param {number} [filter.endTime]
 * @param {string} [filter.search] 模糊匹配预设名
 */
export async function filterSnapshots(filter = {}) {
    let all = await getAllSnapshots();

    if (filter.apiId) {
        all = all.filter(s => s.apiId === filter.apiId);
    }
    if (filter.presetName) {
        all = all.filter(s => s.presetName === filter.presetName);
    }
    if (filter.trigger) {
        all = all.filter(s => s.trigger === filter.trigger);
    }
    if (filter.startTime) {
        all = all.filter(s => s.timestamp >= filter.startTime);
    }
    if (filter.endTime) {
        all = all.filter(s => s.timestamp <= filter.endTime);
    }
    if (filter.search) {
        const q = filter.search.toLowerCase();
        all = all.filter(s => (s.presetName || '').toLowerCase().includes(q));
    }

    return all;
}

// =====================================================
// 删除
// =====================================================
/**
 * 删除单个快照
 */
export async function deleteSnapshot(snapshotId) {
    await ensureStore();
    const keys = await getKeys();

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        const idx = list.findIndex(s => s.id === snapshotId);
        if (idx >= 0) {
            list.splice(idx, 1);
            if (list.length === 0) {
                await _store.removeItem(key);
            } else {
                await _store.setItem(key, list);
            }
            invalidateKeysCache();
            logger.debug('Snapshot deleted:', snapshotId);
            return true;
        }
    }

    return false;
}

/**
 * 清空某预设的所有历史
 */
export async function clearPresetHistory(apiId, presetName) {
    await ensureStore();
    const key = makeKey(apiId, presetName);
    await _store.removeItem(key);
    invalidateKeysCache();
    logger.info(`Cleared history for: [${apiId}] ${presetName}`);
}

/**
 * 清空所有历史
 */
export async function clearAll() {
    await ensureStore();
    const keys = await getKeys(true);
    for (const key of keys) {
        await _store.removeItem(key);
    }
    invalidateKeysCache();
    logger.info('All history cleared');
}

/**
 * 清理所有"损坏"的快照（preset 为空或字段过少）
 * 这些通常是早期 bug 留下的污染数据
 * @returns {Promise<{cleaned: number, scanned: number}>}
 */
export async function cleanCorruptSnapshots() {
    await ensureStore();
    const keys = await getKeys(true);
    let cleaned = 0;
    let scanned = 0;

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        scanned += list.length;
        const filtered = list.filter(s => {
            if (!s || !s.preset || typeof s.preset !== 'object') return false;
            const fieldCount = Object.keys(s.preset).length;
            return fieldCount >= 5;
        });
        const removed = list.length - filtered.length;
        if (removed > 0) {
            cleaned += removed;
            if (filtered.length === 0) {
                await _store.removeItem(key);
            } else {
                await _store.setItem(key, filtered);
            }
        }
    }

    invalidateKeysCache();
    logger.info(`Cleanup: removed ${cleaned} corrupt snapshots out of ${scanned} scanned`);
    return { cleaned, scanned };
}

/**
 * 删除超过指定数量的旧快照（保留每预设最新的 N 条）
 */
export async function trimOldSnapshots(keepPerPreset = null) {
    await ensureStore();
    const keep = keepPerPreset ?? getSettings().maxHistoryPerPreset;
    const keys = await getKeys(true);
    let trimmed = 0;

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        if (list.length > keep) {
            trimmed += list.length - keep;
            list.length = keep;
            await _store.setItem(key, list);
        }
    }

    invalidateKeysCache();
    logger.info(`Trimmed ${trimmed} old snapshots (keep ${keep} per preset)`);
    return trimmed;
}

/**
 * 删除超过指定天数的旧快照
 */
export async function trimByAge(maxDays) {
    await ensureStore();
    if (!Number.isFinite(maxDays) || maxDays <= 0) return 0;

    const cutoff = Date.now() - maxDays * 86400000;
    const keys = await getKeys(true);
    let trimmed = 0;

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        const filtered = list.filter(s => s.timestamp >= cutoff);
        if (filtered.length !== list.length) {
            trimmed += list.length - filtered.length;
            if (filtered.length === 0) {
                await _store.removeItem(key);
            } else {
                await _store.setItem(key, filtered);
            }
        }
    }

    invalidateKeysCache();
    logger.info(`Trimmed ${trimmed} snapshots older than ${maxDays} days`);
    return trimmed;
}

// =====================================================
// 统计
// =====================================================
export async function getStats() {
    if (!_initialized) {
        return {
            snapshotCount: 0,
            presetCount: 0,
            totalSize: 0,
            totalSizeFormatted: '0 B',
        };
    }

    const keys = await getKeys();
    let snapshotCount = 0;
    let totalSize = 0;
    let presetCount = 0;

    for (const key of keys) {
        const list = await _store.getItem(key);
        if (Array.isArray(list) && list.length > 0) {
            presetCount++;
            snapshotCount += list.length;
            for (const snap of list) {
                totalSize += snap.size || 0;
            }
        }
    }

    return {
        snapshotCount,
        presetCount,
        totalSize,
        totalSizeFormatted: formatBytes(totalSize),
    };
}

// =====================================================
// 导出/导入（备份/还原用）
// =====================================================
/**
 * 导出所有数据
 */
export async function exportAll() {
    await ensureStore();
    const keys = await getKeys();
    const data = {};

    for (const key of keys) {
        const list = await _store.getItem(key);
        if (list) data[key] = list;
    }

    return {
        version: 1,
        exportedAt: Date.now(),
        data,
    };
}

/**
 * 导入数据
 * @param {object} payload exportAll() 的返回值
 * @param {'merge'|'replace'} mode 合并或替换
 */
export async function importAll(payload, mode = 'merge') {
    await ensureStore();
    if (!payload || !payload.data || typeof payload.data !== 'object') {
        throw new Error('Invalid import payload');
    }

    // 版本兼容性检查
    if (payload.version && payload.version > 1) {
        logger.warn(`Import payload version ${payload.version} may not be fully compatible`);
    }

    if (mode === 'replace') {
        await clearAll();
    }

    const max = getSettings().maxHistoryPerPreset;
    let imported = 0;

    for (const [key, list] of Object.entries(payload.data)) {
        if (!Array.isArray(list)) continue;

        if (mode === 'merge') {
            const existing = (await _store.getItem(key)) || [];
            const existingIds = new Set(existing.map(s => s.id));
            const merged = [...existing];
            for (const snap of list) {
                if (snap && snap.id && !existingIds.has(snap.id)) {
                    merged.push(snap);
                    imported++;
                }
            }
            merged.sort((a, b) => b.timestamp - a.timestamp);
            // 裁剪到设置的上限
            if (merged.length > max) {
                merged.length = max;
            }
            await _store.setItem(key, merged);
        } else {
            // replace 模式也裁剪
            const sliced = list.slice(0, max);
            await _store.setItem(key, sliced);
            imported += sliced.length;
        }
    }

    invalidateKeysCache();
    logger.info(`Imported ${imported} snapshots (mode: ${mode})`);
    return imported;
}

// =====================================================
// 公开状态
// =====================================================
export function isReady() {
    return _initialized;
}