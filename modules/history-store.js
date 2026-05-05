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
import { createStorage, normalizePresetFields, sanitizePresetForExport, filterExtensionPrompts, FIELD_SYNONYMS, EXPORT_EXCLUDED_FIELDS, DISPLAY_IGNORED_FIELDS } from './compatibility.js';

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
    RESTORE: 'restore',             // 恢复快照
});

/** trigger -> i18n key 映射，渲染时再用 t() 翻译 */
export const TRIGGER_LABEL_KEYS = Object.freeze({
    auto: 'Trigger Auto',
    switch_guard: 'Trigger Switch Guard',
    manual: 'Trigger Manual',
    restore: 'Trigger Restore',
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
 *
 * 性能优化：
 *  - 对同一对象引用使用 WeakMap 缓存（保留 1 次循环周期）
 *  - 处理循环引用（避免堆栈溢出）
 *  - 处理 NaN/Infinity（JSON.stringify 默认输出 null，这里保持一致）
 */
const _stringifyCache = new WeakMap();
const _SEEN_DURING_CALL = new WeakSet();

export function stableStringify(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    // 缓存命中：同一对象引用未变化时直接返回（hashPreset 在同一 tick 多次调用时常见）
    const cached = _stringifyCache.get(obj);
    if (cached !== undefined) return cached;

    const result = stableStringifyImpl(obj);
    try { _stringifyCache.set(obj, result); } catch (_) { /* primitive - shouldn't happen */ }
    return result;
}

function stableStringifyImpl(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);

    // 防御循环引用
    if (_SEEN_DURING_CALL.has(obj)) return '"[Circular]"';
    _SEEN_DURING_CALL.add(obj);

    try {
        if (Array.isArray(obj)) {
            const parts = new Array(obj.length);
            for (let i = 0; i < obj.length; i++) {
                parts[i] = stableStringifyImpl(obj[i]);
            }
            return '[' + parts.join(',') + ']';
        }
        const keys = Object.keys(obj).sort();
        const parts = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            parts[i] = JSON.stringify(k) + ':' + stableStringifyImpl(obj[k]);
        }
        return '{' + parts.join(',') + '}';
    } finally {
        _SEEN_DURING_CALL.delete(obj);
    }
}

/**
 * FNV-1a 32-bit 哈希（直接对字符串）
 */
function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * 计算预设内容哈希（FNV-1a 32-bit）
 *
 * 注：getPresetSnapshot → sanitizePresetForExport 已在源头过滤了所有
 * 非预设字段，传入的 obj 已经是干净数据，无需再做条件过滤。
 */
export function hashPreset(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return fnv1aHash(stableStringify(obj));
}

// S-1: FIELD_SYNONYMS, normalizePresetFields, sanitizePresetForExport, EXPORT_EXCLUDED_FIELDS
// 已迁移至 compatibility.js（底层模块），避免循环依赖。
// 从 compatibility.js 导入并重新导出，保持向后兼容。
// @deprecated — 请直接从 './compatibility.js' 导入，此处 re-export 仅为向后兼容，将在未来版本移除。
export { normalizePresetFields, sanitizePresetForExport, FIELD_SYNONYMS, EXPORT_EXCLUDED_FIELDS, DISPLAY_IGNORED_FIELDS };

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 计算两份预设之间的修改摘要（结构化、人类可读）
 *
 * 摘要不包含 i18n 文案——只描述"发生了什么"，由 UI 层（history-panel）翻译。
 * 这样旧快照在切换语言时也能正确显示。
 *
 * @param {object|null} prev - 上一份快照的 preset（可能为 null = 第一条快照）
 * @param {object|null} curr - 当前 preset
 * @returns {{
 *   isFirst: boolean,
 *   sections: Array<{
 *       kind: 'prompt-add'|'prompt-del'|'prompt-edit'|'prompt-toggle-on'|'prompt-toggle-off'|'prompt-reorder'|'field',
 *       items: Array<object>
 *   }>,
 *   counts: {
 *       promptAdded: number, promptRemoved: number, promptModified: number,
 *       promptReordered: number, promptToggledOn: number, promptToggledOff: number,
 *       fieldChanged: number
 *   }
 * }}
 */
