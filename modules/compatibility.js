/**
 * SillyTavern Preset Auto Save - Compatibility Layer
 * 兼容性探测与安全调用层
 *
 * 职责:
 *   1. 探测当前 SillyTavern 提供的 API
 *   2. 提供所有外部调用的安全包装
 *   3. 在 API 缺失时提供降级方案
 *   4. 隔离上层模块对 ST 内部的直接依赖
 */

import { logger } from './logger.js';

// =====================================================
// 环境能力标识
// =====================================================
export const ENV = {
    // 核心 API
    hasContext: false,
    hasGetPresetManager: false,
    hasEventSource: false,
    hasEventTypes: false,
    hasSaveSettings: false,

    // 工具 API
    hasPopup: false,
    hasRenderTemplate: false,
    hasToastr: false,
    hasLocalforage: false,

    // 关键事件类型
    hasOaiPresetChangedBefore: false,
    hasPresetChanged: false,
    hasSettingsUpdated: false,
    hasAppReady: false,
    hasAppInitialized: false,

    // PresetManager 方法
    hasSavePreset: false,
    hasGetPresetSettings: false,
    hasSelectPreset: false,
    hasFindPreset: false,
    hasGetSelectedPresetName: false,

    // 版本与时间
    stVersion: 'unknown',
    probedAt: null,
};

// =====================================================
// 内部状态
// =====================================================
const _registeredListeners = []; // { eventName, handler } - 便于卸载

// =====================================================
// 初始化探测
// =====================================================
/**
 * 探测当前环境能力
 * @returns {boolean} 是否满足最低运行要求
 */
export function initCompatibility() {
    logger.group('Environment probe');

    try {
        // 1. 核心: SillyTavern 全局
        ENV.hasContext = typeof window.SillyTavern?.getContext === 'function';
        if (!ENV.hasContext) {
            logger.error('SillyTavern.getContext not available!');
            return false;
        }

        const ctx = SillyTavern.getContext();

        // 2. 核心 API
        ENV.hasGetPresetManager = typeof ctx.getPresetManager === 'function';
        ENV.hasEventSource = !!ctx.eventSource && typeof ctx.eventSource.on === 'function';
        ENV.hasEventTypes = !!ctx.event_types;
        ENV.hasSaveSettings = typeof ctx.saveSettingsDebounced === 'function';

        // 3. 工具 API
        ENV.hasPopup = !!ctx.Popup && !!ctx.Popup.show;
        ENV.hasRenderTemplate = typeof ctx.renderExtensionTemplateAsync === 'function';
        ENV.hasToastr = typeof window.toastr !== 'undefined';
        ENV.hasLocalforage = !!window.SillyTavern?.libs?.localforage;

        // 4. 事件类型存在性探测
        if (ENV.hasEventTypes) {
            const et = ctx.event_types;
            ENV.hasOaiPresetChangedBefore = !!et.OAI_PRESET_CHANGED_BEFORE;
            ENV.hasPresetChanged = !!et.PRESET_CHANGED;
            ENV.hasSettingsUpdated = !!et.SETTINGS_UPDATED;
            ENV.hasAppReady = !!et.APP_READY;
            ENV.hasAppInitialized = !!et.APP_INITIALIZED;
        }

        // 5. PresetManager 方法探测
        if (ENV.hasGetPresetManager) {
            try {
                const pm = ctx.getPresetManager('openai');
                if (pm) {
                    ENV.hasSavePreset = typeof pm.savePreset === 'function';
                    ENV.hasGetPresetSettings = typeof pm.getPresetSettings === 'function';
                    ENV.hasSelectPreset = typeof pm.selectPreset === 'function';
                    ENV.hasFindPreset = typeof pm.findPreset === 'function';
                    ENV.hasGetSelectedPresetName = typeof pm.getSelectedPresetName === 'function';
                }
            } catch (_) {
                // ignore
            }
        }

        // 6. 版本探测
        ENV.stVersion = detectVersion();
        ENV.probedAt = Date.now();

        // 输出探测结果
        logger.info('SillyTavern version:', ENV.stVersion);
        logger.debug('Environment:', { ...ENV });

        // 关键能力检查
        const required = [
            ['Context API',         ENV.hasContext],
            ['EventSource',         ENV.hasEventSource],
            ['Preset Manager API',  ENV.hasGetPresetManager],
            ['Save Preset method',  ENV.hasSavePreset],
        ];

        const optional = [
            ['Popup API',           ENV.hasPopup],
            ['Template Render',     ENV.hasRenderTemplate],
            ['Toastr',              ENV.hasToastr],
            ['LocalForage',         ENV.hasLocalforage],
            ['OAI_PRESET_CHANGED_BEFORE', ENV.hasOaiPresetChangedBefore],
        ];

        let criticalMissing = false;
        for (const [name, ok] of required) {
            if (ok) logger.success(`Required: ${name}`);
            else { logger.error(`Required MISSING: ${name}`); criticalMissing = true; }
        }
        for (const [name, ok] of optional) {
            if (ok) logger.debug(`Optional: ${name} ✓`);
            else logger.warn(`Optional missing: ${name} (will use fallback)`);
        }

        if (criticalMissing) {
            logger.error('Critical APIs missing, extension may not work properly');
            return false;
        }

        return true;
    } catch (e) {
        logger.error('Compat probe failed:', e);
        return false;
    } finally {
        logger.groupEnd();
    }
}

