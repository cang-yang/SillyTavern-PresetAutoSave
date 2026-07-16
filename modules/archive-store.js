/**
 * SillyTavern Preset Auto Save - Archive Store
 * 接管归档存储模块
 *
 * 职责：
 *   1. 当用户启用"数据级接管"时，把"被合并的非代表预设"完整数据备份到这里
 *   2. 提供按 (apiId, presetName) 查询、列表、批量恢复的能力
 *   3. 当用户关闭接管 / 卸载插件时，把所有归档数据写回 ST PresetManager
 *
 * 与 history-store 的区别：
 *   - history-store 存的是 [apiId, presetName] → [snapshot[]]（修改历史）
 *   - 这里存的是 [apiId, presetName] → archiveEntry（原始数据 + 元数据）
 *   - 独立的 IndexedDB store，避免互相影响
 *
 * 数据结构：
 *   key:    `${apiId}::${presetName}`
 *   value:  {
 *     apiId: string,
 *     presetName: string,
 *     seriesKey: string,        // 该预设被归到哪个系列
 *     data: object,             // ST PresetManager.getPresetSettings 的返回值
 *     archivedAt: number,       // 归档时间戳
 *     reason: string,           // 归档原因（'takeover-merge' / 'manual'）
 *   }
 */

import { logger } from './logger.js';
import { createStorage } from './compatibility.js';

const ARCHIVE_DB = 'pas_archive';
const ARCHIVE_STORE = 'archived_presets';
const SUMMARY_PREFIX = '__archive_summary__::';

let _store = null;
let _initialized = false;
let _summaryCache = null;

// =====================================================
// 初始化
// =====================================================
export async function initArchiveStore() {
    if (_initialized) return _store;
    try {
        _store = createStorage(ARCHIVE_DB, ARCHIVE_STORE);
        _initialized = true;
        const count = await getArchiveCount();
        logger.info(`Archive store ready (${count} archived presets)`);
    } catch (e) {
        logger.error('Failed to init archive store:', e);
        _store = null;
        _summaryCache = null;
        _initialized = false;
    }
    return _store;
}

function makeKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

function summaryKey(key) {
    return `${SUMMARY_PREFIX}${encodeURIComponent(key)}`;
}

function isArchiveDataKey(key) {
    return typeof key === 'string' && !key.startsWith(SUMMARY_PREFIX);
}

async function ensureStore() {
    if (!_initialized) await initArchiveStore();
    return _store;
}

function projectArchiveSummary(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.apiId !== 'string' || !entry.apiId) return null;
    if (typeof entry.presetName !== 'string' || !entry.presetName) return null;
    return {
        apiId: entry.apiId,
        presetName: entry.presetName,
        seriesKey: typeof entry.seriesKey === 'string' && entry.seriesKey
            ? entry.seriesKey
            : entry.presetName,
        archivedAt: Number.isFinite(Number(entry.archivedAt)) ? Number(entry.archivedAt) : 0,
        reason: typeof entry.reason === 'string' ? entry.reason : '',
    };
}

function invalidateArchiveSummaryCache() {
    _summaryCache = null;
}

function cacheMatchesKeys(keys) {
    return _summaryCache
        && _summaryCache.keys.length === keys.length
        && _summaryCache.keys.every((key, index) => key === keys[index]);
}

// =====================================================
// 写入：归档一个预设
// =====================================================
/**
 * @param {string} apiId
 * @param {string} presetName
 * @param {object} data 完整预设数据（来自 PresetManager.getPresetSettings）
 * @param {string} seriesKey
 * @param {string} reason 'takeover-merge' | 'manual' | ...
 */
export async function archivePreset(apiId, presetName, data, seriesKey, reason = 'takeover-merge') {
    const store = await ensureStore();
    if (!store) return false;

    const entry = {
        apiId,
        presetName,
        seriesKey: seriesKey || presetName,
        data,
        archivedAt: Date.now(),
        reason,
    };

    try {
        const key = makeKey(apiId, presetName);
        await store.setItem(key, entry);
        try {
            await store.setItem(summaryKey(key), projectArchiveSummary(entry));
        } catch (summaryError) {
            logger.warn('Archive summary write deferred:', {
                apiId,
                presetName,
                code: summaryError?.code || summaryError?.name || 'ARCHIVE_SUMMARY_WRITE_FAILED',
            });
        }
        invalidateArchiveSummaryCache();
        logger.debug(`[Archive] saved ${apiId}::${presetName} (series: ${seriesKey})`);
        return true;
    } catch (e) {
        logger.error(`Archive failed for ${presetName}:`, e);
        return false;
    }
}

