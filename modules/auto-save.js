/**
 * SillyTavern Preset Auto Save - Auto Save Engine
 * 自动保存引擎
 *
 * 核心流程:
 *   DOM input/change 事件 → 防抖 → 调用 history-store.addSnapshot
 *                                  → 调用 ST PresetManager.savePreset
 *                                  → 更新状态指示器
 *
 * 关键保护:
 *   - 切换预设时进入"忽略输入模式"，避免虚假保存
 *   - 内部保存时设置标志，避免事件循环
 *   - 排除敏感字段（API Key 等）
 *   - 哈希去重（依赖 history-store 的内置去重）
 */

import { logger } from './logger.js';
import { getSettings, onSettingChange } from './settings.js';
import {
    on,
    getEventType,
    getCurrentApiId,
    getSelectedPresetName,
    getPresetSettingsSafe,
    savePresetSafe,
    toast,
    t,
} from './compatibility.js';
import { addSnapshot, TRIGGER, hashPreset } from './history-store.js';

// =====================================================
// 监听目标（覆盖各类 API 的设置面板）
// =====================================================
const WATCH_SELECTORS = [
    '#openai_settings',
    '#completion_prompt_manager',
    '#range_block_openai',
    '#textgenerationwebui_api-settings',
    '#range_block_textgenerationwebui',
    '#kobold_api-settings',
    '#range_block_kobold',
    '#novel_api-settings',
    '#range_block_novel',
];

// 应排除的字段前缀（敏感信息或非预设字段）
const EXCLUDED_ID_PREFIXES = [
    'api_key',
    'oai_api_key',
    'api_key_',
    'pas_',
];

// =====================================================
// 状态指示器接口（由 ui-injector 注册）
// =====================================================
let _setStatus = (_state) => {};

/**
 * 注册状态指示器更新函数（供 ui-injector 调用）
 */
export function registerStatusSetter(fn) {
    if (typeof fn === 'function') {
        _setStatus = fn;
    }
}

// =====================================================
// 内部状态
// =====================================================
let _initialized = false;
let _enabled = false;
let _debounceTimer = null;

let _ignoreInput = false;          // 切换期间忽略输入事件
let _ignoreInputTimer = null;     // 自动重置定时器，防止永久卡死
let _isInternalSave = false;       // 内部保存中（防递归）
let _dirty = false;                // 是否有未保存的修改
let _lastSavedHash = null;         // 最后保存的内容哈希

let _currentApiId = null;          // 当前跟踪的 API
let _currentPresetName = null;     // 当前跟踪的预设名

let _domHandlers = [];             // DOM 事件处理器记录
let _settingUnsubscribe = null;    // 设置变更订阅
let _eventUnsubscribers = [];      // ST 事件订阅取消函数集合

// =====================================================
// 初始化
// =====================================================
export async function initAutoSave() {
    if (_initialized) {
        logger.warn('AutoSave already initialized');
        return;
    }

    _initialized = true;

    const settings = getSettings();

    // 记录当前预设
    _currentApiId = getCurrentApiId();
    _currentPresetName = getSelectedPresetName();

    // 计算初始哈希（避免初次加载就触发保存）
    const initialPreset = getPresetSettingsSafe();
    if (initialPreset) {
        _lastSavedHash = hashPreset(initialPreset);
    }

    // 绑定预设切换/保护
    bindPresetEvents();

    // 监听设置变更（动态启用/禁用）
    _settingUnsubscribe = onSettingChange(({ key }) => {
        if (key === 'enabled') {
            applyEnabledState();
        }
    });

    // 应用启用状态
    applyEnabledState();

    logger.success(
        `Auto-save initialized: tracking [${_currentApiId}] ${_currentPresetName || '(none)'}`
    );
}

/**
 * 根据 settings.enabled 启用或禁用 DOM 监听
 */
function applyEnabledState() {
    const shouldEnable = !!getSettings().enabled;
    if (shouldEnable === _enabled) return;

    _enabled = shouldEnable;
    if (_enabled) {
        bindDOMListeners();
        logger.info('Auto-save ENABLED');
    } else {
        cancelPendingSave();
        unbindDOMListeners();
        _setStatus('idle');
        logger.info('Auto-save DISABLED');
    }
}

// =====================================================
// DOM 监听（事件委托）
// =====================================================
function bindDOMListeners() {
    if (_domHandlers.length > 0) return;

    const handleInput = (event) => onElementInput(event);
    const handleChange = (event) => onElementChange(event);

    // 使用捕获阶段，确保即使被 stopPropagation 也能拿到
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);

    _domHandlers.push(
        { type: 'input', handler: handleInput },
        { type: 'change', handler: handleChange }
    );

    logger.debug('DOM listeners bound');
}

function unbindDOMListeners() {
    for (const { type, handler } of _domHandlers) {
        document.removeEventListener(type, handler, true);
    }
    _domHandlers = [];
}

/**
 * 判断元素是否在我们关心的区域内
 */
