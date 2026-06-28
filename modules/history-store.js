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
import { createStorage, normalizePresetFields, sanitizePresetForExport, filterExtensionPrompts, extractCanonicalForDiff, FIELD_SYNONYMS, EXPORT_EXCLUDED_FIELDS, DISPLAY_IGNORED_FIELDS } from './compatibility.js';
import { createChangeSet, assertExplainableChange } from './core/change-set.js';
import { HistoryRepository } from './core/history-repository.js';
import { SerialTaskQueue } from './core/serial-task-queue.js';
import { emitHistoryChange } from './core/history-change-events.js';
import {
    applyHistoryImportPlan,
    buildHistoryImportPlan,
    captureHistoryImage,
    createHistoryBackup,
    validateHistoryBackup,
} from './core/history-backup.js';

const STORAGE_NAME = 'PresetAutoSave';
const STORE_NAME = 'history';
const V2_STORE_NAME = 'history_v2';
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
const _historyMutations = new SerialTaskQueue();

// =====================================================
// 初始化
// =====================================================
export async function initHistoryStore() {
    try {
        const legacyStore = createStorage(STORAGE_NAME, STORE_NAME);
        const v2Store = createStorage(STORAGE_NAME, V2_STORE_NAME);
        _store = new HistoryRepository({
            legacyStore,
            v2Store,
            onError: (error, context) => logger.warn('History v2 migration deferred:', context, error),
        });
        _initialized = true;
        const presetCount = (await _store.keys()).length;
        logger.success(`History repository v2 ready: ${presetCount} preset histories (lazy migration enabled)`);
    } catch (e) {
        logger.error('Failed to init history store:', e);
        _store = null;
        _initialized = false;
        throw e;
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
 * 正确性优先：
 *  - 不缓存可变对象引用，避免对象原地修改后继续返回旧序列化结果
 *  - 处理循环引用（避免堆栈溢出）
 *  - 处理 NaN/Infinity（JSON.stringify 默认输出 null，这里保持一致）
 */
const _SEEN_DURING_CALL = new WeakSet();

export function stableStringify(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    return stableStringifyImpl(obj);
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
 * 防御性地再次执行统一字段契约，确保实时快照、原生手动保存载荷、
 * 旧历史记录和直接调用都生成相同哈希。
 */
export function hashPreset(obj, apiId = 'openai') {
    if (!obj || typeof obj !== 'object') return '';
    const canonical = sanitizePresetForExport(obj, { apiId });
    return fnv1aHash(stableStringify(canonical));
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
export function computeChangeSummary(prev, curr, apiId = 'openai') {
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

    const canonicalPrev = sanitizePresetForExport(prev, { apiId });
    const canonicalCurr = sanitizePresetForExport(curr, { apiId });
    const rawChangeSet = createChangeSet(prev, curr);
    const changeSet = createChangeSet(canonicalPrev, canonicalCurr);
    assertExplainableChange(canonicalPrev, canonicalCurr, changeSet);
    result.rawChangedPaths = changeSet.changed.map(item => item.path);
    const canonicalPaths = new Set(result.rawChangedPaths);
    result.ignoredPaths = rawChangeSet.changed
        .map(item => item.path)
        .filter(path => !canonicalPaths.has(path));
    result.unchanged = changeSet.changed.length === 0;
    result.onlyIgnoredChanges = result.unchanged && result.ignoredPaths.length > 0;

    // 对比前过滤扩展注入的 prompt（确保新旧快照使用相同标准，
    // 避免旧快照包含而新快照不包含时产生虚假的"删除"摘要）
    const prevPrompts = filterExtensionPrompts(
        Array.isArray(canonicalPrev.prompts) ? canonicalPrev.prompts : [],
        canonicalPrev.prompt_order,
    );
    const currPrompts = filterExtensionPrompts(
        Array.isArray(canonicalCurr.prompts) ? canonicalCurr.prompts : [],
        canonicalCurr.prompt_order,
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
    const prevOrder = extractOrder(canonicalPrev.prompt_order);
    const currOrder = extractOrder(canonicalCurr.prompt_order);
    const reorderCount = countReorderedPositions(prevOrder, currOrder);
    if (reorderCount > 0) {
        result.sections.push({ kind: 'prompt-reorder', items: [{ count: reorderCount }] });
        result.counts.promptReordered = reorderCount;
    }

    // 3. enabled 切换（按提示词名）
    const enabledDiff = compareEnabledDetail(canonicalPrev.prompt_order, canonicalCurr.prompt_order, currPrompts, prevPrompts);
    if (enabledDiff.toggledOn.length > 0) {
        result.sections.push({ kind: 'prompt-toggle-on', items: enabledDiff.toggledOn });
        result.counts.promptToggledOn = enabledDiff.toggledOn.length;
    }
    if (enabledDiff.toggledOff.length > 0) {
        result.sections.push({ kind: 'prompt-toggle-off', items: enabledDiff.toggledOff });
        result.counts.promptToggledOff = enabledDiff.toggledOff.length;
    }

    // 4. 标量字段
    const scalarDiff = compareScalars(canonicalPrev, canonicalCurr);
    const representedKeys = new Set(scalarDiff.map(item => item.key));
    for (const item of changeSet.changed) {
        if (item.path === 'prompts' || item.path.startsWith('prompts[')) continue;
        if (item.path === 'prompt_order' || item.path.startsWith('prompt_order[')) continue;
        if (representedKeys.has(item.path)) continue;
        scalarDiff.push({
            key: item.path,
            kind: 'scalar',
            from: item.before,
            to: item.after,
        });
        representedKeys.add(item.path);
    }
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
function compareScalars(prev, curr) {
    // 规范化字段名后再比较，避免同义字段产生虚假 diff
    const nPrev = normalizePresetFields(prev);
    const nCurr = normalizePresetFields(curr);

    // 阶段7：Canonical 提取 —— 只比较 ST 预设定义中的有效标量字段
    // 基于 ST openai.js settingsToUpdate 白名单，而非黑名单排除法。
    // 任何不在 ST 预设定义中的字段（扩展注入、ST 新字段、字段名拼写差异等）
    // 都不会参与比较，从根本上根治"修改1个参数却显示10个字段变化"的问题。
    const canonPrev = extractCanonicalForDiff(nPrev);
    const canonCurr = extractCanonicalForDiff(nCurr);
    const allKeys = new Set([...Object.keys(canonPrev), ...Object.keys(canonCurr)]);

    const out = [];
    for (const k of allKeys) {
        const a = canonPrev[k];
        const b = canonCurr[k];
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
        'stream_openai',
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

    // 阶段7：空值归一化 —— 将 null / undefined / '' 统一视为等价的"空值"
    // ST 内部字段在不存在时可能是 undefined，在预设重建后又变成 ""，
    // 这导致 deepEqualStrict 将 undefined 和 "" 视为不等，产生"从空变为X"的无意义变更。
    // 归一化后："" == null == undefined → 视为相同，不产生 diff。
    const isNullish = (v) => v === null || v === undefined || v === '';
    if (isNullish(a) && isNullish(b)) return true;
    // 一个为空、另一个非空 → 不等
    if (isNullish(a) || isNullish(b)) return false;

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
export function addSnapshot(presetName, apiId, preset, trigger = TRIGGER.AUTO) {
    return _historyMutations.run(() => addSnapshotMutation(presetName, apiId, preset, trigger));
}

async function addSnapshotMutation(presetName, apiId, preset, trigger = TRIGGER.AUTO) {
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
    const canonicalPreset = sanitizePresetForExport(preset, { apiId });
    const presetKeys = Object.keys(canonicalPreset);
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
    const presetStr = stableStringify(canonicalPreset);
    const hash = computeHashFromString(presetStr);
    const size = presetStr.length;

    // 1. 去重: 与最新一条相同则跳过
    //   manual trigger 不受 skipUnchangedSave 限制 —— 用户明确要求"立即快照"时
    //   不应该被静默跳过（resetLastSavedHash 已重置内部 hash，但 store 层也应放行）
    const previousCanonicalHash = list.length > 0
        ? hashPreset(list[0]?.preset, apiId)
        : '';
    if (
        settings.skipUnchangedSave
        && trigger !== TRIGGER.MANUAL
        && trigger !== TRIGGER.RESTORE
        && list.length > 0
        && (list[0].hash === hash || previousCanonicalHash === hash)
    ) {
        logger.debug(`Snapshot skipped (unchanged): ${presetName}`);
        return null;
    }

    // 计算修改摘要（对比上一条快照）
    const previousSnapshot = list.length > 0 ? list[0] : null;
    const summary = computeChangeSummary(previousSnapshot?.preset, canonicalPreset, apiId);

    // 2. 合并窗口: 在窗口期内且触发类型相同 -> 替换最新
    //    注意: 锁定（pinned）的快照永远不会被合并覆盖
    const mergeWindowMs = settings.mergeWindowSec * 1000;
    if (mergeWindowMs > 0 && list.length > 0 && list[0].trigger === trigger && !list[0].pinned) {
        const elapsed = now - list[0].timestamp;
        if (elapsed < mergeWindowMs) {
            // 合并时摘要应基于"被合并条之前的那一条"
            const baseSnapshot = list.length > 1 ? list[1] : null;
            const mergedSummary = computeChangeSummary(baseSnapshot?.preset, canonicalPreset, apiId);
            const merged = {
                ...list[0],
                timestamp: now,
                preset: structuredClone(canonicalPreset),
                hash,
                size,
                summary: mergedSummary,
            };
            list[0] = merged;
            await safeSetItem(key, list);
            logger.debug(`Snapshot merged (within ${settings.mergeWindowSec}s): ${presetName}`);
            emitHistoryChange({ type: 'snapshot-updated', snapshot: merged });
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
        preset: structuredClone(canonicalPreset),
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
    emitHistoryChange({ type: 'snapshot-added', snapshot });
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
export function deleteSnapshot(snapshotId, options = {}) {
    return _historyMutations.run(() => deleteSnapshotMutation(snapshotId, options));
}

async function deleteSnapshotMutation(snapshotId, options = {}) {
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
export function renameSnapshot(snapshotId, newName) {
    return _historyMutations.run(() => renameSnapshotMutation(snapshotId, newName));
}

async function renameSnapshotMutation(snapshotId, newName) {
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
export function togglePinSnapshot(snapshotId, pinned) {
    return _historyMutations.run(() => togglePinSnapshotMutation(snapshotId, pinned));
}

async function togglePinSnapshotMutation(snapshotId, pinned) {
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
export function clearPresetHistory(apiId, presetName) {
    return _historyMutations.run(() => clearPresetHistoryMutation(apiId, presetName));
}

async function clearPresetHistoryMutation(apiId, presetName) {
    await ensureStore();
    const key = makeKey(apiId, presetName);
    await _store.removeItem(key);
    invalidateKeysCache();
    logger.info(`Cleared history for: [${apiId}] ${presetName}`);
}

/**
 * Delete old snapshots for a preset in a single storage write.
 *
 * This is used by the panel's "clear preset history" action. The older
 * implementation called deleteSnapshot() once per snapshot; each call scanned
 * storage keys and wrote the same preset list back again. On mobile IndexedDB
 * that turned 40 snapshots into dozens of expensive transactions. This helper
 * reads one preset bucket once and writes/removes it once.
 *
 * @param {string} apiId
 * @param {string} presetName
 * @param {{ keepNewest?: number, force?: boolean }} [options]
 * @returns {Promise<{ deleted: number, kept: number, total: number }>}
 */
export function deleteOldSnapshotsForPreset(apiId, presetName, options = {}) {
    return _historyMutations.run(() => deleteOldSnapshotsForPresetMutation(apiId, presetName, options));
}

async function deleteOldSnapshotsForPresetMutation(apiId, presetName, options = {}) {
    await ensureStore();
    const key = makeKey(apiId, presetName);
    const list = await _store.getItem(key);
    if (!Array.isArray(list) || list.length === 0) {
        return { deleted: 0, kept: 0, total: 0 };
    }

    const keepNewest = Math.max(0, Number.isFinite(options.keepNewest) ? Math.floor(options.keepNewest) : 1);
    const force = options && options.force === true;
    const sorted = [...list].sort((a, b) => (b?.timestamp || 0) - (a?.timestamp || 0));
    const keepIds = new Set(sorted.slice(0, keepNewest).map(s => s?.id).filter(Boolean));
    const kept = [];
    let deleted = 0;

    for (const snap of list) {
        if (!snap || keepIds.has(snap.id) || (snap.pinned && !force)) {
            kept.push(snap);
        } else {
            deleted++;
        }
    }

    if (deleted === 0) {
        return { deleted: 0, kept: kept.length, total: list.length };
    }

    kept.sort((a, b) => (b?.timestamp || 0) - (a?.timestamp || 0));
    if (kept.length === 0) {
        await _store.removeItem(key);
    } else {
        await _store.setItem(key, kept);
    }
    invalidateKeysCache();
    logger.info(`Cleared old history for: [${apiId}] ${presetName} · deleted ${deleted}, kept ${kept.length}`);
    return { deleted, kept: kept.length, total: list.length };
}

/**
 * Clear all history.
 */
export function clearAll() {
    return _historyMutations.run(clearAllMutation);
}

async function clearAllMutation() {
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
export function cleanCorruptSnapshots() {
    return _historyMutations.run(cleanCorruptSnapshotsMutation);
}

async function cleanCorruptSnapshotsMutation() {
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
export function trimOldSnapshots(keepPerPreset = null) {
    return _historyMutations.run(() => trimOldSnapshotsMutation(keepPerPreset));
}

async function trimOldSnapshotsMutation(keepPerPreset = null) {
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
export function trimByAge(maxDays) {
    return _historyMutations.run(() => trimByAgeMutation(maxDays));
}

async function trimByAgeMutation(maxDays) {
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
export function computeStatsFromSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return { snapshotCount: 0, presetCount: 0, totalSize: 0, totalSizeFormatted: '0 B' };
    }

    const presetKeys = new Set();
    let totalSize = 0;
    for (const snap of snapshots) {
        if (!snap) continue;
        presetKeys.add(`${snap.apiId || ''}::${snap.presetName || ''}`);
        totalSize += snap.size || 0;
    }

    return {
        snapshotCount: snapshots.length,
        presetCount: presetKeys.size,
        totalSize,
        totalSizeFormatted: formatBytes(totalSize),
    };
}

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
    const all = [];
    for (const list of lists) {
        if (Array.isArray(list) && list.length > 0) all.push(...list);
    }
    return computeStatsFromSnapshots(all);
}

// =====================================================
// 导出/导入（备份/还原用）
// =====================================================
/**
 * 导出所有数据
 */
export async function exportAll() {
    await ensureStore();
    const keys = await _store.keys();
    const data = {};
    const lists = await Promise.all(keys.map(k => _store.getItem(k)));
    for (let i = 0; i < keys.length; i++) {
        if (Array.isArray(lists[i])) data[keys[i]] = lists[i];
    }
    const diagnostics = await _store.getDiagnostics();
    return createHistoryBackup(data, diagnostics);
}

/**
 * 导入数据
 * @param {object} payload exportAll() 的返回值
 * @param {'merge'|'replace'} mode 合并或替换
 */
export function importAll(payload, mode = 'merge') {
    return _historyMutations.run(() => importAllMutation(payload, mode));
}

async function importAllMutation(payload, mode = 'merge') {
    await ensureStore();
    validateHistoryBackup(payload);
    const max = getSettings().maxHistoryPerPreset;
    const existing = await captureHistoryImage(_store);
    const plan = buildHistoryImportPlan(payload, existing, { mode, max });
    const imported = await applyHistoryImportPlan(_store, plan, existing);
    invalidateKeysCache();
    logger.info(`Imported ${imported} verified snapshots (mode: ${mode}, source v${plan.sourceVersion})`);
    return imported;
}

export async function getRepositoryDiagnostics() {
    await ensureStore();
    return _store.getDiagnostics();
}

// =====================================================
// 公开状态
// =====================================================
export function isReady() {
    return _initialized;
}