export function computeChangeSummary(prev, curr) {
    const result = {
        isFirst: false,
        sections: [],
        counts: {
            promptAdded: 0,
            promptRemoved: 0,
            promptModified: 0,
            promptReordered: 0,
            promptToggledOn: 0,
            promptToggledOff: 0,
            fieldChanged: 0,
        },
    };

    if (!curr || typeof curr !== 'object') return result;
    if (!prev || typeof prev !== 'object') {
        result.isFirst = true;
        return result;
    }

    // 对比前过滤扩展注入的 prompt（确保新旧快照使用相同标准，
    // 避免旧快照包含而新快照不包含时产生虚假的"删除"摘要）
    const prevPrompts = filterExtensionPrompts(
        Array.isArray(prev.prompts) ? prev.prompts : [],
        prev.prompt_order,
    );
    const currPrompts = filterExtensionPrompts(
        Array.isArray(curr.prompts) ? curr.prompts : [],
        curr.prompt_order,
    );

    // 1. Prompts 增删改（带 name + 改动字段明细）
    const promptDiff = comparePromptsDetail(prevPrompts, currPrompts);
    if (promptDiff.added.length > 0) {
        result.sections.push({ kind: 'prompt-add', items: promptDiff.added });
        result.counts.promptAdded = promptDiff.added.length;
    }
    if (promptDiff.removed.length > 0) {
        result.sections.push({ kind: 'prompt-del', items: promptDiff.removed });
        result.counts.promptRemoved = promptDiff.removed.length;
    }
    if (promptDiff.modified.length > 0) {
        result.sections.push({ kind: 'prompt-edit', items: promptDiff.modified });
        result.counts.promptModified = promptDiff.modified.length;
    }

    // 2. 顺序调整（仅在 prompts 数组本身没增减时才单独显示）
    const prevOrder = extractOrder(prev.prompt_order);
    const currOrder = extractOrder(curr.prompt_order);
    const reorderCount = countReorderedPositions(prevOrder, currOrder);
    if (reorderCount > 0) {
        result.sections.push({ kind: 'prompt-reorder', items: [{ count: reorderCount }] });
        result.counts.promptReordered = reorderCount;
    }

    // 3. enabled 切换（按提示词名）
    const enabledDiff = compareEnabledDetail(prev.prompt_order, curr.prompt_order, currPrompts, prevPrompts);
    if (enabledDiff.toggledOn.length > 0) {
        result.sections.push({ kind: 'prompt-toggle-on', items: enabledDiff.toggledOn });
        result.counts.promptToggledOn = enabledDiff.toggledOn.length;
    }
    if (enabledDiff.toggledOff.length > 0) {
        result.sections.push({ kind: 'prompt-toggle-off', items: enabledDiff.toggledOff });
        result.counts.promptToggledOff = enabledDiff.toggledOff.length;
    }

    // 4. 标量字段
    const scalarDiff = compareScalars(prev, curr);
    if (scalarDiff.length > 0) {
        // 留 12 项给 UI 决定显示几条（默认显示 5）
        result.sections.push({ kind: 'field', items: scalarDiff.slice(0, 12) });
        result.counts.fieldChanged = scalarDiff.length;
    }

    return result;
}

/**
 * 详细比较 prompts，返回 added / removed / modified（含 name 与改动字段）
 */
