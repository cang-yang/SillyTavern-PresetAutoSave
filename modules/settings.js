/**
 * SillyTavern Preset Auto Save - Settings
 * 配置管理模块
 *
 * 职责:
 *   1. 持有默认配置
 *   2. 与 extensionSettings 同步
 *   3. 提供字段校验
 *   4. 提供变更订阅机制
 */

import { logger } from './logger.js';

const MODULE_NAME = 'preset_auto_save';

// =====================================================
// 默认配置
// =====================================================
export const DEFAULT_SETTINGS = Object.freeze({
    // 总开关
    enabled: true,

    // 自动保存
    debounceMs: 800,                // 通用防抖延迟（ms）
    textInputDebounce: 1500,        // 文本框防抖延迟（ms）
    sliderReleaseSave: true,        // 滑块仅在松开时保存
    skipUnchangedSave: true,        // 内容未变化时跳过保存

    // 历史记录
    maxHistoryPerPreset: 50,        // 每预设最多保留条数
    cleanupSizeMB: 50,              // 总存储阈值（MB）
    mergeWindowSec: 30,             // 合并窗口（秒，30秒内的修改合并为一条）

    // 切换保护
    enableSwitchGuard: true,        // 切换预设前自动备份

    // UI
    showStatusIndicator: true,      // 显示状态指示器（小圆点）
    notifyOnSave: false,            // 每次保存显示Toast

    // 预设分组（系列识别）
    groupingEnabled: true,          // 是否启用预设系列分组（三级面板）
    groupingFirstScanDone: false,   // 首次扫描向导是否已完成
    groupingPromptOnImport: true,   // 检测到新预设导入时是否提示归属确认
    groupingManualOverrides: {},    // { [presetName]: seriesName } 用户手动覆盖
    groupingExcluded: {},           // { [presetName]: true } 用户标记为"不分组"
    groupingDefaultExpand: 'current', // 'current' | 'all' | 'none' 系列默认展开策略

    // 预设接管（核心特性：用一级系列名替换原生预设下拉）
    takeoverEnabled: true,          // 是否启用接管（关闭后原生下拉恢复原状）
    takeoverMode: 'dom',            // 'dom' | 'data' DOM 接管（轻量）/ 数据接管（一劳永逸）
    takeoverDefaultStrategy: 'latest', // 'latest' | 'manual' 选中代表版本的默认策略
    seriesDefaultApply: {},         // { [seriesKey]: presetName } 用户为每个系列指定的"默认应用版本"
    takeoverHideMode: 'hide',       // 'hide' | 'collapse' 非代表 option 的处理方式（保留扩展）
    takeoverDataConfirmed: false,   // 用户是否已经接受过"数据接管"模式的危险提示

    // 种子快照：开启分组/接管时为现有预设自动建立 1 条初始快照
    autoSeedOnTakeover: true,       // 是否自动种子（首次接管/检测到新预设时）
    seedSnapshotsDone: false,       // 全量 seed 是否已完成（避免每次启动都跑）

    // 高级
    debugMode: false,               // 启用详细日志
    fallbackPolling: false,         // 兜底轮询（默认关闭，仅当事件触发不可靠时启用）
});