// =====================================================
// 版本探测（多种方式）
// =====================================================
function detectVersion() {
    // 方式 1: window 全局
    if (window.SillyTavern?.version) return String(window.SillyTavern.version);

    // 方式 2: meta 标签
    const meta = document.querySelector('meta[name="version"]');
    if (meta?.content) return meta.content;

    // 方式 3: #version 元素
    const versionEl = document.getElementById('version');
    if (versionEl?.textContent) return versionEl.textContent.trim();

    return 'unknown';
}

// =====================================================
// 通用安全调用
// =====================================================
/**
 * 安全同步调用
 */
export function safeCall(fn, fallback = null, label = 'call') {
    try {
        return fn();
    } catch (e) {
        logger.warn(`safeCall(${label}) failed:`, e);
        return fallback;
    }
}

/**
 * 安全异步调用
 */
export async function safeCallAsync(fn, fallback = null, label = 'call') {
    try {
        return await fn();
    } catch (e) {
        logger.warn(`safeCallAsync(${label}) failed:`, e);
        return fallback;
    }
}

// =====================================================
// PresetManager 相关
// =====================================================

/**
 * 获取 PresetManager 实例（带降级）
 * @param {string} [apiId] 不指定则使用当前API
 */
export function getPresetManager(apiId) {
    const id = apiId || getCurrentApiId();

    // 优先级 1: 官方 API
    if (ENV.hasGetPresetManager) {
        const pm = safeCall(
            () => SillyTavern.getContext().getPresetManager(id),
            null,
            'getPresetManager-official'
        );
        if (pm) return pm;
    }

    // 优先级 2: 全局变量降级
    if (window.presetManagers && window.presetManagers[id]) {
        return window.presetManagers[id];
    }

    return null;
}

/**
 * 获取当前主API ID
 */
export function getCurrentApiId() {
    return safeCall(() => {
        const ctx = SillyTavern.getContext();
        return ctx.mainApi || window.main_api || 'openai';
    }, 'openai', 'getCurrentApiId');
}

/**
 * 获取当前选中的预设名
 */
export function getSelectedPresetName() {
    const pm = getPresetManager();
    if (!pm || typeof pm.getSelectedPresetName !== 'function') return null;
    return safeCall(() => pm.getSelectedPresetName(), null, 'getSelectedPresetName');
}

/**
 * 安全获取预设设置（不含被过滤字段的"干净"数据）
 * @param {string} [presetName] 不指定则用当前
 */
export function getPresetSettingsSafe(presetName) {
    const pm = getPresetManager();
    if (!pm || typeof pm.getPresetSettings !== 'function') return null;

    const name = presetName || getSelectedPresetName();
    if (!name) return null;

    return safeCall(() => pm.getPresetSettings(name), null, 'getPresetSettings');
}

/**
 * 安全保存预设
 * @param {string} presetName 预设名
 * @param {object} [settings] 不指定则使用当前预设设置
 * @param {object} [options] { skipUpdate, apiId }
 */
export async function savePresetSafe(presetName, settings = null, options = {}) {
    const pm = getPresetManager(options.apiId);
    if (!pm || typeof pm.savePreset !== 'function') {
        throw new Error('PresetManager.savePreset not available');
    }

    return await pm.savePreset(presetName, settings, {
        skipUpdate: options.skipUpdate ?? true,
    });
}

/**
 * 安全选中预设
 */
export function selectPresetSafe(presetName) {
    const pm = getPresetManager();
    if (!pm) return false;

    return safeCall(() => {
        if (typeof pm.findPreset === 'function' && typeof pm.selectPreset === 'function') {
            const value = pm.findPreset(presetName);
            if (value !== undefined) {
                pm.selectPreset(value);
                return true;
            }
        }
        return false;
    }, false, 'selectPreset');
}

/**
 * 获取所有预设名
 */
export function getAllPresetNames() {
    const pm = getPresetManager();
    if (!pm || typeof pm.getAllPresets !== 'function') return [];
    return safeCall(() => pm.getAllPresets(), [], 'getAllPresets');
}

// =====================================================
// 事件相关
// =====================================================

/**
 * 安全订阅事件（自动记录便于卸载）
 * @returns {Function} 取消订阅函数
 */
export function on(eventName, handler) {
    if (!ENV.hasEventSource) {
        logger.warn('EventSource not available, cannot subscribe to:', eventName);
        return () => {};
    }
    if (!eventName || typeof handler !== 'function') {
        return () => {};
    }

    try {
        const { eventSource } = SillyTavern.getContext();
        eventSource.on(eventName, handler);
        _registeredListeners.push({ eventName, handler });
        logger.debug('Event subscribed:', eventName);

        return () => off(eventName, handler);
    } catch (e) {
        logger.error('Failed to subscribe event:', eventName, e);
        return () => {};
    }
}

