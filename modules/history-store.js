/**
 * 历史存储模块
 *
 * 存储结构:
 *   key: pas_history_<presetName>
 *   value: [
 *     { id, presetName, apiId, timestamp, trigger, preset, size }
 *   ]
 */

import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { ENV } from './compatibility.js';

const STORE_KEY_PREFIX = 'pas_history_';

let _store = null;

/**
 * 初始化存储 (优先 localforage, 降级到 localStorage)
 */
export async function initHistoryStore() {
    if (ENV.hasLocalforage) {
        _store = SillyTavern.libs.localforage.createInstance({
            name: 'PresetAutoSave',
            storeName: 'history',
        });
        logger.debug('Using localforage as backend');
    } else {
        logger.warn('localforage unavailable, fallback to localStorage');
        _store = createLocalStorageAdapter();
    }
}

/**
 * 添加快照
 * @param {string} presetName 预设名
 * @param {string} apiId API类型
 * @param {object} preset 预设完整数据
 * @param {string} trigger 触发类型: 'auto' | 'switch_guard'
 */
export async function addSnapshot(presetName, apiId, preset, trigger = 'auto') {
    const snapshot = {
        id: generateId(),
        presetName,
        apiId,
        timestamp: Date.now(),
        trigger,
        preset: structuredClone(preset),
        size: JSON.stringify(preset).length,
    };

    const key = STORE_KEY_PREFIX + presetName;
    const list = (await _store.getItem(key)) || [];
    list.unshift(snapshot);

    // 自动清理超额
    const max = getSettings().maxHistoryPerPreset;
    if (list.length > max) {
        list.length = max;
    }

    await _store.setItem(key, list);
    logger.debug('Snapshot added:', snapshot.id);
    return snapshot;
}

/**
 * 获取某预设的所有快照
 */
export async function getSnapshots(presetName) {
    const key = STORE_KEY_PREFIX + presetName;
    return (await _store.getItem(key)) || [];
}

/**
 * 获取所有预设的快照列表
 */
export async function getAllSnapshots() {
    const keys = await _store.keys();
    const result = [];
    for (const key of keys) {
        if (key.startsWith(STORE_KEY_PREFIX)) {
            const list = await _store.getItem(key);
            if (list) result.push(...list);
        }
    }
    return result.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 删除快照
 */
export async function deleteSnapshot(snapshotId) {
    const keys = await _store.keys();
    for (const key of keys) {
        if (!key.startsWith(STORE_KEY_PREFIX)) continue;
        const list = (await _store.getItem(key)) || [];
        const filtered = list.filter(s => s.id !== snapshotId);
        if (filtered.length !== list.length) {
            await _store.setItem(key, filtered);
            return true;
        }
    }
    return false;
}

/**
 * 根据ID获取快照
 */
export async function getSnapshotById(snapshotId) {
    const all = await getAllSnapshots();
    return all.find(s => s.id === snapshotId) || null;
}

/**
 * 计算总存储大小
 */
export async function getTotalSize() {
    const all = await getAllSnapshots();
    return all.reduce((sum, s) => sum + (s.size || 0), 0);
}

/**
 * 清理所有历史
 */
export async function clearAll() {
    const keys = await _store.keys();
    for (const key of keys) {
        if (key.startsWith(STORE_KEY_PREFIX)) {
            await _store.removeItem(key);
        }
    }
}

// ----- 工具函数 -----

function generateId() {
    return 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}

function createLocalStorageAdapter() {
    return {
        async getItem(key) {
            const v = localStorage.getItem(key);
            return v ? JSON.parse(v) : null;
        },
        async setItem(key, val) {
            localStorage.setItem(key, JSON.stringify(val));
        },
        async removeItem(key) {
            localStorage.removeItem(key);
        },
        async keys() {
            return Object.keys(localStorage);
        },
    };
}