function comparePromptsDetail(prev, curr) {
    const prevMap = new Map();
    for (const p of prev) {
        if (p && p.identifier) prevMap.set(p.identifier, p);
    }
    const currMap = new Map();
    for (const p of curr) {
        if (p && p.identifier) currMap.set(p.identifier, p);
    }

    const added = [];
    const removed = [];
    const modified = [];

    for (const id of currMap.keys()) {
        const b = currMap.get(id);
        if (!prevMap.has(id)) {
            added.push({
                identifier: id,
                name: getPromptDisplayName(b),
                marker: !!b?.marker,
            });
            continue;
        }
        const a = prevMap.get(id);
        const fields = diffPromptFields(a, b);
        if (fields.length > 0) {
            modified.push({
                identifier: id,
                name: getPromptDisplayName(b) || getPromptDisplayName(a),
                fields,
            });
        }
    }
    for (const id of prevMap.keys()) {
        if (!currMap.has(id)) {
            const a = prevMap.get(id);
            removed.push({
                identifier: id,
                name: getPromptDisplayName(a),
                marker: !!a?.marker,
            });
        }
    }
    return { added, removed, modified };
}

/**
 * 取一个用于显示的提示词名：优先 name，回落到 identifier 截断
 */
function getPromptDisplayName(p) {
    if (!p) return '';
    if (typeof p.name === 'string' && p.name.trim()) return p.name.trim();
    if (typeof p.identifier === 'string' && p.identifier) {
        // identifier 通常是 UUID 或 main/jailbreak 等关键字
        return p.identifier.length > 16 ? p.identifier.slice(0, 8) + '…' : p.identifier;
    }
    return '';
}

/**
 * 比较两个 prompt 对象，返回改动了的字段列表
 * 对 content 字段不存原值（太长），只记录长度差。
 */
function diffPromptFields(a, b) {
    const watchKeys = ['name', 'content', 'role', 'system_prompt', 'marker', 'injection_position', 'injection_depth', 'forbid_overrides'];
    const out = [];
    for (const k of watchKeys) {
        const av = a?.[k];
        const bv = b?.[k];
        if (av === bv) continue;
        if (k === 'content') {
            const fromLen = (typeof av === 'string') ? av.length : 0;
            const toLen = (typeof bv === 'string') ? bv.length : 0;
            if (fromLen !== toLen || av !== bv) {
                out.push({ key: 'content', isContent: true, fromLen, toLen });
            }
            continue;
        }
        // 其他字段保留原值（短）
        out.push({ key: k, from: av, to: bv });
    }
    return out;
}

/**
 * 提取 prompt_order 的 identifier 顺序
 */
function extractOrder(prompt_order) {
    if (!Array.isArray(prompt_order) || !prompt_order.length) return [];
    const merged = [];
    for (const group of prompt_order) {
        if (group && Array.isArray(group.order)) {
            for (const o of group.order) {
                if (o?.identifier) merged.push(o.identifier);
            }
        }
    }
    return merged;
}

/**
 * 计算"位置变了的条目"个数
 * 长度变化时返回 0（认为属于增删，由 prompt-add/prompt-del 显示更准确）
 */
function countReorderedPositions(prevOrder, currOrder) {
    if (prevOrder.length !== currOrder.length) return 0;
    let diff = 0;
    for (let i = 0; i < prevOrder.length; i++) {
        if (prevOrder[i] !== currOrder[i]) diff++;
    }
    return diff;
}

/**
 * 详细比较 enabled 切换：按 identifier 匹配，输出启用/禁用各自的列表
 * 同时附带 name 用于显示（从当前预设的 prompts 取，找不到再回落到旧的）
 */
function compareEnabledDetail(prevOrder, currOrder, currPrompts, prevPrompts) {
    const prevMap = new Map();
    if (Array.isArray(prevOrder)) {
        for (const group of prevOrder) {
            if (!group || !Array.isArray(group.order)) continue;
            for (const o of group.order) {
                if (o?.identifier) prevMap.set(o.identifier, !!o.enabled);
            }
        }
    }

    const nameMap = new Map();
    for (const p of currPrompts) {
        if (p?.identifier) nameMap.set(p.identifier, getPromptDisplayName(p));
    }
    for (const p of prevPrompts) {
        if (p?.identifier && !nameMap.has(p.identifier)) {
            nameMap.set(p.identifier, getPromptDisplayName(p));
        }
    }

    const toggledOn = [];
    const toggledOff = [];
    if (Array.isArray(currOrder)) {
        for (const group of currOrder) {
            if (!group || !Array.isArray(group.order)) continue;
            for (const o of group.order) {
                if (!o?.identifier) continue;
                if (!prevMap.has(o.identifier)) continue;
                const wasEnabled = prevMap.get(o.identifier);
                const isEnabled = !!o.enabled;
                if (wasEnabled === isEnabled) continue;
                const item = {
                    identifier: o.identifier,
                    name: nameMap.get(o.identifier) || '',
                };
                if (isEnabled) toggledOn.push(item);
                else toggledOff.push(item);
            }
        }
    }
    return { toggledOn, toggledOff };
}

