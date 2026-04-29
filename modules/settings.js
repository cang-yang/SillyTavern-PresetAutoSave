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

    // 高级
    debugMode: false,               // 启用详细日志
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
    debugMode: (v) => Boolean(v),
};

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
                allSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
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
 * 获取整个配置对象（只读视角，请勿直接修改）
 */
export function getSettings() {
    if (!_initialized) {
        logger.warn('getSettings called before init');
        return DEFAULT_SETTINGS;
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
 * 批量更新
 * @param {object} updates 键值对
 * @returns {string[]} 实际发生变化的key列表
 */
export function batchUpdate(updates) {
    const changed = [];
    for (const [key, value] of Object.entries(updates)) {
        if (updateSetting(key, value)) {
            changed.push(key);
        }
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