// =====================================================
// 读取：单条 / 全部
// =====================================================
export async function getArchivedPreset(apiId, presetName) {
    const store = await ensureStore();
    if (!store) return null;
    try {
        return await store.getItem(makeKey(apiId, presetName));
    } catch (e) {
        return null;
    }
}

export async function listArchivedPresets({ strict = false } = {}) {
    const store = await ensureStore();
    if (!store) {
        if (strict) throw new Error('Archive store is unavailable');
        return [];
    }
    try {
        const keys = (await store.keys()).filter(isArchiveDataKey);
        if (!keys || keys.length === 0) return [];
        const items = await Promise.all(keys.map(k => store.getItem(k).catch(() => null)));
        return items.filter(x => x && x.apiId && x.presetName);
    } catch (e) {
        logger.warn('listArchivedPresets failed:', e);
        if (strict) throw e;
        return [];
    }
}

export async function listArchivedPresetSummaries({ strict = false } = {}) {
    const store = await ensureStore();
    if (!store) {
        if (strict) throw new Error('Archive store is unavailable');
        return [];
    }
    try {
        const keys = [...await store.keys()].filter(isArchiveDataKey).sort();
        if (!keys || keys.length === 0) return [];
        if (cacheMatchesKeys(keys)) return structuredClone(_summaryCache.entries);

        const storedSummaries = await Promise.all(keys.map(key => store.getItem(summaryKey(key))));
        const entries = [];
        for (let index = 0; index < keys.length; index++) {
            let summary = projectArchiveSummary(storedSummaries[index]);
            if (!summary) {
                const authoritative = await store.getItem(keys[index]);
                summary = projectArchiveSummary(authoritative);
                if (summary) {
                    try { await store.setItem(summaryKey(keys[index]), summary); } catch (_) {}
                }
            }
            entries.push(summary);
        }
        if (entries.some(entry => entry === null)) {
            throw new Error('Archive catalog encountered malformed authoritative data');
        }
        _summaryCache = {
            keys: [...keys],
            entries: structuredClone(entries),
        };
        return structuredClone(entries);
    } catch (e) {
        logger.warn('listArchivedPresetSummaries failed:', e);
        if (strict) throw e;
        return [];
    }
}

/**
 * 按 apiId 列出所有归档预设
 */
export async function listArchivedByApi(apiId) {
    const all = await listArchivedPresets();
    return all.filter(x => x.apiId === apiId);
}

/**
 * 按系列列出所有归档预设
 */
export async function listArchivedBySeries(seriesKey) {
    const all = await listArchivedPresets();
    return all.filter(x => x.seriesKey === seriesKey);
}

// =====================================================
// 删除：单条 / 全部
// =====================================================
export async function removeArchivedPreset(apiId, presetName) {
    const store = await ensureStore();
    if (!store) return false;
    try {
        const key = makeKey(apiId, presetName);
        await store.removeItem(key);
        try { await store.removeItem(summaryKey(key)); } catch (_) {}
        invalidateArchiveSummaryCache();
        return true;
    } catch (e) {
        return false;
    }
}

export async function clearAllArchived() {
    const store = await ensureStore();
    if (!store) return false;
    try {
        await store.clear();
        invalidateArchiveSummaryCache();
        logger.info('[Archive] cleared all archived presets');
        return true;
    } catch (e) {
        return false;
    }
}

// =====================================================
// 统计
// =====================================================
export async function getArchiveCount() {
    const store = await ensureStore();
    if (!store) return 0;
    try {
        const keys = await store.keys();
        return (keys || []).filter(isArchiveDataKey).length;
    } catch (e) {
        return 0;
    }
}

export async function getArchiveStats() {
    const all = await listArchivedPresets();
    const byApi = {};
    const bySeries = {};
    let totalSize = 0;
    let oldestAt = 0;
    let newestAt = 0;
    for (const e of all) {
        byApi[e.apiId] = (byApi[e.apiId] || 0) + 1;
        bySeries[e.seriesKey] = (bySeries[e.seriesKey] || 0) + 1;
        const archivedAt = Number(e.archivedAt);
        if (Number.isFinite(archivedAt) && archivedAt > 0) {
            oldestAt = oldestAt === 0 ? archivedAt : Math.min(oldestAt, archivedAt);
            newestAt = Math.max(newestAt, archivedAt);
        }
        try {
            totalSize += JSON.stringify(e.data || {}).length;
        } catch (_) {}
    }
    return {
        total: all.length,
        byApi,
        bySeries,
        totalSize,
        oldestAt,
        newestAt,
    };
}
