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
    hasTranslate: false,        // ctx.translate / ctx.t

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
let _lastSnapshotPath = null;    // 上一次 getPresetSnapshot 走的路径，用于日志降噪
let _presetDataResolver = null;  // 外部注册的预设数据解析器（接管模块用于查找 detached 预设）

/**
 * 注册外部的预设数据解析器
 * 接管模块在初始化时注册此回调，使 getPresetSnapshot 能从 detached options 获取预设数据。
 *
 * ⚡ 背景：DOM 接管后 pm.findPreset(name) 搜索 <select>.options，
 *   但被 detach 的 option 已不在 select 中 → findPreset 返回 undefined。
 *   接管模块保留了 detached option 的引用，能通过 option.value 反查原始数组索引。
 *
 * @param {function(string, string): object|null} fn (apiId, presetName) => presetData
 */
export function registerPresetDataResolver(fn) {
    _presetDataResolver = typeof fn === 'function' ? fn : null;
}

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
        ENV.hasTranslate = typeof ctx.translate === 'function' || typeof ctx.t === 'function';

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
 *
 * ⚡ B26 修复：DOM 接管后 representative option 的 textContent 被改为系列名，
 *   ST 的 pm.getSelectedPresetName() 读取 textContent → 返回系列名（如"梦境思客"）。
 *   我们需要检查 ORIGINAL_TEXT_DATA_ATTR 取回真实预设名（如"梦境思客V2-0429"）。
 *   否则 auto-save 会把快照存到系列名下，与 seed 产生的真实名快照不一致。
 */
export function getSelectedPresetName() {
    const pm = getPresetManager();
    if (!pm || typeof pm.getSelectedPresetName !== 'function') return null;
    let name = safeCall(() => pm.getSelectedPresetName(), null, 'getSelectedPresetName');

    // 修正接管后的系列名 → 真实预设名
    if (name) {
        try {
            const apiId = getCurrentApiId();
            const selects = document.querySelectorAll('select[data-preset-manager-for]');
            for (const sel of selects) {
                const selApiId = (sel.getAttribute('data-preset-manager-for') || '')
                    .split(',').map(s => s.trim()).filter(Boolean)[0] || '';
                if (selApiId !== apiId) continue;
                const selectedOpt = sel.options[sel.selectedIndex];
                if (selectedOpt) {
                    const orig = selectedOpt.getAttribute('data-pas-orig-text');
                    if (orig) {
                        name = orig;
                    }
                }
                break;
            }
        } catch (_) {
            // 降级：保持 PM 返回的名字
        }
    }

    return name;
}

/**
 * 安全获取预设设置（不含被过滤字段的"干净"数据）
 *
 * ⚠️ 重要：ST 内部 PresetManager.getPresetSettings() 在 apiId='openai' 时
 * **永远返回空对象 `{}`**（switch 语句没有 'openai' case，走 default）。
 * 这会导致我们获取到的 hash 永远是空对象的 hash，自动保存彻底失效！
 *
 * 因此本函数对 openai 走特殊路径：从 pm.getPresetList('openai').settings
 * 拿到完整的 oai_settings（实时对象，包含 prompts、prompt_order、所有用户设置）。
 *
 * @param {string} [presetName] 不指定则用当前
 * @returns {object|null} 完整的预设设置对象（深拷贝），或 null
 */
export function getPresetSettingsSafe(presetName) {
    return getPresetSnapshot(presetName);
}

/**
 * 获取当前生效的预设快照（深拷贝，避免引用变更影响哈希）
 *
 * 处理流程:
 *   1. 优先尝试 pm.getPresetSettings(name)
 *   2. 若返回空对象（openai 等情况），回退到 pm.getPresetList(api).settings
 *      —— 这是真正"当前生效"的对象（oai_settings / textgen_settings 等）
 *   3. 若两条路径都失败，记录详细诊断日志后返回 null
 *
 * @param {string} [presetName] 预设名（可选）
 * @returns {object|null}
 */