// =====================================================
// 配置项校验规则
// =====================================================
const VALIDATORS = {
    enabled: (v) => Boolean(v),
    debounceMs: (v) => clamp(toInt(v, 800), 100, 10000),
    textInputDebounce: (v) => clamp(toInt(v, 1500), 100, 10000),
    sliderReleaseSave: (v) => Boolean(v),
    skipUnchangedSave: (v) => Boolean(v),
    maxHistoryPerPreset: (v) => clamp(toInt(v, 50), 5, 500),
    cleanupSizeMB: (v) => clamp(toInt(v, 50), 10, 1000),
    mergeWindowSec: (v) => clamp(toInt(v, 30), 0, 600),
    enableSwitchGuard: (v) => Boolean(v),
    showStatusIndicator: (v) => Boolean(v),
    notifyOnSave: (v) => Boolean(v),
    groupingEnabled: (v) => Boolean(v),
    groupingFirstScanDone: (v) => Boolean(v),
    groupingPromptOnImport: (v) => Boolean(v),
    groupingManualOverrides: (v) => sanitizeStringMap(v),
    groupingExcluded: (v) => sanitizeBoolMap(v),
    groupingDefaultExpand: (v) => (v === 'all' || v === 'none' || v === 'current') ? v : 'current',
    takeoverEnabled: (v) => Boolean(v),
    takeoverMode: (v) => (v === 'data' ? 'data' : 'dom'),
    takeoverDefaultStrategy: (v) => (v === 'manual' ? 'manual' : 'latest'),
    seriesDefaultApply: (v) => sanitizeStringMap(v),
    takeoverHideMode: (v) => (v === 'collapse' ? 'collapse' : 'hide'),
    takeoverDataConfirmed: (v) => Boolean(v),
    autoSeedOnTakeover: (v) => Boolean(v),
    seedSnapshotsDone: (v) => Boolean(v),
    debugMode: (v) => Boolean(v),
    fallbackPolling: (v) => Boolean(v),
};

/**
 * 仅保留"非空字符串 → 非空字符串"的键值对
 * （防御 extensionSettings 被外部脏数据污染）
 */
function sanitizeStringMap(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (typeof k !== 'string' || !k) continue;
        if (typeof val !== 'string' || !val) continue;
        if (k.length > 200 || val.length > 200) continue;  // 防御过长
        out[k] = val;
    }
    return out;
}

function sanitizeBoolMap(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (typeof k !== 'string' || !k || k.length > 200) continue;
        if (val) out[k] = true;
    }
    return out;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function toInt(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

// =====================================================
// 状态
// =====================================================
let _settings = null;
const _listeners = new Set();
let _initialized = false;

// =====================================================
// 初始化
// =====================================================
/**
 * 初始化配置（从 extensionSettings 读取）
 */
export async function initSettings() {
    try {
        const ctx = SillyTavern.getContext();
        const allSettings = ctx.extensionSettings;

        if (!allSettings) {
            logger.error('extensionSettings unavailable');
            _settings = structuredClone(DEFAULT_SETTINGS);
            _initialized = true;
            return;
        }

        // 不存在则创建
        if (!allSettings[MODULE_NAME] || typeof allSettings[MODULE_NAME] !== 'object') {
            allSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
            logger.info('Created default settings');
        }

        // 补全缺失字段（适应版本更新）
        let migrated = false;
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (!Object.hasOwn(allSettings[MODULE_NAME], key)) {
                const dv = DEFAULT_SETTINGS[key];
                // 对象/数组要深拷贝，避免所有用户共享同一个引用
                allSettings[MODULE_NAME][key] = (dv && typeof dv === 'object')
                    ? structuredClone(dv)
                    : dv;
                migrated = true;
            }
        }

        // 移除已废弃字段
        for (const key of Object.keys(allSettings[MODULE_NAME])) {
            if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
                delete allSettings[MODULE_NAME][key];
                migrated = true;
            }
        }

        // 验证所有字段
        for (const [key, value] of Object.entries(allSettings[MODULE_NAME])) {
            const validator = VALIDATORS[key];
            if (validator) {
                const validated = validator(value);
                if (validated !== value) {
                    allSettings[MODULE_NAME][key] = validated;
                    migrated = true;
                }
            }
        }

        if (migrated) {
            logger.info('Settings migrated/validated');
            persistSettings();
        }

        _settings = allSettings[MODULE_NAME];
        _initialized = true;

        // 应用 debugMode 到 logger
        logger.setDebugMode(_settings.debugMode);

        logger.success('Settings loaded');
        logger.debug('Current settings:', _settings);
    } catch (e) {
        logger.error('Failed to load settings:', e);
        _settings = structuredClone(DEFAULT_SETTINGS);
        _initialized = true;
    }
}

