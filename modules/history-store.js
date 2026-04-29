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

    // 2. 合并窗口: 在窗口期内且触发类型相同 -> 替换最新
    const mergeWindowMs = settings.mergeWindowSec * 1000;
    if (mergeWindowMs > 0 && list.length > 0 && list[0].trigger === trigger) {
        const elapsed = now - list[0].timestamp;
        if (elapsed < mergeWindowMs) {
            const merged = {
                ...list[0],
                timestamp: now,
                preset: structuredClone(preset),
                hash,
                size,
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
    };

    list.unshift(snapshot);

    // 4. 按上限裁剪
    const max = settings.maxHistoryPerPreset;
    if (list.length > max) {
        list.length = max;
    }

    await safeSetItem(key, list);
    logger.debug(`Snapshot added: ${presetName} (total: ${list.length}/${max})`);
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