export function getPresetSnapshot(presetName) {
    const apiId = getCurrentApiId();
    const pm = getPresetManager(apiId);
    if (!pm) {
        logger.warn('[getPresetSnapshot] no preset manager');
        return null;
    }

    const name = presetName || getSelectedPresetName();
    if (!name) {
        logger.warn('[getPresetSnapshot] no preset name');
        return null;
    }

    const isUsable = (obj) => obj && typeof obj === 'object' && Object.keys(obj).length > 0;
    const currentName = getSelectedPresetName();
    const isCurrentPreset = (name === currentName);

    // 路径 1：官方 API（最稳定，针对特定预设）
    let raw = null;
    if (typeof pm.getPresetSettings === 'function') {
        raw = safeCall(() => pm.getPresetSettings(name), null, 'getPresetSettings');
        if (isUsable(raw)) {
            return cloneDeepSafe(raw);
        }
    }

    // 路径 2（针对特定预设）：用 findPreset 拿选项值
    //   ST 源码：findPreset(name) = $(select).find('option').filter(text===name).val()
    //   返回值是 option.value（对 openai 是字符串索引 "15"，对其他可能是名字）
    //   ⚠️ DOM 接管后 detached 的 option 不在 select 中 → findPreset 返回 undefined
    //      所以这条路径只对 select 中仍存在的 option 有效
    if (typeof pm.findPreset === 'function') {
        const found = safeCall(() => pm.findPreset(name), null, 'findPreset');
        if (found !== undefined && found !== null) {
            // 对 openai：found 是字符串形式的数组索引（如 "15"）
            // 用 getPresetList 拿到 presets 数组，用索引取数据
            const idx = parseInt(String(found), 10);
            if (!isNaN(idx) && typeof pm.getPresetList === 'function') {
                try {
                    const { presets } = pm.getPresetList(apiId);
                    if (Array.isArray(presets) && presets[idx] && isUsable(presets[idx])) {
                        return cloneDeepSafe(presets[idx]);
                    }
                } catch (_) {}
            }
            // 对其他 API：found 可能直接就是可用的对象
            if (isUsable(found)) {
                return cloneDeepSafe(found);
            }
        }
    }

    // ⚡ 路径 2.5（B28 关键修复）：通过 pm.getPresetList() 直接查内部数据数组
    //
    //   根本原因（从 ST 源码确认）：
    //     - findPreset(name) 搜索 $(select).find('option').text() === name → DOM 搜索
    //     - DOM 接管后被 detach 的 option 不在 select 中 → findPreset 返回 undefined
    //     - getPresetSettings(name) 对 openai 返回 oai_settings（当前设置），跟 name 无关
    //     - oai_settings.preset_settings_openai 是字符串（当前预设名），不是数组！
    //
    //   正确方案（从 ST 源码 preset-manager.js getCompletionPresetByName 确认）：
    //     pm.getPresetList(apiId) 返回：
    //       - presets = openai_settings（预设数据数组，ES 模块内部变量）
    //       - preset_names = openai_setting_names（{name: index} 映射）
    //     然后用 preset_names[name] 查索引 → presets[index] 取数据
    //     这完全绕过 DOM，不受接管影响！
    if (typeof pm.getPresetList === 'function') {
        try {
            const { presets, preset_names } = pm.getPresetList(apiId);
            if (presets && preset_names) {
                let presetData = null;

                if (Array.isArray(preset_names)) {
                    // 键值 API（instruct / context / sysprompt / reasoning）
                    // preset_names 是名字数组
                    const idx = preset_names.indexOf(name);
                    if (idx >= 0 && presets[idx]) {
                        presetData = presets[idx];
                    }
                } else if (typeof preset_names === 'object') {
                    // 非键值 API（openai / kobold / novel）
                    // preset_names = {presetName: arrayIndex}
                    const idx = preset_names[name];
                    if (idx !== undefined && presets[idx]) {
                        presetData = presets[idx];
                    }
                }

                if (isUsable(presetData)) {
                    return cloneDeepSafe(presetData);
                }
            }
        } catch (e) {
            logger.debug('[getPresetSnapshot] path 2.5 getPresetList error:', e);
        }
    }

    // 路径 2.5b：通过 getCompletionPresetByName（某些 ST 版本可能有此方法）
    if (typeof pm.getCompletionPresetByName === 'function') {
        const preset = safeCall(() => pm.getCompletionPresetByName(name), null, 'getCompletionPresetByName');
        if (isUsable(preset)) {
            return cloneDeepSafe(preset);
        }
    }

    // 路径 2.5c: 通过接管模块注册的回调解析器（最后后备路径）
    if (_presetDataResolver) {
        const resolved = safeCall(() => _presetDataResolver(apiId, name), null, 'presetDataResolver');
        if (isUsable(resolved)) {
            return cloneDeepSafe(resolved);
        }
    }

    // 路径 3（关键回退）：仅当查询的是"当前生效的预设"时，
    //   才从 getPresetList(api).settings 拿实时设置对象。
    //   对其他预设这条路径返回的是错的（永远是当前预设数据）！
    if (isCurrentPreset && typeof pm.getPresetList === 'function') {
        const list = safeCall(() => pm.getPresetList(apiId), null, 'getPresetList');
        const live = list && list.settings;
        if (isUsable(live)) {
            if (_lastSnapshotPath !== `list:${apiId}`) {
                logger.debug(`[getPresetSnapshot] using getPresetList(${apiId}).settings (fallback for current preset only)`);
                _lastSnapshotPath = `list:${apiId}`;
            }
            return cloneDeepSafe(live);
        }
    }

    // 路径 4（最后兜底）：仅当查询"当前预设"且是 openai 时，从 window.oai_settings 读
    if (isCurrentPreset && apiId === 'openai' && window.oai_settings && typeof window.oai_settings === 'object') {
        if (_lastSnapshotPath !== 'oai') {
            logger.debug('[getPresetSnapshot] using window.oai_settings (last fallback for current preset)');
            _lastSnapshotPath = 'oai';
        }
        return cloneDeepSafe(window.oai_settings);
    }

    // 失败：log 详情
    logger.warn(`[getPresetSnapshot] failed: apiId=${apiId} name="${name}" isCurrent=${isCurrentPreset} pm=${!!pm} findPreset=${typeof pm.findPreset}`);
    return null;
}

