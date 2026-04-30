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

let _store = null;
let _initialized = false;

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
        _initialized = false;
    }
    return _store;
}

function makeKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

function parseKey(key) {
    const idx = key.indexOf('::');
    if (idx < 0) return null;
    return { apiId: key.slice(0, idx), presetName: key.slice(idx + 2) };
}

async function ensureStore() {
    if (!_initialized) await initArchiveStore();
    return _store;
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
        await store.setItem(makeKey(apiId, presetName), entry);
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

export async function listArchivedPresets() {
    const store = await ensureStore();
    if (!store) return [];
    try {
        const keys = await store.keys();
        if (!keys || keys.length === 0) return [];
        const items = await Promise.all(keys.map(k => store.getItem(k).catch(() => null)));
        return items.filter(x => x && x.apiId && x.presetName);
    } catch (e) {
        logger.warn('listArchivedPresets failed:', e);
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
        await store.removeItem(makeKey(apiId, presetName));
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
        return (keys || []).length;
    } catch (e) {
        return 0;
    }
}

export async function getArchiveStats() {
    const all = await listArchivedPresets();
    const byApi = {};
    const bySeries = {};
    let totalSize = 0;
    for (const e of all) {
        byApi[e.apiId] = (byApi[e.apiId] || 0) + 1;
        bySeries[e.seriesKey] = (bySeries[e.seriesKey] || 0) + 1;
        try {
            totalSize += JSON.stringify(e.data || {}).length;
        } catch (_) {}
    }
    return {
        total: all.length,
        byApi,
        bySeries,
        totalSize,
        oldestAt: all.reduce((m, e) => Math.min(m, e.archivedAt || Infinity), Infinity),
        newestAt: all.reduce((m, e) => Math.max(m, e.archivedAt || 0), 0),
    };
}