function isInWatchedArea(element) {
    if (!element || !element.closest) return false;
    for (const selector of WATCH_SELECTORS) {
        try {
            if (element.closest(selector)) return true;
        } catch (_) {
            // 无效 selector 忽略
        }
    }
    return false;
}

/**
 * 判断元素是否被本扩展自己创建（应忽略）
 */
function isOwnElement(element) {
    if (!element || !element.closest) return false;
    return !!element.closest('[data-pas-element], #pas_history_btn, .pas-panel, .pas-popup');
}

/**
 * 判断元素是否应被自动保存监听
 */
function isElementWatchable(element) {
    if (!element) return false;
    if (isOwnElement(element)) return false;
    if (!isInWatchedArea(element)) return false;

    // 排除敏感字段
    const id = (element.id || '').toLowerCase();
    for (const prefix of EXCLUDED_ID_PREFIXES) {
        if (id.startsWith(prefix)) return false;
    }

    // 排除已禁用的元素
    if (element.disabled) return false;

    // 必须是表单元素
    const tag = element.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        return false;
    }

    return true;
}

function onElementInput(event) {
    if (!_enabled || _ignoreInput || _isInternalSave) return;
    if (!isElementWatchable(event.target)) return;

    const el = event.target;
    const settings = getSettings();

    // 滑块: 始终在 input 阶段不触发实际保存（拖动时频繁触发会卡）
    // 等 change 事件（即"松开"）再保存
    if (el.type === 'range') {
        // 进入 pending 状态，但不调度保存
        _dirty = true;
        _setStatus('pending');
        return;
    }

    // 文本框/textarea: 长防抖
    if (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'search') {
        scheduleAutoSave(settings.textInputDebounce);
        return;
    }

    // 数字输入框: 通用防抖
    if (el.type === 'number') {
        scheduleAutoSave(settings.debounceMs);
        return;
    }

    // 默认
    scheduleAutoSave(settings.debounceMs);
}

function onElementChange(event) {
    if (!_enabled || _ignoreInput || _isInternalSave) return;
    if (!isElementWatchable(event.target)) return;

    const el = event.target;
    const settings = getSettings();

    // 滑块: change 触发保存（用户松开了），sliderReleaseSave 关闭时使用更短的延迟
    if (el.type === 'range') {
        const delay = settings.sliderReleaseSave ? settings.debounceMs : 0;
        scheduleAutoSave(delay);
        return;
    }

    // 复选框/单选/select: change 立即触发
    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') {
        scheduleAutoSave(settings.debounceMs);
        return;
    }

    // 其他: blur 时的 change（如失焦后值改变）
    scheduleAutoSave(settings.debounceMs);
}

// =====================================================
// 防抖调度
// =====================================================
/**
 * 调度自动保存
 * @param {number} [delay] 自定义延迟，默认使用 settings.debounceMs
 */
export function scheduleAutoSave(delay = null) {
    if (!_enabled || _ignoreInput || _isInternalSave) return;

    const settings = getSettings();
    if (!settings.enabled) return;

    const ms = delay ?? settings.debounceMs;

    clearTimeout(_debounceTimer);
    _dirty = true;
    _setStatus('pending');

    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        doSave().catch(e => logger.error('Scheduled save failed:', e));
    }, ms);
}

export function cancelPendingSave() {
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
}

/**
 * 强制立即执行保存（如果有挂起的）
 */
export async function flushSave() {
    if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }
    return await doSave();
}

// =====================================================
// 核心保存
// =====================================================
async function doSave(trigger = TRIGGER.AUTO) {
    if (_isInternalSave) {
        logger.debug('Save skipped (internal save in progress)');
        return null;
    }

    _isInternalSave = true;
    _setStatus('saving');

    try {
        const apiId = getCurrentApiId();
        const presetName = getSelectedPresetName();

        if (!apiId || !presetName) {
            logger.warn('Cannot save: API or preset not available');
            _setStatus('error');
            return null;
        }

        // 检测预设切换（防止把新预设的内容写入旧预设名）
        if (_currentPresetName && _currentPresetName !== presetName) {
            logger.debug(
                `Preset changed during save: "${_currentPresetName}" -> "${presetName}", aborting old save`
            );
            // 更新跟踪
            _currentPresetName = presetName;
            _currentApiId = apiId;
            _lastSavedHash = null;
            _dirty = false;
            _setStatus('idle');
            return null;
        }

        const preset = getPresetSettingsSafe(presetName);
        if (!preset) {
            logger.warn('Cannot read current preset:', presetName);
            _setStatus('error');
            return null;
        }

        // 创建历史快照（store 会自己判断是否需要写入）
        const snapshot = await addSnapshot(presetName, apiId, preset, trigger);

        if (!snapshot) {
            // 内容未变化，跳过
            _dirty = false;
            _setStatus('idle');
            return null;
        }

        // 写入磁盘
        await savePresetSafe(presetName, preset, { skipUpdate: true, apiId });

        _lastSavedHash = snapshot.hash;
        _dirty = false;
        _setStatus('saved');

        const settings = getSettings();
        if (settings.notifyOnSave) {
            toast.success(t('Saved Toast', { name: presetName }));
        }

        logger.debug(`Saved [${apiId}] ${presetName} (hash: ${snapshot.hash})`);
        return snapshot;
    } catch (e) {
        logger.error('Save failed:', e);
        _setStatus('error');
        toast.error(t('Save Failed Toast', { message: e?.message || String(e) }));
        return null;
    } finally {
        _isInternalSave = false;
    }
}