/**
 * 深拷贝（优先 structuredClone，失败回退 JSON）
 */
function cloneDeepSafe(obj) {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(obj);
        }
    } catch (_) { /* 不支持时回退 */ }
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch (_) {
        return obj; // 最后回退：返回引用（外部不应修改）
    }
}

/**
 * 安全保存预设
 * @param {string} presetName 预设名
 * @param {object} [settings] 不指定则使用当前预设设置
 * @param {object} [options] { skipUpdate, apiId }
 */
/**
 * 安全删除预设
 * @param {string} presetName 要删除的预设名
 * @param {string} [apiId] API 标识（默认当前）
 * @returns {Promise<boolean>} 是否成功
 */
export async function deletePresetSafe(presetName, apiId = null) {
    const pm = apiId ? getPresetManager(apiId) : getPresetManager();
    if (!pm || typeof pm.deletePreset !== 'function') {
        logger.warn('deletePresetSafe: PresetManager.deletePreset unavailable');
        return false;
    }
    try {
        const ok = await pm.deletePreset(presetName);
        return !!ok;
    } catch (e) {
        logger.warn(`deletePresetSafe(${presetName}) failed:`, e);
        return false;
    }
}

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

    // ⚡ 关键：ST 的 selectPreset 可能在 ST 内部 onChange 链中抛错
    //   （如 mistralai_model undefined 等历史遗留迁移代码失败），
    //   但实际预设已经切换了。所以不能直接看 safeCall 的 catch 结果，
    //   要"切换后再读 selected preset name 是否变成目标值"作为最终判定。
    if (typeof pm.findPreset !== 'function' || typeof pm.selectPreset !== 'function') {
        return false;
    }
    const value = pm.findPreset(presetName);
    if (value === undefined) {
        return false;
    }
    try {
        pm.selectPreset(value);
    } catch (e) {
        // ST 内部抛错不代表切换失败 —— 验证下面的最终状态
    }
    // 验证：切换后再问 ST 选中的是不是目标
    try {
        const cur = pm.getSelectedPresetName?.();
        if (cur && String(cur) === String(presetName)) {
            return true;
        }
    } catch (_) {}
    // 退一步：select 元素的 value 是否对了
    try {
        const sel = document.querySelector('select[data-preset-manager-for]');
        if (sel && sel.value === presetName) return true;
    } catch (_) {}
    return false;
}

/**
 * 获取所有预设名
 * @param {string} [apiId] 指定 API 的 PresetManager；不传 = 当前 mainApi
 */
export function getAllPresetNames(apiId) {
    const pm = getPresetManager(apiId);
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
    // Fallback: native confirm 不支持 HTML，去掉所有标签防止显示原始 markup
    const stripHtml = (s) => String(s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return window.confirm(`${stripHtml(title)}\n\n${stripHtml(message)}`);
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
// 国际化辅助
// =====================================================
/**
 * 翻译辅助函数
 * 优先使用 SillyTavern 的 ctx.translate / ctx.t；不可用时返回 key 本身
 * 支持 {{var}} 占位符替换
 *
 * @param {string} key 翻译键
 * @param {object} [vars] 占位符替换变量
 * @returns {string} 翻译后的字符串
 */
export function t(key, vars = null) {
    let result = key;
    if (ENV.hasTranslate) {
        try {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.translate === 'function') {
                result = ctx.translate(key);
            } else if (typeof ctx.t === 'function') {
                // 部分版本暴露的是模板字符串风格的 t``，回退到字符串风格
                result = ctx.t(key);
            }
        } catch (_) {
            result = key;
        }
    }

    // 占位符替换 {{var}}
    if (vars && typeof result === 'string') {
        for (const [k, v] of Object.entries(vars)) {
            result = result.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(v));
        }
    }
    return result;
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