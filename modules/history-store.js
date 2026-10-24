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
import { createStorage, normalizePresetFields, sanitizePresetForExport, FIELD_SYNONYMS, EXPORT_EXCLUDED_FIELDS, DISPLAY_IGNORED_FIELDS } from './compatibility.js';
import { comparePresetStates } from './core/preset-comparison.js';
import { hashCanonicalPreset, hashPresetSerialization, requireCanonicalPreset, PRESET_CONTRACT_VERSION } from './core/preset-schema.js';
import { stableStringify as serializeCanonicalValue } from './core/value-utils.js';
import { HistoryRepository } from './core/history-repository.js';
import { readHistoryBucket, readHistoryBuckets } from './core/history-bucket-reader.js';
import { SerialTaskQueue } from './core/serial-task-queue.js';
import { emitHistoryChange } from './core/history-change-events.js';
import { canCoalesceSnapshotTrigger } from './core/snapshot-retention-policy.js';
import { createHistoryCatalog } from './core/history-catalog.js';
import { createHistoryMigrationWorker } from './core/history-migration-worker.js';
import {
    createPreservedHistoryQuotaError,
    isStorageQuotaError,
} from './core/storage-quota.js';
import {
    analyzeHistoryImport,
    applyHistoryImportPlan,
    buildHistoryImportPlan,
    captureHistoryImage,
    createHistoryBackup,
    validateHistoryBackup,
} from './core/history-backup.js';