/**
 * 安全取消订阅
 */
export function off(eventName, handler) {
    if (!ENV.hasEventSource) return;

    try {
        const { eventSource } = SillyTavern.getContext();

        if (typeof eventSource.removeListener === 'function') {
            eventSource.removeListener(eventName, handler);
        } else if (typeof eventSource.off === 'function') {
            eventSource.off(eventName, handler);
        }

        const idx = _registeredListeners.findIndex(
            l => l.eventName === eventName && l.handler === handler
        );
        if (idx >= 0) _registeredListeners.splice(idx, 1);
    } catch (e) {
        logger.warn('Failed to unsubscribe event:', eventName, e);
    }
}

/**
 * 卸载所有由本扩展注册的事件
 */
export function offAll() {
    for (const { eventName, handler } of [..._registeredListeners]) {
        off(eventName, handler);
    }
    _registeredListeners.length = 0;
}

/**
 * 获取事件类型常量（带降级）
 * @param {string} name 常量名（如 'PRESET_CHANGED'）
 * @param {string} [fallback] 找不到时使用的字符串
 */
export function getEventType(name, fallback = null) {
    const fb = fallback ?? name.toLowerCase();
    if (!ENV.hasEventTypes) return fb;

    return safeCall(() => {
        const et = SillyTavern.getContext().event_types;
        return et[name] || fb;
    }, fb, `getEventType:${name}`);
}

// =====================================================
// UI 工具
// =====================================================

/**
 * 安全 toastr
 */
export const toast = {
    success(msg, title = '') {
        if (ENV.hasToastr) toastr.success(msg, title);
        else logger.info(`[toast] ${title} ${msg}`);
    },
    error(msg, title = '') {
        if (ENV.hasToastr) toastr.error(msg, title);
        else logger.error(`[toast] ${title} ${msg}`);
    },
    warning(msg, title = '') {
        if (ENV.hasToastr) toastr.warning(msg, title);
        else logger.warn(`[toast] ${title} ${msg}`);
    },
    info(msg, title = '') {
        if (ENV.hasToastr) toastr.info(msg, title);
        else logger.info(`[toast] ${title} ${msg}`);
    },
};

/**
 * 安全 confirm 弹窗
 * @returns {Promise<boolean>}
 */
export async function confirmSafe(title, message) {
    if (ENV.hasPopup) {
        try {
            const ctx = SillyTavern.getContext();
            const result = await ctx.Popup.show.confirm(title, message);
            return Boolean(result);
        } catch (e) {
            logger.warn('Popup.confirm failed, fallback to native:', e);
        }
    }
    return window.confirm(`${title}\n\n${message}`);
}

/**
 * 渲染扩展模板
 * @param {string} folder 扩展文件夹（如 'third-party/SillyTavern-PresetAutoSave'）
 * @param {string} template 模板名（不含 .html）
 * @param {object} [data] 模板数据
 */
export async function renderTemplate(folder, template, data = {}) {
    if (!ENV.hasRenderTemplate) {
        logger.error('renderExtensionTemplateAsync not available');
        return '';
    }

    return safeCallAsync(
        () => SillyTavern.getContext().renderExtensionTemplateAsync(folder, template, data),
        '',
        `renderTemplate:${template}`
    );
}

// =====================================================
// localforage 包装（带降级）
// =====================================================
/**
 * 创建 localforage 实例（不可用时降级到 localStorage 适配器）
 */
export function createStorage(name, storeName) {
    if (ENV.hasLocalforage) {
        try {
            return SillyTavern.libs.localforage.createInstance({ name, storeName });
        } catch (e) {
            logger.warn('localforage createInstance failed, fallback:', e);
        }
    }
    return createLocalStorageAdapter(name + '_' + storeName);
}

function createLocalStorageAdapter(prefix) {
    logger.warn('Using localStorage adapter (5MB limit)');
    return {
        async getItem(key) {
            const v = localStorage.getItem(prefix + ':' + key);
            try { return v ? JSON.parse(v) : null; }
            catch { return null; }
        },
        async setItem(key, val) {
            try {
                localStorage.setItem(prefix + ':' + key, JSON.stringify(val));
                return val;
            } catch (e) {
                logger.error('localStorage setItem failed (quota?):', e);
                throw e;
            }
        },
        async removeItem(key) {
            localStorage.removeItem(prefix + ':' + key);
        },
        async keys() {
            const result = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix + ':')) {
                    result.push(k.slice(prefix.length + 1));
                }
            }
            return result;
        },
        async clear() {
            const keys = await this.keys();
            for (const k of keys) {
                await this.removeItem(k);
            }
        },
    };
}

// =====================================================
// 诊断报告
// =====================================================
/**
 * 输出当前环境的兼容性报告
 */
export function getCompatReport() {
    return {
        env: { ...ENV },
        registeredListeners: _registeredListeners.length,
        timestamp: new Date().toISOString(),
    };
}