/**
 * 标量字段比较 - 排除明显属于 prompt 范畴或内部用途的键
 */
// 使用 DISPLAY_IGNORED_FIELDS（从 compatibility.js 导入），与导出排除字段保持同步
const SUMMARY_IGNORED_KEYS = DISPLAY_IGNORED_FIELDS;

function compareScalars(prev, curr) {
    // 规范化字段名后再比较，避免同义字段产生虚假 diff
    const nPrev = normalizePresetFields(prev);
    const nCurr = normalizePresetFields(curr);
    const out = [];
    const allKeys = new Set([...Object.keys(nPrev), ...Object.keys(nCurr)]);
    for (const k of allKeys) {
        if (SUMMARY_IGNORED_KEYS.has(k)) continue;
        const a = nPrev[k];
        const b = nCurr[k];
        if (deepEqualStrict(a, b)) continue;

        const ta = typeof a, tb = typeof b;
        if ((ta === 'function') || (tb === 'function')) continue;

        // 复杂对象/数组：只记录长度差异（避免输出 [object Object]）
        if (typeof a === 'object' || typeof b === 'object') {
            if (Array.isArray(a) || Array.isArray(b)) {
                const la = Array.isArray(a) ? a.length : 0;
                const lb = Array.isArray(b) ? b.length : 0;
                if (la !== lb) {
                    out.push({ key: k, kind: 'array-length', from: la, to: lb });
                }
                continue;
            }
            out.push({ key: k, kind: 'object' });
            continue;
        }
        out.push({ key: k, kind: 'scalar', from: a, to: b });
    }
    // 排序：用户最关心的字段在前
    const PRIORITY = [
        'temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'tfs',
        'frequency_penalty', 'presence_penalty', 'repetition_penalty',
        'reasoning_effort', 'show_thoughts',
        'max_context_unlocked', 'openai_max_tokens', 'openai_max_context',
        'stream_response', 'streaming',
        'function_calling', 'request_images',
        // 角色行为 / Character Behavior 栏目
        'names_behavior', 'continue_prefill', 'continue_postfix',
        'squash_system_messages', 'wrap_in_quotes',
        'assistant_prefill', 'assistant_impersonation',
        'use_sysprompt', 'media_inlining', 'inline_image_quality',
        'enable_web_search', 'send_if_empty', 'verbosity',
        'request_image_aspect_ratio', 'request_image_resolution',
    ];
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
    // AU-0: 数字/字符串类型宽松比较
    // ST 内部的数值字段会在 number 和 string 之间波动（如 2000000 vs "2000000"），
    // 旧快照可能存了字符串、新快照经 normalizeScalarTypes 后已是数字。
    // 将两者视为相同，避免产生虚假 diff（如"从2万变2万"）。
    if (typeof a !== typeof b) {
        if ((typeof a === 'number' || typeof a === 'string') &&
            (typeof b === 'number' || typeof b === 'string')) {
            // 两者都是数字或能安全转换为数字时比较数值
            const na = Number(a);
            const nb = Number(b);
            if (Number.isFinite(na) && Number.isFinite(nb) && na === nb) return true;
            // 如果不是数字，按字符串比较
            if (String(a) === String(b)) return true;
        }
        return false;
    }
    if (typeof a !== 'object') return a === b;
    return stableStringify(a) === stableStringify(b);
}