const STORAGE_NAME = 'PresetAutoSave';
const STORE_NAME = 'history';
const V2_STORE_NAME = 'history_v2';
const CATALOG_STORE_NAME = 'history_catalog';
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
let _catalog = null;
let _catalogBuildPromise = null;
let _catalogBuildAbortController = null;
let _catalogRuntimeVerified = false;
let _migrationWorker = null;
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
        await teardownHistoryStore();
        const legacyStore = createStorage(STORAGE_NAME, STORE_NAME);
        const v2Store = createStorage(STORAGE_NAME, V2_STORE_NAME);
        const catalogStore = createStorage(STORAGE_NAME, CATALOG_STORE_NAME);
        _store = new HistoryRepository({
            legacyStore,
            v2Store,
            onError: (error, context) => logger.warn('History v2 migration deferred:', context, error),
        });
        _catalog = createHistoryCatalog({
            store: catalogStore,
            yieldControl: yieldCatalogWork,
            yieldEvery: 4,
        });
        _migrationWorker = createHistoryMigrationWorker({
            migrateKey: key => _historyMutations.run(() => _store.migrateItem(key)),
            onMigrated: syncCatalogBucketAfterMigration,
            onError: (error, context) => logger.warn('Background history migration deferred:', context, error),
        });
        try {
            await _catalog.load();
        } catch (catalogError) {
            logger.warn('History catalog unavailable; authoritative history remains active:', {
                code: catalogError?.code || catalogError?.name || 'CATALOG_READ_FAILED',
            });
        }
        const sourceManifest = await _store.getCatalogManifest();
        if (_catalog.readState().status === 'ready') {
            if (_catalog.matchesSourceManifest(sourceManifest)) {
                _catalogRuntimeVerified = true;
            } else {
                await _catalog.markDirty('CATALOG_SOURCE_CHANGED');
            }
        }
        _initialized = true;
        const presetCount = sourceManifest.length;
        logger.success(`History repository v2 ready: ${presetCount} preset histories (lazy migration enabled)`);
    } catch (e) {
        logger.error('Failed to init history store:', e);
        _store = null;
        _catalog = null;
        _catalogBuildPromise = null;
        _catalogBuildAbortController?.abort();
        _catalogBuildAbortController = null;
        _catalogRuntimeVerified = false;
        await _migrationWorker?.close();
        _migrationWorker = null;
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
export function stableStringify(obj) {
    return serializeCanonicalValue(obj);
}

/**
 * 计算预设内容哈希（FNV-1a 32-bit）
 *
 * 防御性地再次执行统一字段契约，确保实时快照、原生手动保存载荷、
 * 旧历史记录和直接调用都生成相同哈希。
 */
export function hashPreset(obj, apiId = 'openai') {
    if (!obj || typeof obj !== 'object') return '';
    return hashCanonicalPreset(obj, { apiId });
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
    return comparePresetStates(prev, curr, { apiId }).summary;
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
    const captured = structuredClone(preset);
    return _historyMutations.run(() => addSnapshotMutation(presetName, apiId, captured, trigger));
}

async function addSnapshotMutation(presetName, apiId, preset, trigger = TRIGGER.AUTO) {
    await ensureStore();

    if (!presetName || !apiId) throw new TypeError('Snapshot requires a stable preset target');
    const canonicalPreset = requireCanonicalPreset(preset, { apiId });

    const key = makeKey(apiId, presetName);
    const list = await readHistoryBucket(_store, key);
    const settings = getSettings();
    const now = Date.now();
    const presetStr = stableStringify(canonicalPreset);
    const hash = computeHashFromString(presetStr);
    const size = presetStr.length;

    // 1. 去重: 与最新一条相同则跳过
    //   manual trigger 不受 skipUnchangedSave 限制 —— 用户明确要求"立即快照"时
    //   不应该被静默跳过（resetLastSavedHash 已重置内部 hash，但 store 层也应放行）
    // Persisted hashes are legacy metadata, not proof of canonical equality.
    const previousPreset = list[0]?.preset;
    const previousCanonicalContent = previousPreset && typeof previousPreset === 'object'
        ? stableStringify(sanitizePresetForExport(previousPreset, { apiId }))
        : null;
    if (
        settings.skipUnchangedSave
        && trigger !== TRIGGER.MANUAL
        && trigger !== TRIGGER.RESTORE
        && list.length > 0
        && previousCanonicalContent === presetStr
    ) {
        logger.debug(`Snapshot skipped (unchanged): ${presetName}`);
        return null;
    }

    // 计算修改摘要（对比上一条快照）
    const previousSnapshot = list.length > 0 ? list[0] : null;
    const summary = computeChangeSummary(previousSnapshot?.preset, canonicalPreset, apiId);

    // 2. 合并窗口: 仅合并高频自动观察；显式恢复点永不被覆盖
    //    manual / switch_guard / restore 均保留独立 ID 和原始内容。
    //    锁定（pinned）的快照永远不会被合并覆盖。
    const mergeWindowMs = settings.mergeWindowSec * 1000;
    if (
        canCoalesceSnapshotTrigger(trigger)
        && mergeWindowMs > 0
        && list.length > 0
        && list[0].trigger === trigger
        && !list[0].pinned
    ) {
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
                canonicalHash: hash,
                contractVersion: PRESET_CONTRACT_VERSION,
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
        canonicalHash: hash,
        contractVersion: PRESET_CONTRACT_VERSION,
        size,
        summary,
        name: '',          // 用户自定义名（"跑通了！"等），默认空
        pinned: false,     // 是否锁定（锁定的快照永不被自动清理/合并）
    };

    const previousIds = new Set(list.map(item => item?.id).filter(Boolean));
    list.unshift(snapshot);

    // 4. 按上限裁剪（保留所有 pinned + 最新的非 pinned 直到上限）
    const max = settings.maxHistoryPerPreset;
    trimListWithPinned(list, max);
    const retainedIds = new Set(list.map(item => item?.id).filter(Boolean));
    const removedIds = [...previousIds].filter(id => !retainedIds.has(id));

    await safeSetItem(key, list);
    const desc = describeSummaryForLog(summary);
    logger.debug(`Snapshot added: ${presetName} (total: ${list.length}/${max}) ${desc}`);
    emitHistoryChange({ type: 'snapshot-added', snapshot, removedIds });
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
    return hashPresetSerialization(str);
}

/**
 * 安全写入。配额不足时保持仓库原样并把清理选择交还给用户。
 */
async function safeSetItem(key, value) {
    try {
        await _store.setItem(key, value);
        invalidateKeysCache();
        await syncCatalogBucketAfterCommit(key, value);
    } catch (e) {
        if (!isStorageQuotaError(e)) throw e;
        logger.error('Storage quota exceeded; write rejected without deleting existing history');
        throw createPreservedHistoryQuotaError(e);
    }
}

export async function teardownHistoryStore() {
    const worker = _migrationWorker;
    const build = _catalogBuildPromise;
    _initialized = false;
    _migrationWorker = null;
    _catalogBuildAbortController?.abort();

    await Promise.allSettled([
        worker?.close(),
        build,
    ].filter(Boolean));

    if (_catalogBuildPromise === build) _catalogBuildPromise = null;
    _catalogBuildAbortController = null;
    _catalogRuntimeVerified = false;
    _store = null;
    _catalog = null;
    _keysCache = null;
    _keysCacheTime = 0;
}

async function syncCatalogBucketAfterCommit(key, snapshots) {
    if (!_catalog) return;
    const target = parseKey(key);
    if (!target) {
        _catalogRuntimeVerified = false;
        await _catalog.markDirty('CATALOG_TARGET_INVALID');
        return;
    }
    try {
        if (Array.isArray(snapshots) && snapshots.length > 0) {
            await _catalog.replaceBucket(target.apiId, target.presetName, snapshots, { includeSummaries: false });
        } else {
            await _catalog.removeBucket(target.apiId, target.presetName, { includeSummaries: false });
        }
        _catalogRuntimeVerified = _catalog.readState().status === 'ready';
    } catch (error) {
        _catalogRuntimeVerified = false;
        logger.warn('History catalog sync failed after authoritative commit', {
            operation: Array.isArray(snapshots) && snapshots.length > 0 ? 'replace-bucket' : 'remove-bucket',
            count: Array.isArray(snapshots) ? snapshots.length : 0,
            code: error?.code || error?.name || 'CATALOG_WRITE_FAILED',
        });
        await _catalog.markDirty('CATALOG_SYNC_FAILED');
    }
}

async function syncCatalogBucketAfterMigration(key, snapshots) {
    if (!_catalog) return;
    const target = parseKey(key);
    if (!target || snapshots.length === 0) {
        _catalogRuntimeVerified = false;
        await _catalog.markDirty('CATALOG_MIGRATION_REBUILD_REQUIRED');
        return;
    }
    try {
        await _catalog.replaceBucket(target.apiId, target.presetName, snapshots, { includeSummaries: false });
    } catch (error) {
        _catalogRuntimeVerified = false;
        await _catalog.markDirty('CATALOG_MIGRATION_SYNC_FAILED');
        throw error;
    }
}

async function markCatalogDirtyAfterCommit(reason) {
    if (!_catalog) return;
    _catalogRuntimeVerified = false;
    await _catalog.markDirty(reason);
}

function yieldCatalogWork() {
    if (typeof globalThis.scheduler?.yield === 'function') {
        return globalThis.scheduler.yield();
    }
    return new Promise(resolve => setTimeout(resolve, 0));
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
    return readHistoryBucket(_store, key);
}

export function getHistoryCatalogState() {
    if (!_catalog) {
        return {
            status: 'missing',
            summaries: [],
            progress: { completed: 0, total: 0 },
            generation: 0,
            errorCode: '',
        };
    }
    return _catalog.read();
}

export function ensureHistoryCatalog({ onProgress = () => {}, signal } = {}) {
    if (!_initialized || !_store || !_catalog) {
        return Promise.reject(new Error('HistoryStore not initialized'));
    }
    if (_catalogBuildPromise) return _catalogBuildPromise;

    const store = _store;
    const catalog = _catalog;
    const migrationWorker = _migrationWorker;
    const internalAbortController = new AbortController();
    _catalogBuildAbortController = internalAbortController;
    const buildSignal = combineAbortSignals(signal, internalAbortController.signal);
    const operation = _historyMutations.run(async () => {
        const current = catalog.readState();
        if (_catalogRuntimeVerified && current.status === 'ready') return catalog.read();

        const sourceManifest = await store.getCatalogManifest();
        if (catalog.matchesSourceManifest(sourceManifest)) {
            _catalogRuntimeVerified = true;
            return catalog.read();
        }
        if (current.status === 'ready') {
            await catalog.markDirty('CATALOG_SOURCE_CHANGED');
        }
        const ready = await catalog.rebuild({
            keys: sourceManifest.map(entry => entry.key),
            signal: buildSignal,
            onProgress,
            readBucket: async key => (await store.getCatalogBucket(key)) ?? [],
        });
        _catalogRuntimeVerified = true;
        migrationWorker?.enqueue(
            sourceManifest
                .filter(entry => entry.revision === 'legacy')
                .map(entry => entry.key),
        );
        return ready;
    });
    _catalogBuildPromise = operation;
    operation.finally(() => {
        if (_catalogBuildPromise === operation) _catalogBuildPromise = null;
        if (_catalogBuildAbortController === internalAbortController) {
            _catalogBuildAbortController = null;
        }
    }).catch(() => {});
    return operation;
}

function combineAbortSignals(externalSignal, internalSignal) {
    if (!externalSignal) return internalSignal;
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([externalSignal, internalSignal]);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal.aborted || internalSignal.aborted) abort();
    else {
        externalSignal.addEventListener('abort', abort, { once: true });
        internalSignal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

export async function getSnapshotSummaries({ onProgress, signal } = {}) {
    await ensureStore();
    const ready = await ensureHistoryCatalog({ onProgress, signal });
    return ready.summaries;
}

/**
 * 获取所有快照（跨预设、跨API，按时间倒序）
 */
export async function getAllSnapshots() {
    await ensureStore();
    const keys = await getKeys();
    if (!keys || keys.length === 0) return [];

    // 性能优化：并行 getItem，IndexedDB 内部能 batch IO
    const lists = await readHistoryBuckets(_store, keys);
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
    const catalogMatch = _catalog?.findSummary(snapshotId);
    const catalogKey = catalogMatch
        ? makeKey(catalogMatch.apiId, catalogMatch.presetName)
        : null;

    if (catalogKey) {
        const targetSnapshots = await readHistoryBucket(_store, catalogKey);
        const found = targetSnapshots.find(snapshot => snapshot.id === snapshotId);
        if (found) return found;
    }

    const keys = (await getKeys()).filter(key => key !== catalogKey);
    if (!keys || keys.length === 0) return null;

    // 性能优化：并行查询，更快返回
    // A missing or stale derived catalog must never hide authoritative data.
    const lists = await readHistoryBuckets(_store, keys);
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

    const lists = await readHistoryBuckets(_store, keys);
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
        const list = await readHistoryBucket(_store, key);
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
            await syncCatalogBucketAfterCommit(key, list);
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
        const list = await readHistoryBucket(_store, key);
        const snap = list.find(s => s.id === snapshotId);
        if (snap) {
            if ((snap.name || '') === trimmed) return true;
            snap.name = trimmed;
            await _store.setItem(key, list);
            invalidateKeysCache();
            await syncCatalogBucketAfterCommit(key, list);
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
        const list = await readHistoryBucket(_store, key);
        const snap = list.find(s => s.id === snapshotId);
        if (snap) {
            const newVal = (typeof pinned === 'boolean') ? pinned : !snap.pinned;
            if (snap.pinned === newVal) return newVal;
            snap.pinned = newVal;
            await _store.setItem(key, list);
            invalidateKeysCache();
            await syncCatalogBucketAfterCommit(key, list);
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
    await syncCatalogBucketAfterCommit(key, []);
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
    const list = await readHistoryBucket(_store, key);
    if (list.length === 0) {
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
    await syncCatalogBucketAfterCommit(key, kept);
    emitHistoryChange({
        type: 'history-pruned',
        apiId,
        presetName,
        deleted,
        kept: kept.length,
    });
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
    await markCatalogDirtyAfterCommit('CATALOG_CLEAR_ALL');
    logger.info('All history cleared');
}

/**
 * Inspect suspect snapshots without deleting unverified recovery data.
 * @returns {Promise<{cleaned: number, scanned: number, quarantined: number}>}
 */
export function cleanCorruptSnapshots() {
    return _historyMutations.run(cleanCorruptSnapshotsMutation);
}

async function cleanCorruptSnapshotsMutation() {
    await ensureStore();
    const keys = await getKeys(true);
    const cleaned = 0;
    let scanned = 0;
    let quarantined = 0;

    // 性能优化：并行读取，但写入仍按顺序避免并发冲突
    const lists = await readHistoryBuckets(_store, keys);
    for (let i = 0; i < keys.length; i++) {
        const list = lists[i] || [];
        scanned += list.length;
        for (const snapshot of list) {
            try { requireCanonicalPreset(snapshot?.preset, { apiId: snapshot?.apiId }); }
            catch (_) { quarantined++; }
        }
    }

    invalidateKeysCache();
    logger.info(`History inspection: ${quarantined} records need review out of ${scanned}; all recovery data preserved`);
    return { cleaned, scanned, quarantined };
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
    const lists = await readHistoryBuckets(_store, keys);
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
    if (trimmed > 0) await markCatalogDirtyAfterCommit('CATALOG_TRIM_COUNT');
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
    const lists = await readHistoryBuckets(_store, keys);
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
    if (trimmed > 0) await markCatalogDirtyAfterCommit('CATALOG_TRIM_AGE');
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
    const lists = await readHistoryBuckets(_store, keys);
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
    const lists = await readHistoryBuckets(_store, keys);
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

/**
 * Validate and explain an import against the current repository without
 * mutating it. The apply path rebuilds the plan so changes made while the user
 * reads the preview are still handled by the normal verified transaction.
 */
export function previewImportAll(payload) {
    return _historyMutations.run(async () => {
        await ensureStore();
        const max = getSettings().maxHistoryPerPreset;
        const existing = await captureHistoryImage(_store);
        return analyzeHistoryImport(payload, existing, { max });
    });
}

async function importAllMutation(payload, mode = 'merge') {
    await ensureStore();
    validateHistoryBackup(payload);
    const max = getSettings().maxHistoryPerPreset;
    const existing = await captureHistoryImage(_store);
    const plan = buildHistoryImportPlan(payload, existing, { mode, max });
    const imported = await applyHistoryImportPlan(_store, plan, existing);
    invalidateKeysCache();
    await markCatalogDirtyAfterCommit('CATALOG_IMPORT');
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
