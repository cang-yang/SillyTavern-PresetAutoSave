/**
 * SillyTavern Preset Auto Save - Auto Save Engine
 * 自动保存引擎（事件驱动 + DOM 兜底 + Prompt Manager 专项监听）
 *
 * 触发来源（按优先级降序）:
 *   1. SETTINGS_UPDATED 事件 - ST 任何内部 state 更新后都会广播，最可靠
 *   2. OAI_PRESET_CHANGED_AFTER 事件 - 切换预设后，跟踪状态更新
 *   3. DOM input/change 事件 - 兜底（适配未发出 SETTINGS_UPDATED 的 ST 版本）
 *   4. Prompt Manager 区域的 click + MutationObserver - 监听 prompt 弹窗保存
 *
 * 关键保护:
 *   - 切换预设期间忽略输入（_ignoreInput）+ 自动超时重置
 *   - 内部保存中标志（_isInternalSave）防递归
 *   - 排除敏感字段（API Key 等）
 *   - 哈希去重 + 详细诊断日志
 */

import { logger } from './logger.js';
import { getSettings, onSettingChange } from './settings.js';
import {
    on,
    getEventType,
    getCurrentApiId,
    getSelectedPresetName,
    getPresetSnapshot,
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

// Prompt Manager 区域 - 需要单独监听（弹窗保存按钮 click 等）
const PROMPT_MANAGER_SELECTORS = [
    '#completion_prompt_manager',
    '#completion_prompt_manager_popup',
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
let _ignoreInputTimer = null;      // 自动重置定时器，防止永久卡死
let _isInternalSave = false;       // 内部保存中（防递归）
let _dirty = false;                // 是否有未保存的修改
let _lastSavedHash = null;         // 最后保存的内容哈希
let _suspendUntil = 0;             // SETTINGS_UPDATED 风暴期间临时挂起，用 Date.now()

let _currentApiId = null;          // 当前跟踪的 API
let _currentPresetName = null;     // 当前跟踪的预设名

let _domHandlers = [];             // DOM 事件处理器记录
let _settingUnsubscribe = null;    // 设置变更订阅
let _eventUnsubscribers = [];      // ST 事件订阅取消函数集合
let _promptObserver = null;        // Prompt Manager 区域 MutationObserver
let _pollingTimer = null;          // 兜底轮询计时器

// 诊断/统计
const _stats = {
    triggeredBySettingsUpdated: 0,
    triggeredByDOM: 0,
    triggeredByPrompt: 0,
    saved: 0,
    skippedUnchanged: 0,
    aborted: 0,
};

// =====================================================
// 初始化
// =====================================================
export async function initAutoSave() {
    if (_initialized) {
        logger.warn('AutoSave already initialized');
        return;
    }

    _initialized = true;

    // 记录当前预设
    _currentApiId = getCurrentApiId();
    _currentPresetName = getSelectedPresetName();

    // 计算初始哈希（避免初次加载就触发保存）
    const initialPreset = getPresetSnapshot();
    if (initialPreset) {
        _lastSavedHash = hashPreset(initialPreset);
        const keys = Object.keys(initialPreset).length;
        logger.debug(
            `Initial baseline: [${_currentApiId}] ${_currentPresetName} hash=${_lastSavedHash} fields=${keys}`
        );
        if (keys < 5) {
            logger.warn(
                `Initial preset has only ${keys} fields - this may indicate a snapshot fallback issue. ` +
                `Sample keys: ${Object.keys(initialPreset).slice(0, 10).join(',')}`
            );
        }
    } else {
        logger.warn('No initial preset available; baseline hash not set');
    }

    // 绑定 ST 事件（包含 SETTINGS_UPDATED + 切换/预设变更）
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
 * 根据 settings.enabled 启用或禁用 监听
 */
function applyEnabledState() {
    const shouldEnable = !!getSettings().enabled;
    if (shouldEnable === _enabled) return;

    _enabled = shouldEnable;
    if (_enabled) {
        bindDOMListeners();
        bindPromptManagerListeners();
        startPolling();
        logger.info('Auto-save ENABLED');
    } else {
        cancelPendingSave();
        unbindDOMListeners();
        unbindPromptManagerListeners();
        stopPolling();
        _setStatus('idle');
        logger.info('Auto-save DISABLED');
    }
}

// =====================================================
// 兜底轮询：每 N 秒检查一次预设内容的 hash 是否变化
// 用于防止某些事件被跳过 / 未发出 SETTINGS_UPDATED 的 ST 版本
// =====================================================
const POLLING_INTERVAL_MS = 5000;

function startPolling() {
    if (_pollingTimer) return;
    _pollingTimer = setInterval(() => {
        if (!_enabled || _ignoreInput || _isInternalSave) return;
        if (Date.now() < _suspendUntil) return;
        if (_debounceTimer) return; // 已有挂起的保存，避免重复
        try {
            const preset = getPresetSnapshot();
            if (!preset) return;
            const h = hashPreset(preset);
            if (_lastSavedHash && h !== _lastSavedHash) {
                logger.debug(`[Polling] hash mismatch ${_lastSavedHash} -> ${h}, scheduling save`);
                scheduleAutoSave(getSettings().debounceMs, 'polling');
            }
        } catch (e) {
            logger.warn('Polling check failed:', e);
        }
    }, POLLING_INTERVAL_MS);
    logger.debug(`Polling started (interval=${POLLING_INTERVAL_MS}ms)`);
}

function stopPolling() {
    if (_pollingTimer) {
        clearInterval(_pollingTimer);
        _pollingTimer = null;
        logger.debug('Polling stopped');
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

function describeElement(el) {
    if (!el) return '(null)';
    const tag = (el.tagName || '').toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const name = el.name ? `[name=${el.name}]` : '';
    const type = el.type ? `:${el.type}` : '';
    return `${tag}${type}${id}${name}`;
}

function onElementInput(event) {
    if (!_enabled || _ignoreInput || _isInternalSave) return;
    if (!isElementWatchable(event.target)) return;

    const el = event.target;
    const settings = getSettings();

    _stats.triggeredByDOM++;
    logger.debug(`[DOM input] ${describeElement(el)}`);

    // 滑块: 始终在 input 阶段不触发实际保存（拖动时频繁触发会卡）
    // 等 change 事件（即"松开"）再保存
    if (el.type === 'range') {
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

    _stats.triggeredByDOM++;
    logger.debug(`[DOM change] ${describeElement(el)}`);

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
// Prompt Manager 专项监听
// =====================================================
/**
 * Prompt Manager 的弹窗保存按钮、增删条目、拖拽排序都不会触发标准 input/change，
 * 我们用 click 委托 + MutationObserver 来捕获它们，再调度保存。
 */
let _pmClickHandler = null;
function bindPromptManagerListeners() {
    if (_pmClickHandler || _promptObserver) return; // 幂等
    // 文档级 click 委托（覆盖 popup 内 Save 按钮）
    const handler = (event) => {
        if (!_enabled || _ignoreInput || _isInternalSave) return;

        const target = event.target;
        if (!target || !target.closest) return;

        // 弹窗的"Save"按钮
        if (target.closest('#completion_prompt_manager_popup_entry_form_save')) {
            _stats.triggeredByPrompt++;
            logger.debug('[PromptManager] entry form save clicked');
            // 点击后，PromptManager 会在内部 mutate oai_settings 然后保存。
            // 给它足够的延迟以同步到内存
            scheduleAutoSave(getSettings().debounceMs, 'prompt-edit-save');
            return;
        }

        // Prompt 行上的"启用/禁用"切换、"删除"按钮等
        const promptRow = target.closest('#completion_prompt_manager .completion_prompt_manager_prompt');
        if (promptRow) {
            // 仅在动作类元素上触发（避免点空白也保存）
            if (target.closest('.prompt-manager-toggle-action, .prompt-manager-detach-action, .prompt-manager-edit-action, [data-pm-action]')) {
                _stats.triggeredByPrompt++;
                logger.debug('[PromptManager] action button clicked');
                scheduleAutoSave(getSettings().debounceMs, 'prompt-action');
            }
        }

        // 添加按钮
        if (target.closest('#completion_prompt_manager_footer_append_prompt') || target.closest('#completion_prompt_manager_new_prompt')) {
            _stats.triggeredByPrompt++;
            logger.debug('[PromptManager] add prompt clicked');
            scheduleAutoSave(getSettings().debounceMs, 'prompt-add');
        }
    };

    document.addEventListener('click', handler, true);
    _pmClickHandler = handler;

    // MutationObserver：监听 prompt 列表的 DOM 变化（拖拽排序、删除条目）
    try {
        _promptObserver = new MutationObserver((mutations) => {
            if (!_enabled || _ignoreInput || _isInternalSave) return;
            // 只关心 childList 变化（条目顺序变了/被增删）或属性变化（启用状态切换 class）
            for (const m of mutations) {
                if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                    _stats.triggeredByPrompt++;
                    logger.debug('[PromptManager] DOM mutation: childList');
                    scheduleAutoSave(getSettings().debounceMs, 'prompt-mutation');
                    return;
                }
                if (m.type === 'attributes' && m.attributeName === 'class') {
                    const target = m.target;
                    if (target && target.classList && (
                        target.classList.contains('completion_prompt_manager_prompt') ||
                        target.classList.contains('completion_prompt_manager_prompt_disabled') ||
                        target.classList.contains('completion_prompt_manager_prompt_visible') ||
                        target.classList.contains('completion_prompt_manager_prompt_invisible')
                    )) {
                        _stats.triggeredByPrompt++;
                        logger.debug('[PromptManager] DOM mutation: class change');
                        scheduleAutoSave(getSettings().debounceMs, 'prompt-class');
                        return;
                    }
                }
            }
        });

        const tryAttach = () => {
            for (const sel of PROMPT_MANAGER_SELECTORS) {
                const node = document.querySelector(sel);
                if (node) {
                    _promptObserver.observe(node, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: ['class', 'data-pm-prompt'],
                    });
                    logger.debug(`[PromptManager] observer attached to ${sel}`);
                }
            }
        };
        tryAttach();
        // PromptManager 可能后加载，再延迟尝试一次
        setTimeout(tryAttach, 1500);
    } catch (e) {
        logger.warn('Failed to attach prompt manager observer:', e);
    }
}

function unbindPromptManagerListeners() {
    if (_pmClickHandler) {
        try { document.removeEventListener('click', _pmClickHandler, true); } catch (_) {}
        _pmClickHandler = null;
    }
    if (_promptObserver) {
        try { _promptObserver.disconnect(); } catch (_) {}
        _promptObserver = null;
    }
}

// =====================================================
// 防抖调度
// =====================================================
/**
 * 调度自动保存
 * @param {number} [delay] 自定义延迟，默认使用 settings.debounceMs
 * @param {string} [reason] 触发原因（用于日志诊断）
 */
export function scheduleAutoSave(delay = null, reason = 'unspecified') {
    if (!_enabled || _ignoreInput || _isInternalSave) return;

    const settings = getSettings();
    if (!settings.enabled) return;

    // SETTINGS_UPDATED 风暴期间挂起
    if (Date.now() < _suspendUntil) {
        logger.debug(`scheduleAutoSave suspended (reason=${reason})`);
        return;
    }

    const ms = delay ?? settings.debounceMs;

    clearTimeout(_debounceTimer);
    _dirty = true;
    _setStatus('pending');

    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        doSave(TRIGGER.AUTO, reason).catch(e => logger.error('Scheduled save failed:', e));
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
    return await doSave(TRIGGER.AUTO, 'flush');
}

// =====================================================
// 核心保存
// =====================================================
async function doSave(trigger = TRIGGER.AUTO, reason = '', explicitTarget = null) {
    if (_isInternalSave) {
        logger.debug('Save skipped (internal save in progress)');
        _stats.aborted++;
        return null;
    }

    _isInternalSave = true;
    _setStatus('saving');

    try {
        // 让出一个微任务，确保上层（PromptManager / oai_settings 同步）已完成
        await new Promise(resolve => setTimeout(resolve, 0));

        // explicitTarget 用于切换前保护：明确指定要保存的预设名
        // 否则用当前选中的（可能在切换过程中已经变了）
        const apiId = explicitTarget?.apiId || getCurrentApiId();
        const presetName = explicitTarget?.presetName || getSelectedPresetName();

        if (!apiId || !presetName) {
            logger.warn('Cannot save: API or preset not available');
            _setStatus('error');
            _stats.aborted++;
            return null;
        }

        // 仅在非显式目标的情况下才做"切换中"中止逻辑
        // （显式 target 通常来自 switch-guard，必须强制保存到指定预设）
        if (!explicitTarget && _currentPresetName && _currentPresetName !== presetName) {
            logger.debug(
                `Preset changed during save: "${_currentPresetName}" -> "${presetName}", aborting old save`
            );
            _currentPresetName = presetName;
            _currentApiId = apiId;
            _lastSavedHash = null;
            _dirty = false;
            _setStatus('idle');
            _stats.aborted++;
            return null;
        }

        const preset = getPresetSnapshot(presetName);
        if (!preset) {
            logger.warn('Cannot read current preset:', presetName);
            _setStatus('error');
            _stats.aborted++;
            return null;
        }

        // 计算 hash 并诊断
        const newHash = hashPreset(preset);
        const promptCount = Array.isArray(preset.prompts) ? preset.prompts.length : 0;
        const promptOrderCount = Array.isArray(preset.prompt_order)
            ? (preset.prompt_order[0]?.order?.length || 0)
            : 0;
        const fieldCount = Object.keys(preset).length;
        // 关键字段指纹（便于排查"toggle 改了但 hash 没变"这类幻觉）
        const fingerprint = computeFingerprint(preset);

        // 异常预设检测：字段过少强烈暗示快照获取失败
        if (fieldCount < 5) {
            logger.warn(
                `[doSave] Suspicious preset: only ${fieldCount} fields, reason=${reason}. ` +
                `Snapshot may be incomplete. Aborting to avoid corruption.`
            );
            _stats.aborted++;
            _setStatus('error');
            return null;
        }

        if (_lastSavedHash && newHash === _lastSavedHash) {
            // 与上次比较没变化（可能是 SETTINGS_UPDATED 重复触发）
            logger.debug(
                `[doSave] No change reason=${reason} hash=${newHash} fields=${fieldCount} prompts=${promptCount} order=${promptOrderCount} fp=${fingerprint}`
            );
            _stats.skippedUnchanged++;
            _dirty = false;
            _setStatus('idle');
            return null;
        }

        logger.debug(
            `[doSave] Snapshotting reason=${reason} hash=${_lastSavedHash}->${newHash} fields=${fieldCount} prompts=${promptCount} order=${promptOrderCount} fp=${fingerprint}`
        );

        // 创建历史快照（store 会自己再判断一次去重 + 合并窗口）
        const snapshot = await addSnapshot(presetName, apiId, preset, trigger);

        if (!snapshot) {
            // store 判断未变化（可能在合并窗口内）
            _dirty = false;
            _setStatus('idle');
            _stats.skippedUnchanged++;
            return null;
        }

        // 写入磁盘
        await savePresetSafe(presetName, preset, { skipUpdate: true, apiId });

        _lastSavedHash = snapshot.hash;
        _dirty = false;
        _setStatus('saved');
        _stats.saved++;

        const settings = getSettings();
        if (settings.notifyOnSave) {
            toast.success(t('Saved Toast', { name: presetName }));
        }

        logger.info(
            `[Saved] [${apiId}] ${presetName} (hash=${snapshot.hash}, size=${snapshot.size}, reason=${reason})`
        );
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
    return await doSave(trigger, 'manual');
}

/**
 * 关键字段指纹：让用户能从日志判断"哪个字段刚刚被改了"
 * 输出：长度（prompt array）+ 几个常见 toggle 的真实值
 */
function computeFingerprint(preset) {
    if (!preset) return '(empty)';
    const fp = {};
    const watchKeys = [
        'temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty',
        'temp', 'rep_pen',
        'streaming', 'stream_response',
        'wrap_in_quotes', 'wi_format', 'show_external_links',
        'function_calling', 'request_images',
        'reasoning_effort', 'show_thoughts',
        'preset', 'name',
    ];
    for (const k of watchKeys) {
        if (Object.hasOwn(preset, k)) {
            const v = preset[k];
            // 仅保留简单标量
            if (v === null || v === undefined) continue;
            if (typeof v === 'object') continue;
            fp[k] = v;
        }
    }
    if (Array.isArray(preset.prompts)) fp._prompts_len = preset.prompts.length;
    if (Array.isArray(preset.prompt_order)) {
        fp._order_len = preset.prompt_order[0]?.order?.length || 0;
    }
    // 输出短串
    try {
        return JSON.stringify(fp).slice(0, 200);
    } catch {
        return '(unserializable)';
    }
}

// =====================================================
// 切换保护 + 预设跟踪
// =====================================================
/**
 * 设置忽略输入标志，带自动超时保护
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
    // ----- SETTINGS_UPDATED：所有内部 state 变化的可靠信号 -----
    const settingsUpdated = getEventType('SETTINGS_UPDATED', 'settings_updated');
    _eventUnsubscribers.push(on(settingsUpdated, () => {
        if (!_enabled || _ignoreInput || _isInternalSave) return;
        if (Date.now() < _suspendUntil) return;
        _stats.triggeredBySettingsUpdated++;
        logger.debug('[ST event] SETTINGS_UPDATED');
        // SETTINGS_UPDATED 是 ST 已经更新完内存后发的，不需要再让出微任务
        scheduleAutoSave(getSettings().debounceMs, 'settings_updated');
    }));

    // ----- OpenAI 专属切换前事件（最可靠的保护点）-----
    const oaiBefore = getEventType('OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before');
    _eventUnsubscribers.push(on(oaiBefore, async () => {
        if (!getSettings().enableSwitchGuard) {
            setIgnoreInput(true);
            return;
        }

        try {
            setIgnoreInput(true);

            // 关键修复：传入"切换前"我们记录的预设名作为显式 target，
            // 因为此时 ST 内部 oai_settings.preset_settings_openai 可能已经
            // 被改成新名字了（getSelectedPresetName 会返回新名字）。
            // 只要 _currentPresetName 仍是旧名字，就用它作为保存目标。
            if (_dirty || _debounceTimer) {
                if (_currentPresetName && _currentApiId) {
                    logger.info(`Switch guard: saving dirty preset "${_currentPresetName}" before switch`);
                    cancelPendingSave();
                    await doSave(TRIGGER.SWITCH_GUARD, 'switch-guard', {
                        apiId: _currentApiId,
                        presetName: _currentPresetName,
                    });
                } else {
                    logger.warn('Switch guard skipped: no tracked preset to save');
                }
            }
        } catch (e) {
            logger.error('Switch guard error:', e);
        }
    }));

    // ----- OpenAI 切换后事件 -----
    const oaiAfter = getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after');
    _eventUnsubscribers.push(on(oaiAfter, () => {
        // 切换会触发大量 SETTINGS_UPDATED，临时挂起 1.5s
        _suspendUntil = Date.now() + 1500;
        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 200);
    }));

    // ----- 通用预设切换事件（适用于所有 API）-----
    const presetChanged = getEventType('PRESET_CHANGED', 'preset_changed');
    _eventUnsubscribers.push(on(presetChanged, async (data) => {
        cancelPendingSave();
        setIgnoreInput(true);
        _suspendUntil = Date.now() + 1500;

        if (data) {
            if (data.apiId) _currentApiId = data.apiId;
            if (data.name) _currentPresetName = data.name;
        }

        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 250);
    }));

    // ----- 主 API 切换 -----
    const mainApiChanged = getEventType('MAIN_API_CHANGED', 'main_api_changed');
    _eventUnsubscribers.push(on(mainApiChanged, () => {
        cancelPendingSave();
        setIgnoreInput(true);
        _suspendUntil = Date.now() + 1500;

        setTimeout(() => {
            updateTrackingAfterSwitch();
            setIgnoreInput(false);
        }, 250);
    }));
}

/**
 * 切换完成后更新内部跟踪状态
 */
function updateTrackingAfterSwitch() {
    _currentApiId = getCurrentApiId();
    _currentPresetName = getSelectedPresetName();

    const newPreset = getPresetSnapshot();
    _lastSavedHash = newPreset ? hashPreset(newPreset) : null;
    _dirty = false;
    _setStatus('idle');

    logger.debug(`Tracking updated: [${_currentApiId}] ${_currentPresetName} hash=${_lastSavedHash}`);
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
        suspended: Date.now() < _suspendUntil,
        stats: { ..._stats },
    };
}

/**
 * 重置最后保存的哈希（强制下次保存被认为有变化）。
 * 调试或修复"卡住"状态时使用。
 */
export function resetLastSavedHash() {
    _lastSavedHash = null;
    _dirty = false;
    logger.warn('lastSavedHash forcibly reset');
}

// =====================================================
// 卸载（供 onDelete hook 使用）
// =====================================================
export function teardown() {
    cancelPendingSave();
    unbindDOMListeners();
    unbindPromptManagerListeners();
    stopPolling();
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