async function ensureStore() {
    if (!_initialized || !_store) {
        throw new Error('HistoryStore not initialized');
    }
}

let _keysFetchPromise = null;  // 并发去重

async function getKeys(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _keysCache && (now - _keysCacheTime) < KEYS_CACHE_TTL) {
        return _keysCache;
    }
    // 并发保护：多个调用者同时进来时，只发起一次后端查询
    if (_keysFetchPromise) return _keysFetchPromise;
    _keysFetchPromise = (async () => {
        try {
            _keysCache = await _store.keys();
            _keysCacheTime = Date.now();
            return _keysCache;
        } finally {
            _keysFetchPromise = null;
        }
    })();
    return _keysFetchPromise;
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

/**
 * 裁剪一个快照列表到上限，但保留所有 pinned 快照。
 * 输入 list 假定已按时间倒序（最新在前），原地修改。
 *
 * 算法：
 *   1) 把 pinned 快照按原顺序提取
 *   2) 把非 pinned 也按原顺序提取，取前 (max - pinnedCount) 条
 *   3) 重新合并并按 timestamp 倒序
 *
 * 极端情况：pinned 数量 ≥ max 时全部保留 pinned + 最新一条非 pinned，
 * 避免锁定泛滥导致新快照立即被挤走（这通常说明用户应该提高上限了）。
 */
function trimListWithPinned(list, max) {
    if (!Array.isArray(list) || list.length <= max) return list;
    const pinned = list.filter(s => s && s.pinned);
    const unpinned = list.filter(s => s && !s.pinned);
    const keepUnpinnedCount = Math.max(1, max - pinned.length);
    const keptUnpinned = unpinned.slice(0, keepUnpinnedCount);
    const merged = [...pinned, ...keptUnpinned].sort((a, b) => b.timestamp - a.timestamp);
    list.length = 0;
    for (const s of merged) list.push(s);
    return list;
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
    //   manual trigger 不受 skipUnchangedSave 限制 —— 用户明确要求"立即快照"时
    //   不应该被静默跳过（resetLastSavedHash 已重置内部 hash，但 store 层也应放行）
    if (
        settings.skipUnchangedSave
        && trigger !== TRIGGER.MANUAL
        && trigger !== TRIGGER.RESTORE
        && list.length > 0
        && list[0].hash === hash
    ) {
        logger.debug(`Snapshot skipped (unchanged): ${presetName}`);
        return null;
    }

    // 计算修改摘要（对比上一条快照）
    const previousSnapshot = list.length > 0 ? list[0] : null;
    const summary = computeChangeSummary(previousSnapshot?.preset, preset);

    // 2. 合并窗口: 在窗口期内且触发类型相同 -> 替换最新
    //    注意: 锁定（pinned）的快照永远不会被合并覆盖
    const mergeWindowMs = settings.mergeWindowSec * 1000;
    if (mergeWindowMs > 0 && list.length > 0 && list[0].trigger === trigger && !list[0].pinned) {
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
        name: '',          // 用户自定义名（"跑通了！"等），默认空
        pinned: false,     // 是否锁定（锁定的快照永不被自动清理/合并）
    };

    list.unshift(snapshot);

    // 4. 按上限裁剪（保留所有 pinned + 最新的非 pinned 直到上限）
    const max = settings.maxHistoryPerPreset;
    trimListWithPinned(list, max);

    await safeSetItem(key, list);
    const desc = describeSummaryForLog(summary);
    logger.debug(`Snapshot added: ${presetName} (total: ${list.length}/${max}) ${desc}`);
    return snapshot;
}

/**
 * 把摘要转成单行日志友好的描述（开发者诊断用，不走 i18n）
 */