// =====================================================
// 读取
// =====================================================
/**
 * 获取整个配置对象
 * 注意：未初始化时返回的是 DEFAULT_SETTINGS 的浅拷贝，避免被外部冻结。
 */
export function getSettings() {
    if (!_initialized) {
        logger.warn('getSettings called before init');
        // 返回浅拷贝，防止调用方意外修改 frozen 对象抛错
        return { ...DEFAULT_SETTINGS };
    }
    return _settings;
}

/**
 * 获取单个配置项
 */
export function getSetting(key) {
    if (!_initialized) return DEFAULT_SETTINGS[key];
    return _settings[key];
}

/**
 * 获取默认值
 */
export function getDefault(key) {
    return DEFAULT_SETTINGS[key];
}

// =====================================================
// 写入
// =====================================================
/**
 * 更新单个配置项
 * @returns {boolean} 是否实际发生了变化
 */
export function updateSetting(key, value) {
    if (!_initialized) {
        logger.warn('updateSetting called before init');
        return false;
    }

    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
        logger.warn('Unknown setting key:', key);
        return false;
    }

    // 验证
    const validator = VALIDATORS[key];
    const validated = validator ? validator(value) : value;

    const oldValue = _settings[key];
    if (oldValue === validated) return false;

    _settings[key] = validated;

    // 特殊处理: debugMode 改变时立即应用
    if (key === 'debugMode') {
        logger.setDebugMode(validated);
    }

    persistSettings();
    notifyListeners(key, validated, oldValue);

    logger.debug(`Setting changed: ${key} =`, validated);
    return true;
}

/**
 * 批量更新（只调用一次 persist，比逐个 updateSetting 高效）
 * @param {object} updates 键值对
 * @returns {string[]} 实际发生变化的key列表
 */
export function batchUpdate(updates) {
    if (!_initialized) {
        logger.warn('batchUpdate called before init');
        return [];
    }
    const changed = [];
    const notifications = [];

    for (const [key, value] of Object.entries(updates)) {
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
        const validator = VALIDATORS[key];
        const validated = validator ? validator(value) : value;
        const oldValue = _settings[key];
        if (oldValue === validated) continue;

        _settings[key] = validated;
        if (key === 'debugMode') logger.setDebugMode(validated);

        changed.push(key);
        notifications.push({ key, newValue: validated, oldValue });
    }

    if (changed.length > 0) {
        // 一次性写入磁盘
        persistSettings();
        // 然后通知所有订阅者
        for (const n of notifications) {
            notifyListeners(n.key, n.newValue, n.oldValue);
        }
        logger.debug(`batchUpdate: ${changed.length} setting(s) changed (${changed.join(', ')})`);
    }
    return changed;
}

/**
 * 重置为默认值
 */
export function resetSettings() {
    if (!_initialized) return;

    const oldSettings = { ..._settings };
    Object.assign(_settings, DEFAULT_SETTINGS);

    logger.setDebugMode(_settings.debugMode);
    persistSettings();

    // 通知所有变化的 key
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (oldSettings[key] !== _settings[key]) {
            notifyListeners(key, _settings[key], oldSettings[key]);
        }
    }

    logger.info('Settings reset to defaults');
}

// =====================================================
// 监听器
// =====================================================
/**
 * 订阅配置变化
 * @param {Function} callback ({ key, newValue, oldValue }) => void
 * @returns {Function} 取消订阅函数
 */
export function onSettingChange(callback) {
    if (typeof callback !== 'function') return () => {};
    _listeners.add(callback);
    return () => _listeners.delete(callback);
}

function notifyListeners(key, newValue, oldValue) {
    for (const cb of _listeners) {
        try {
            cb({ key, newValue, oldValue });
        } catch (e) {
            logger.error('Settings listener error:', e);
        }
    }
}

// =====================================================
// 持久化
// =====================================================
function persistSettings() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        } else {
            logger.warn('saveSettingsDebounced not available');
        }
    } catch (e) {
        logger.error('Failed to persist settings:', e);
    }
}