/**
 * 强制立即保存（外部调用，比如 UI "立即保存" 按钮）
 */
export async function saveNow(trigger = TRIGGER.MANUAL) {
    cancelPendingSave();
    return await doSave(trigger);
}

// =====================================================
// 切换保护 + 预设跟踪
// =====================================================
/**
 * 设置忽略输入标志，带自动超时保护
 * 防止因事件丢失导致 _ignoreInput 永久卡死
 */
function setIgnoreInput(value, autoResetMs = 5000) {
    _ignoreInput = value;

    if (_ignoreInputTimer) {
        clearTimeout(_ignoreInputTimer);
        _ignoreInputTimer = null;
    }

    if (value && autoResetMs > 0) {
        _ignoreInputTimer = setTimeout(() => {
            if (_ignoreInput) {
                logger.warn('IgnoreInput auto-reset after timeout');
                setIgnoreInput(false);
            }
            _ignoreInputTimer = null;
        }, autoResetMs);
    }
}

function bindPresetEvents() {
    // ----- OpenAI 专属切换前事件（最可靠的保护点）-----
    const oaiBefore = getEventType('OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before');
    _eventUnsubscribers.push(on(oaiBefore, async () => {
        if (!getSettings().enableSwitchGuard) {
            setIgnoreInput(true);  // 仍然忽略事件，避免污染
            return;
        }

        try {
            setIgnoreInput(true);

            if (_dirty || _debounceTimer) {
                logger.info('Switch guard: saving dirty preset before switch');
                cancelPendingSave();
                await doSave(TRIGGER.SWITCH_GUARD);
            }
        } catch (e) {
            logger.error('Switch guard error:', e);
        }
    }));

    // ----- OpenAI 切换后事件 -----
    const oaiAfter = getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after');
    _eventUnsubscribers.push(on(oaiAfter, () => {
        // 延迟退出，确保所有连锁的 input 事件都已处理完
        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 150);
    }));

    // ----- 通用预设切换事件（适用于所有 API）-----
    const presetChanged = getEventType('PRESET_CHANGED', 'preset_changed');
    _eventUnsubscribers.push(on(presetChanged, async (data) => {
        // 取消挂起的保存（属于旧预设）
        cancelPendingSave();

        // 立即进入忽略模式
        setIgnoreInput(true);

        if (data) {
            if (data.apiId) _currentApiId = data.apiId;
            if (data.name) _currentPresetName = data.name;
        }

        // 延迟更新跟踪与退出忽略模式
        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 200);
    }));

    // ----- 主 API 切换 -----
    const mainApiChanged = getEventType('MAIN_API_CHANGED', 'main_api_changed');
    _eventUnsubscribers.push(on(mainApiChanged, () => {
        cancelPendingSave();
        setIgnoreInput(true);

        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 200);
    }));
}

/**
 * 切换完成后更新内部跟踪状态
 */
function updateTrackingAfterSwitch() {
    _currentApiId = getCurrentApiId();
    _currentPresetName = getSelectedPresetName();

    const newPreset = getPresetSettingsSafe();
    _lastSavedHash = newPreset ? hashPreset(newPreset) : null;
    _dirty = false;
    _setStatus('idle');

    logger.debug(`Tracking updated: [${_currentApiId}] ${_currentPresetName}`);
}

// =====================================================
// 状态查询（供其他模块/调试使用）
// =====================================================
export function isDirty() {
    return _dirty;
}

export function isSaving() {
    return _isInternalSave;
}

export function isPending() {
    return _debounceTimer !== null;
}

export function isEnabled() {
    return _enabled;
}

export function getCurrentTracking() {
    return {
        apiId: _currentApiId,
        presetName: _currentPresetName,
        dirty: _dirty,
        saving: _isInternalSave,
        pending: _debounceTimer !== null,
        ignoring: _ignoreInput,
        lastHash: _lastSavedHash,
    };
}

// =====================================================
// 卸载（供 onDelete hook 使用）
// =====================================================
export function teardown() {
    cancelPendingSave();
    unbindDOMListeners();
    if (_settingUnsubscribe) {
        try { _settingUnsubscribe(); } catch (_) {}
        _settingUnsubscribe = null;
    }
    // 取消所有 ST 事件订阅
    for (const unsub of _eventUnsubscribers) {
        try { typeof unsub === 'function' && unsub(); } catch (_) {}
    }
    _eventUnsubscribers = [];

    if (_ignoreInputTimer) {
        clearTimeout(_ignoreInputTimer);
        _ignoreInputTimer = null;
    }
    _initialized = false;
    _enabled = false;
    _ignoreInput = false;
    _dirty = false;
    _isInternalSave = false;
    logger.info('AutoSave torn down');
}