function describeSummaryForLog(summary) {
    if (!summary) return 'changes=?';
    if (summary.isFirst) return 'changes=initial';
    const c = summary.counts;
    const parts = [];
    if (c.promptAdded) parts.push(`+${c.promptAdded}p`);
    if (c.promptRemoved) parts.push(`-${c.promptRemoved}p`);
    if (c.promptModified) parts.push(`~${c.promptModified}p`);
    if (c.promptReordered) parts.push(`order×${c.promptReordered}`);
    if (c.promptToggledOn) parts.push(`on×${c.promptToggledOn}`);
    if (c.promptToggledOff) parts.push(`off×${c.promptToggledOff}`);
    if (c.fieldChanged) parts.push(`f×${c.fieldChanged}`);
    return parts.length ? `changes=${parts.join(',')}` : 'changes=minor';
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
            const before = list.length;
            trimListWithPinned(list, 10);
            removed += before - list.length;
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
    if (!keys || keys.length === 0) return [];

    // 性能优化：并行 getItem，IndexedDB 内部能 batch IO
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    const all = [];
    for (const list of lists) {
        if (Array.isArray(list)) all.push(...list);
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 根据 ID 查找快照
 */
export async function getSnapshotById(snapshotId) {
    await ensureStore();
    const keys = await getKeys();
    if (!keys || keys.length === 0) return null;

    // 性能优化：并行查询，更快返回
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    for (const list of lists) {
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
    if (!keys || keys.length === 0) return [];

    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    const result = [];
    for (let i = 0; i < keys.length; i++) {
        const parsed = parseKey(keys[i]);
        if (!parsed) continue;
        const list = lists[i];
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
 *
 * 默认会拒绝删除 pinned 快照（返回 false 并打 warn）。
 * 如果 UI 想强删（例如先解锁再删），传 force=true。
 */
export async function deleteSnapshot(snapshotId, options = {}) {
    await ensureStore();
    const keys = await getKeys();
    const force = options && options.force === true;

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        const idx = list.findIndex(s => s.id === snapshotId);
        if (idx >= 0) {
            if (list[idx].pinned && !force) {
                logger.warn(`Refused to delete pinned snapshot: ${snapshotId}`);
                return false;
            }
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
 * 重命名快照（自定义名字）
 * @param {string} snapshotId
 * @param {string} newName 空字符串表示清除自定义名
 * @returns {Promise<boolean>}
 */
export async function renameSnapshot(snapshotId, newName) {
    await ensureStore();
    const keys = await getKeys();
    const trimmed = (newName || '').toString().trim().slice(0, 80);

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        const snap = list.find(s => s.id === snapshotId);
        if (snap) {
            if ((snap.name || '') === trimmed) return true;
            snap.name = trimmed;
            await _store.setItem(key, list);
            invalidateKeysCache();
            logger.debug(`Snapshot renamed: ${snapshotId} -> "${trimmed}"`);
            return true;
        }
    }
    return false;
}

/**
 * 切换快照的锁定状态
 * @param {string} snapshotId
 * @param {boolean} [pinned] 显式设置；省略则取反
 * @returns {Promise<boolean|null>} 切换后的 pinned 状态；找不到时返回 null
 */
export async function togglePinSnapshot(snapshotId, pinned) {
    await ensureStore();
    const keys = await getKeys();

    for (const key of keys) {
        const list = (await _store.getItem(key)) || [];
        const snap = list.find(s => s.id === snapshotId);
        if (snap) {
            const newVal = (typeof pinned === 'boolean') ? pinned : !snap.pinned;
            if (snap.pinned === newVal) return newVal;
            snap.pinned = newVal;
            await _store.setItem(key, list);
            invalidateKeysCache();
            logger.debug(`Snapshot ${newVal ? 'pinned' : 'unpinned'}: ${snapshotId}`);
            return newVal;
        }
    }
    return null;
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

    // 性能优化：并行读取，但写入仍按顺序避免并发冲突
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    for (let i = 0; i < keys.length; i++) {
        const list = lists[i] || [];
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
                await _store.removeItem(keys[i]);
            } else {
                await _store.setItem(keys[i], filtered);
            }
        }
    }

    invalidateKeysCache();
    logger.info(`Cleanup: removed ${cleaned} corrupt snapshots out of ${scanned} scanned`);
    return { cleaned, scanned };
}

/**
 * 删除超过指定数量的旧快照（保留每预设最新的 N 条 + 所有 pinned）
 */
export async function trimOldSnapshots(keepPerPreset = null) {
    await ensureStore();
    const keep = keepPerPreset ?? getSettings().maxHistoryPerPreset;
    const keys = await getKeys(true);
    let trimmed = 0;

    // 性能优化：并行读取
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    for (let i = 0; i < keys.length; i++) {
        const list = lists[i] || [];
        if (list.length > keep) {
            const before = list.length;
            trimListWithPinned(list, keep);
            trimmed += before - list.length;
            await _store.setItem(keys[i], list);
        }
    }

    invalidateKeysCache();
    logger.info(`Trimmed ${trimmed} old snapshots (keep ${keep} per preset, pinned preserved)`);
    return trimmed;
}

/**
 * 删除超过指定天数的旧快照（pinned 永久保留）
 */
export async function trimByAge(maxDays) {
    await ensureStore();
    if (!Number.isFinite(maxDays) || maxDays <= 0) return 0;

    const cutoff = Date.now() - maxDays * 86400000;
    const keys = await getKeys(true);
    let trimmed = 0;

    // 性能优化：并行读取
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    for (let i = 0; i < keys.length; i++) {
        const list = lists[i] || [];
        // pinned 永远不被按年龄裁剪
        const filtered = list.filter(s => s.pinned || s.timestamp >= cutoff);
        if (filtered.length !== list.length) {
            trimmed += list.length - filtered.length;
            if (filtered.length === 0) {
                await _store.removeItem(keys[i]);
            } else {
                await _store.setItem(keys[i], filtered);
            }
        }
    }

    invalidateKeysCache();
    logger.info(`Trimmed ${trimmed} snapshots older than ${maxDays} days (pinned preserved)`);
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
    if (!keys || keys.length === 0) {
        return { snapshotCount: 0, presetCount: 0, totalSize: 0, totalSizeFormatted: '0 B' };
    }

    // 性能优化：并行获取
    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    let snapshotCount = 0;
    let totalSize = 0;
    let presetCount = 0;

    for (const list of lists) {
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
    if (!keys || keys.length === 0) {
        return { version: 1, exportedAt: Date.now(), data };
    }

    const lists = await Promise.all(keys.map(k => _store.getItem(k).catch(() => null)));
    for (let i = 0; i < keys.length; i++) {
        if (lists[i]) data[keys[i]] = lists[i];
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

    // 性能优化：merge 模式下并行读取已有列表
    const entries = Object.entries(payload.data).filter(([_, v]) => Array.isArray(v));
    const existingMap = new Map();
    if (mode === 'merge' && entries.length > 0) {
        const existingLists = await Promise.all(
            entries.map(([k]) => _store.getItem(k).catch(() => null))
        );
        for (let i = 0; i < entries.length; i++) {
            existingMap.set(entries[i][0], Array.isArray(existingLists[i]) ? existingLists[i] : []);
        }
    }

    for (const [key, list] of entries) {
        if (mode === 'merge') {
            const existing = existingMap.get(key) || [];
            const existingIds = new Set(existing.map(s => s.id));
            const merged = [...existing];
            for (const snap of list) {
                if (snap && snap.id && !existingIds.has(snap.id)) {
                    merged.push(snap);
                    imported++;
                }
            }
            merged.sort((a, b) => b.timestamp - a.timestamp);
            // 裁剪到设置的上限（保留所有 pinned）
            if (merged.length > max) {
                trimListWithPinned(merged, max);
            }
            await _store.setItem(key, merged);
        } else {
            // replace 模式：先按 timestamp 倒序，再用 pinned-aware 裁剪
            const ordered = [...list].sort((a, b) => b.timestamp - a.timestamp);
            if (ordered.length > max) {
                trimListWithPinned(ordered, max);
            }
            await _store.setItem(key, ordered);
            imported += ordered.length;
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