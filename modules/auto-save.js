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
    getPresetManager,
    savePresetSafe,
    syncPresetToMemory,
    toast,
    t,
} from './compatibility.js';
import { addSnapshot, deleteSnapshot, TRIGGER, hashPreset } from './history-store.js';
import { seedSnapshotForPreset } from './preset-takeover.js';

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
let _restoreInProgress = false;    // AL-1: 原子恢复操作进行中（抑制所有事件副作用）
let _dirty = false;                // 是否有未保存的修改
let _lastSavedHash = null;         // 最后保存的内容哈希
let _lastQuickFingerprint = null;  // 快速预检指纹（轻量级，避免每次做完整深拷贝+hash）
let _suspendUntil = 0;             // SETTINGS_UPDATED 风暴期间临时挂起，用 Date.now()
let _suspendNoticeShown = false;   // 在挂起期内只 log 一次，避免日志爆量
let _noChangeCount = 0;            // 连续无变化次数，用于日志降噪

let _currentApiId = null;          // 当前跟踪的 API
let _currentPresetName = null;     // 当前跟踪的预设名

// 容器级监听：只在 WATCH_SELECTORS 命中的元素上 bind input/change，
// 而不是在整个 document 捕获。聊天框、其他扩展的输入完全不进入热路径。
let _containerListeners = new Map();  // HTMLElement -> { input, change }
let _containerObserver = null;        // 监听容器出现 / 消失，自动重绑
let _containerRebindTimer = null;     // 节流定时器
let _settingUnsubscribe = null;       // 设置变更订阅
let _eventUnsubscribers = [];         // ST 事件订阅取消函数集合
let _promptObserver = null;           // Prompt Manager 区域 MutationObserver
let _pollingTimer = null;             // 兜底轮询计时器

// 诊断/统计
const _stats = {
    triggeredBySettingsUpdated: 0,
    triggeredByDOM: 0,
    triggeredByPrompt: 0,
    saved: 0,
    skippedUnchanged: 0,
    aborted: 0,
    switchGuardSaved: 0,    // switch_guard 真实保存次数（hash != lastSavedHash）
    switchGuardSkipped: 0,  // switch_guard 静默跳过次数（hash 一致 / 不脏）
};

// =====================================================
// 初始化
// =====================================================
export async function initAutoSave() {
    if (_initialized) {
        logger.warn('AutoSave already initialized, skipping duplicate init');
        return;
    }

    _initialized = true;
    _noChangeCount = 0;

    // 记录当前预设
    _currentApiId = getCurrentApiId();
    _currentPresetName = getSelectedPresetName();

    // 计算初始哈希（避免初次加载就触发保存）
    const initialPreset = getPresetSnapshot();
    if (initialPreset) {
        _lastSavedHash = hashPreset(initialPreset);
        _lastQuickFingerprint = _computeQuickFingerprint(_currentApiId);
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

    // 监听设置变更（动态启用/禁用 + polling 联动）
    _settingUnsubscribe = onSettingChange(({ key, newValue }) => {
        if (key === 'enabled') {
            applyEnabledState();
        } else if (key === 'fallbackPolling') {
            if (newValue) {
                if (_enabled) startPolling();
            } else {
                stopPolling();
            }
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
// 兜底轮询（默认关闭 / 仅作为应急兜底）
// 性能修复：原本 5 秒一次 hashPreset(getPresetSnapshot()) 会持续 CPU 工作；
// 在事件 + DOM 容器监听已覆盖所有路径的情况下，polling 实际几乎没用，
// 默认关闭，遇到诡异 ST 版本时再由 settings.fallbackPolling 手动启用。
// =====================================================
const POLLING_INTERVAL_MS = 15_000;            // 启用时的常规间隔
const POLLING_INACTIVE_THRESHOLD_MS = 60_000;  // 60秒无操作后降为低频
const POLLING_LOW_INTERVAL_MS = 60_000;        // 低频间隔
let _lastUserActivity = Date.now();
let _pollingMode = 'normal';                   // 'normal' | 'low'

function markUserActive() {
    _lastUserActivity = Date.now();
}

function startPolling() {
    if (_pollingTimer) return;
    // 默认关闭：只有用户在设置里显式开启 fallbackPolling 才启动
    if (!getSettings().fallbackPolling) return;

    const idle = Date.now() - _lastUserActivity > POLLING_INACTIVE_THRESHOLD_MS;
    const interval = idle ? POLLING_LOW_INTERVAL_MS : POLLING_INTERVAL_MS;
    _pollingMode = idle ? 'low' : 'normal';

    _pollingTimer = setInterval(() => {
        if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
        if (Date.now() < _suspendUntil) return;
        if (_debounceTimer) return;
        // 标签页不可见时跳过——节省后台 CPU
        if (typeof document !== 'undefined' && document.hidden) return;
        // 用户长时间无操作时直接跳过（不做 hash 计算）
        if (Date.now() - _lastUserActivity > POLLING_INACTIVE_THRESHOLD_MS) return;

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
    }, interval);
    logger.debug(`Polling started (interval=${interval}ms)`);
}

function stopPolling() {
    if (_pollingTimer) {
        clearInterval(_pollingTimer);
        _pollingTimer = null;
        logger.debug('Polling stopped');
    }
}

// =====================================================
// DOM 监听（容器级 - 不再全文档监听）
// =====================================================
/**
 * 关键性能修复：
 * 旧实现把 input/change 监听绑在 document 上（捕获阶段），
 * 用户在聊天框打字、其他扩展的任何输入都会进入热路径，
 * 每个 keystroke 都要跑 closest() 上溯到 body —— CPU 显著拉高。
 *
 * 新实现只在 WATCH_SELECTORS 命中的容器元素上绑定监听器，
 * 浏览器原生事件冒泡只会送达这些容器，完全不打扰其他元素。
 *
 * 容器在 SPA 中可能后加载/销毁，所以用 MutationObserver 在
 * #form_sheld（设置面板根）下监听新出现/消失的容器并自动重绑。
 */
function bindDOMListeners() {
    if (_containerListeners.size > 0) return;

    rebindContainers();

    // 容器观察器：监听 #form_sheld（设置面板根）下的子树变化
    // 当目标容器被插入/移除时增量更新绑定
    if (_containerObserver) return;
    const root = document.querySelector('#form_sheld') || document.body;
    try {
        _containerObserver = new MutationObserver(() => {
            // 节流：连续变化只触发一次重绑
            if (_containerRebindTimer) return;
            _containerRebindTimer = setTimeout(() => {
                _containerRebindTimer = null;
                rebindContainers();
            }, 300);
        });
        _containerObserver.observe(root, { childList: true, subtree: true });
    } catch (e) {
        logger.warn('Failed to attach container observer:', e);
    }

    logger.debug(`DOM listeners bound to ${_containerListeners.size} container(s)`);
}

/**
 * 扫描 WATCH_SELECTORS、将监听器绑到目标容器上（已绑过的跳过）。
 * 同时清理已经从 DOM 中移除的容器对应的旧监听记录。
 */
function rebindContainers() {
    const present = new Set();
    for (const selector of WATCH_SELECTORS) {
        let nodes;
        try { nodes = document.querySelectorAll(selector); } catch (_) { continue; }
        for (const node of nodes) {
            present.add(node);
            if (_containerListeners.has(node)) continue;
            const handlers = {
                input: (event) => onElementInput(event),
                change: (event) => onElementChange(event),
            };
            // 冒泡阶段（false）：成本低且足够触达
            node.addEventListener('input', handlers.input, false);
            node.addEventListener('change', handlers.change, false);
            _containerListeners.set(node, handlers);
        }
    }
    // 清理已经离开 DOM 的容器
    for (const [node, handlers] of _containerListeners) {
        if (!present.has(node) || !node.isConnected) {
            try {
                node.removeEventListener('input', handlers.input, false);
                node.removeEventListener('change', handlers.change, false);
            } catch (_) {}
            _containerListeners.delete(node);
        }
    }
}

function unbindDOMListeners() {
    for (const [node, handlers] of _containerListeners) {
        try {
            node.removeEventListener('input', handlers.input, false);
            node.removeEventListener('change', handlers.change, false);
        } catch (_) {}
    }
    _containerListeners.clear();

    if (_containerObserver) {
        try { _containerObserver.disconnect(); } catch (_) {}
        _containerObserver = null;
    }
    if (_containerRebindTimer) {
        clearTimeout(_containerRebindTimer);
        _containerRebindTimer = null;
    }
}

/**
 * 判断元素是否在我们关心的区域内（容器级监听后这只是双保险）
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
    if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
    if (!isElementWatchable(event.target)) return;

    const el = event.target;
    const settings = getSettings();

    markUserActive();
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
    if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
    if (!isElementWatchable(event.target)) return;

    const el = event.target;
    const settings = getSettings();

    markUserActive();
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
let _pmClickHandlerTarget = null;     // 当前 click handler 绑定的目标节点
function bindPromptManagerListeners() {
    if (_pmClickHandler || _promptObserver) return; // 幂等

    /**
     * 性能修复：把 click 委托从 document 上移到 #completion_prompt_manager 容器上。
     * 这样用户在聊天界面、其他扩展点击不会进入这个 handler。
     *
     * 同时**删除**了原来基于 attributes 的 MutationObserver——
     * 它每次 prompt 行 class 切换都触发，是可观察到的性能损耗，
     * 而且现在 click handler 已经覆盖了所有用户操作（toggle/add/delete）。
     * 仅保留 childList observer 来捕获 SortableJS 拖拽排序这种纯 DOM 操作。
     */
    const handler = (event) => {
        if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;

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
        const promptRow = target.closest('.completion_prompt_manager_prompt');
        if (promptRow) {
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

    // 优先绑到 PromptManager 容器；找不到时回落到 #form_sheld（设置面板根）
    const target = document.querySelector('#completion_prompt_manager')
        || document.querySelector('#form_sheld')
        || document.body;
    target.addEventListener('click', handler, false);
    _pmClickHandler = handler;
    _pmClickHandlerTarget = target;

    // MutationObserver：仅监听 childList（拖拽排序 / 删除条目），
    // 不监听 attributes（class 切换走 click handler 已覆盖，attributes
    // observer 在 prompt 列表频繁 hover/选中时会被疯狂触发，是发热元凶之一）
    //
    // 性能优化：双层节流
    //   1. _pmMutationPending（microtask 级）：同一 tick 内的多个 mutation 合并
    //   2. _pmMutationThrottleUntil（时间窗口级）：500ms 内的多批 mutation 合并
    //   一次用户操作（如 toggle prompt）会产生 4-8 个分散在几百毫秒内的 mutation，
    //   不加时间窗口的话每批都会触发 scheduleAutoSave → doSave → 完整深拷贝+hash。
    let _pmMutationPending = false;
    let _pmMutationThrottleUntil = 0;
    const PM_MUTATION_THROTTLE_MS = 500;
    try {
        _promptObserver = new MutationObserver((mutations) => {
            if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
            if (_pmMutationPending) return;

            // 快速过滤：只关心新增/删除节点
            let hasChild = false;
            for (const m of mutations) {
                if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                    hasChild = true;
                    break;
                }
            }
            if (!hasChild) return;

            // 时间窗口节流：500ms 内只触发一次
            const now = Date.now();
            if (now < _pmMutationThrottleUntil) return;
            _pmMutationThrottleUntil = now + PM_MUTATION_THROTTLE_MS;

            // 节流：同一 tick 内多个 mutation 合并为一次
            _pmMutationPending = true;
            queueMicrotask(() => {
                _pmMutationPending = false;
                if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
                _stats.triggeredByPrompt++;
                logger.debug('[PromptManager] DOM childList mutation');
                scheduleAutoSave(getSettings().debounceMs, 'prompt-mutation');
            });
        });

        const tryAttach = () => {
            for (const sel of PROMPT_MANAGER_SELECTORS) {
                const node = document.querySelector(sel);
                if (node) {
                    _promptObserver.observe(node, {
                        childList: true,
                        subtree: true,
                        // attributes: false  ← 关键：去掉，避免高频触发
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
    if (_pmClickHandler && _pmClickHandlerTarget) {
        try { _pmClickHandlerTarget.removeEventListener('click', _pmClickHandler, false); } catch (_) {}
        _pmClickHandler = null;
        _pmClickHandlerTarget = null;
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
    // 切换中 / 内部保存中 / 未启用 / 原子恢复中 -> 静默忽略
    if (!_enabled) return;
    if (_restoreInProgress) return;
    if (_ignoreInput) {
        // 静默忽略：切换期间这条会爆量，没有诊断价值
        return;
    }
    if (_isInternalSave) {
        // 静默忽略：保存进行中
        return;
    }

    const settings = getSettings();
    if (!settings.enabled) return;

    // SETTINGS_UPDATED 风暴期间挂起 —— 第一次报告即可，后续静默
    if (Date.now() < _suspendUntil) {
        if (!_suspendNoticeShown) {
            _suspendNoticeShown = true;
            logger.debug(`scheduleAutoSave suspended (reason=${reason}, ${_suspendUntil - Date.now()}ms)`);
        }
        return;
    }
    // 离开挂起窗口后重置
    _suspendNoticeShown = false;

    const ms = delay ?? settings.debounceMs;

    clearTimeout(_debounceTimer);
    _dirty = true;
    _setStatus('pending');

    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        // 二次防御：debounce 等待期间可能进入了切换状态
        if (_ignoreInput || Date.now() < _suspendUntil) {
            logger.debug(`Scheduled save aborted at fire-time (reason=${reason}, ignoreInput=${_ignoreInput}, suspended=${Date.now() < _suspendUntil})`);
            _dirty = false;
            _setStatus('idle');
            return;
        }
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
const SAVE_TIMEOUT_MS = 15_000;  // 单次保存最大允许时长，超时强制释放锁
let _saveStartedAt = 0;
let _saveTimeoutId = null;

/**
 * 检查保存前置条件（锁、挂起窗口等）
 * @param {string} reason 触发原因（用于日志）
 * @param {object|null} explicitTarget 显式目标（switch-guard 场景）
 * @returns {boolean} true = 可以继续保存, false = 应中止
 */
function _validateSaveConditions(reason, explicitTarget) {
    if (_isInternalSave) {
        // 自愈：检测是否长时间被卡住
        const stuck = _saveStartedAt && (Date.now() - _saveStartedAt > SAVE_TIMEOUT_MS);
        if (stuck) {
            logger.warn(
                `Save lock stuck for ${Date.now() - _saveStartedAt}ms, forcibly releasing`
            );
            _isInternalSave = false;
            _saveStartedAt = 0;
            if (_saveTimeoutId) {
                clearTimeout(_saveTimeoutId);
                _saveTimeoutId = null;
            }
            // 让本次也跳过；下次调度会重新触发
            _stats.aborted++;
            return false;
        }
        logger.debug('Save skipped (internal save in progress)');
        _stats.aborted++;
        return false;
    }

    // 入口防御：切换沉默期内只允许 explicitTarget 路径（switch-guard）
    if (!explicitTarget && (_ignoreInput || Date.now() < _suspendUntil)) {
        logger.debug(
            `doSave aborted: in switch suspend window (reason=${reason}, ignoreInput=${_ignoreInput}, suspended=${Date.now() < _suspendUntil})`
        );
        _stats.aborted++;
        return false;
    }

    return true;
}

/**
 * 构建保存数据：解析目标预设、获取快照、计算哈希并验证
 * @param {string} reason 触发原因（用于日志）
 * @param {object|null} explicitTarget 显式目标（switch-guard 场景）
 * @returns {{ apiId: string, presetName: string, preset: object, newHash: string, fingerprint: string, fieldCount: number, promptCount: number, promptOrderCount: number } | null}
 *   返回 null 表示不需要保存（无变化/异常/切换中）
 */
function _buildSavePayload(reason, explicitTarget) {
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
        _lastQuickFingerprint = null;
        _dirty = false;
        _setStatus('idle');
        _stats.aborted++;
        return null;
    }

    // 性能优化：快速预检（避免昂贵的深拷贝 + 完整序列化 hash）
    // 直接从 ST 内存的 live 引用读取几个关键属性构建轻量级指纹，
    // 与上次保存时的指纹比较。如果完全一致则大概率没有变化，
    // 可以跳过 getPresetSnapshot()（structuredClone ~94KB）和 hashPreset()（递归序列化）。
    // 仅在非 switch-guard 的常规保存中使用（switch-guard 必须保证完整性）。
    if (!explicitTarget && _lastSavedHash && _lastQuickFingerprint) {
        const qfp = _computeQuickFingerprint(apiId);
        if (qfp && qfp === _lastQuickFingerprint) {
            _noChangeCount++;
            if (_noChangeCount <= 3 || _noChangeCount % 20 === 0) {
                logger.debug(
                    `[doSave] No change (quick-check) reason=${reason} (×${_noChangeCount} consecutive)`
                );
            }
            _stats.skippedUnchanged++;
            _dirty = false;
            _setStatus('idle');
            return null;
        }
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
        // 仅在前 3 次相同 hash 内打日志，超出后采样降噪
        _noChangeCount++;
        if (_noChangeCount <= 3 || _noChangeCount % 20 === 0) {
            logger.debug(
                `[doSave] No change reason=${reason} hash=${newHash} (×${_noChangeCount} consecutive)`
            );
        }
        _stats.skippedUnchanged++;
        _dirty = false;
        _setStatus('idle');
        return null;
    }
    // 重置无变化计数器
    _noChangeCount = 0;

    return { apiId, presetName, preset, newHash, fingerprint, fieldCount, promptCount, promptOrderCount };
}

async function doSave(trigger = TRIGGER.AUTO, reason = '', explicitTarget = null) {
    if (!_validateSaveConditions(reason, explicitTarget)) {
        return null;
    }

    _isInternalSave = true;
    _saveStartedAt = Date.now();
    _setStatus('saving');

    // 超时保护：如果 15 秒内还没完成，强制重置锁防止永久卡死
    _saveTimeoutId = setTimeout(() => {
        if (_isInternalSave && Date.now() - _saveStartedAt >= SAVE_TIMEOUT_MS) {
            logger.error(
                `Save took >${SAVE_TIMEOUT_MS}ms (reason=${reason}), forcibly releasing lock`
            );
            _isInternalSave = false;
            _saveStartedAt = 0;
            _setStatus('error');
            _stats.aborted++;
        }
    }, SAVE_TIMEOUT_MS);

    try {
        // 让出一个微任务，确保上层（PromptManager / oai_settings 同步）已完成
        await new Promise(resolve => setTimeout(resolve, 0));

        const payload = _buildSavePayload(reason, explicitTarget);
        if (!payload) return null;

        const { apiId, presetName, preset, newHash, fingerprint, fieldCount, promptCount, promptOrderCount } = payload;

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

        // 写入磁盘（skipUpdate:true — 不触发 ST UI 重载，避免 PromptManager DOM 重建导致的性能开销）
        try {
            await savePresetSafe(presetName, preset, { skipUpdate: true, apiId });
        } catch (diskErr) {
            logger.error('[doSave] savePresetSafe failed, rolling back snapshot:', diskErr);
            try {
                await deleteSnapshot(snapshot.id, { force: true });
                logger.info(`[doSave] Rolled back snapshot ${snapshot.id} after disk write failure`);
            } catch (rollbackErr) {
                logger.error('[doSave] Snapshot rollback also failed:', rollbackErr);
            }
            throw diskErr; // 重新抛出，让外层 catch 处理状态 & toast
        }

        // 同步 ST 内存中的 presets[] 数组（零开销 — 仅对象属性赋值，无 DOM/事件触发）。
        // 这确保用户通过原生列表或托管列表切换预设时，ST 从 presets[] 加载的是最新保存的版本，
        // 而非初始导入时的旧版本。不同步的话切换预设会导致用户修改丢失。
        syncPresetToMemory(presetName, preset, apiId);

        _lastSavedHash = snapshot.hash;
        _lastQuickFingerprint = _computeQuickFingerprint(apiId);
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
        _saveStartedAt = 0;
        if (_saveTimeoutId) {
            clearTimeout(_saveTimeoutId);
            _saveTimeoutId = null;
        }
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
 *
 * 注：getPresetSnapshot → sanitizePresetForExport 已在源头过滤了所有
 * 非预设字段（模型/API/Key 等），传入的 preset 已经是干净数据，
 * 无需再做 MODEL_API_KEY_FIELDS 条件分支。
 */
function computeFingerprint(preset) {
    if (!preset) return '(empty)';
    const fp = {};
    const watchKeys = [
        // 核心采样参数（oai_settings / textgen_settings 中最常被用户修改的字段）
        'temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty',
        'temp', 'rep_pen', 'min_p', 'top_a', 'typical_p',
        // token 限制（非常常见的修改项）
        'openai_max_tokens', 'openai_max_context', 'max_tokens', 'max_length',
        // 流式 & 功能开关
        'streaming', 'stream_response', 'seed',
        'wrap_in_quotes', 'wi_format', 'show_external_links',
        'function_calling', 'request_images',
        'reasoning_effort', 'show_thoughts',
        // 角色行为 / Character Behavior 栏目
        'names_behavior', 'continue_prefill', 'continue_postfix',
        'squash_system_messages', 'assistant_prefill', 'assistant_impersonation',
        'use_sysprompt', 'media_inlining', 'inline_image_quality',
        'enable_web_search', 'send_if_empty', 'verbosity',
        'request_image_aspect_ratio', 'request_image_resolution',
        // 预设标识
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

/**
 * 快速预检指纹：直接从 ST 内存的 live 引用（不深拷贝）读取关键属性，
 * 构建一个轻量级字符串。用于 _buildSavePayload 中在昂贵的 getPresetSnapshot + hashPreset
 * 之前快速判断"是否大概率没有变化"。
 *
 * 覆盖范围：
 *   - 标量字段（temperature、top_p 等用户常改的参数）
 *   - prompts 数组长度 + 每个 prompt 的 enabled/marker 状态
 *   - prompt_order 数组长度 + 每个 order entry 的 enabled 状态
 *
 * 开销：仅遍历 live 对象的顶层属性 + prompts/prompt_order 的长度和少量字段，
 * 不做深拷贝、不做递归序列化。约为 getPresetSnapshot + hashPreset 的 1/100。
 *
 * @param {string} apiId
 * @returns {string|null} 指纹字符串，null 表示无法计算（应 fallback 到完整检查）
 */
function _computeQuickFingerprint(apiId) {
    try {
        const pm = getPresetManager(apiId);
        if (!pm || typeof pm.getPresetList !== 'function') return null;
        const list = pm.getPresetList(apiId);
        const live = list?.settings;
        if (!live || typeof live !== 'object') return null;

        // 采样关键标量字段
        const parts = [];
        const scalarKeys = [
            'temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty',
            'min_p', 'top_a', 'openai_max_tokens', 'openai_max_context', 'seed',
            'streaming', 'function_calling', 'reasoning_effort', 'show_thoughts',
            'names_behavior', 'squash_system_messages', 'use_sysprompt',
            'wi_format', 'send_if_empty',
        ];
        for (const k of scalarKeys) {
            if (k in live) parts.push(k + '=' + live[k]);
        }

        // prompts 数组：长度 + 每个 prompt 的 identifier+enabled+content长度
        // content 长度变化检测：用户修改 prompt 文本时 identifier/enabled 不变，
        // 但 content 长度一定会变（即使长度相同也是极小概率的假阴性，
        // 后续完整 hash 仍会在下一个 trigger 中捕获）。
        if (Array.isArray(live.prompts)) {
            parts.push('p#' + live.prompts.length);
            for (let i = 0; i < live.prompts.length; i++) {
                const p = live.prompts[i];
                if (p) {
                    const cLen = typeof p.content === 'string' ? p.content.length : 0;
                    parts.push(i + ':' + (p.identifier || '') + (p.enabled ? '1' : '0') + '/' + cLen);
                }
            }
        }

        // prompt_order：长度 + 每个 entry 的 identifier+enabled
        if (Array.isArray(live.prompt_order) && live.prompt_order[0]?.order) {
            const order = live.prompt_order[0].order;
            parts.push('o#' + order.length);
            for (let i = 0; i < order.length; i++) {
                const o = order[i];
                if (o) parts.push(i + ':' + (o.identifier || '') + (o.enabled ? '1' : '0'));
            }
        }

        return parts.join('|');
    } catch (e) {
        return null;
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
    // 防止重复绑定：先清理已有的事件订阅
    if (_eventUnsubscribers.length > 0) {
        logger.warn(`bindPresetEvents: clearing ${_eventUnsubscribers.length} existing subscriptions before re-binding`);
        for (const unsub of _eventUnsubscribers) {
            try { typeof unsub === 'function' && unsub(); } catch (_) {}
        }
        _eventUnsubscribers = [];
    }

    // ----- SETTINGS_UPDATED：所有内部 state 变化的可靠信号 -----
    const settingsUpdated = getEventType('SETTINGS_UPDATED', 'settings_updated');
    _eventUnsubscribers.push(on(settingsUpdated, () => {
        if (!_enabled || _ignoreInput || _isInternalSave || _restoreInProgress) return;
        if (Date.now() < _suspendUntil) return;
        _stats.triggeredBySettingsUpdated++;
        logger.debug('[ST event] SETTINGS_UPDATED');
        // SETTINGS_UPDATED 是 ST 已经更新完内存后发的，不需要再让出微任务
        scheduleAutoSave(getSettings().debounceMs, 'settings_updated');
    }));

    // ----- OpenAI 专属切换前事件（最可靠的保护点）-----
    //
    // 设计理念：switch_guard 是"兜底保护"，不是"必须执行"。
    //   1. 先看是否真的有未保存修改：用真实 hash 比较，而非 _dirty 标志
    //      （_dirty 仅表示"有过 input 事件"，但内容可能已被普通自动保存兜底了）
    //   2. 只有 hash != lastSavedHash 才需要 switch_guard 保存
    //   3. 否则只设置 ignoreInput 跳过即可（高频切换场景几乎不写盘）
    const oaiBefore = getEventType('OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before');
    _eventUnsubscribers.push(on(oaiBefore, async () => {
        if (_restoreInProgress) return; // AL-1: 恢复期间不做 switch guard
        if (!getSettings().enableSwitchGuard) {
            setIgnoreInput(true);
            return;
        }

        try {
            setIgnoreInput(true);

            // 第一步：基础前置检查
            if (!_currentPresetName || !_currentApiId) {
                logger.debug('Switch guard skipped: no tracked preset');
                return;
            }
            // 第二步：检查是否有真实变更
            //   - 没有 _dirty 也没有 _debounceTimer => 完全空闲，无需保护
            //   - 有 _dirty/_debounceTimer 才进一步算 hash
            if (!_dirty && !_debounceTimer) {
                _stats.switchGuardSkipped++;
                logger.debug('Switch guard skipped: not dirty, no pending save');
                return;
            }
            // 第三步：用真实 hash 判断"内容是否真变了"
            //   防止自动保存已经把内容写盘但 _dirty 还没复位的边缘情况
            //   （正常情况：doSave 完成后 _dirty=false，hash 相等就跳过）
            const preset = getPresetSnapshot(_currentPresetName);
            if (!preset) {
                logger.warn('Switch guard: cannot read preset snapshot, falling back to save');
                cancelPendingSave();
                await doSave(TRIGGER.SWITCH_GUARD, 'switch-guard', {
                    apiId: _currentApiId,
                    presetName: _currentPresetName,
                });
                return;
            }
            const liveHash = hashPreset(preset);
            if (_lastSavedHash && liveHash === _lastSavedHash) {
                // 内容跟上次保存一致：取消未触发的 debounce，纯跳过
                _stats.switchGuardSkipped++;
                cancelPendingSave();
                _dirty = false;
                logger.debug(`Switch guard skipped: hash unchanged (${liveHash})`);
                return;
            }

            // 第四步：真的有未保存修改，触发兜底保存
            _stats.switchGuardSaved++;
            logger.info(`Switch guard: saving dirty preset "${_currentPresetName}" before switch (${_lastSavedHash || 'null'} -> ${liveHash})`);
            cancelPendingSave();
            await doSave(TRIGGER.SWITCH_GUARD, 'switch-guard', {
                apiId: _currentApiId,
                presetName: _currentPresetName,
            });
        } catch (e) {
            logger.error('Switch guard error:', e);
        }
    }));

    // ----- OpenAI 切换后事件 -----
    const oaiAfter = getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after');
    _eventUnsubscribers.push(on(oaiAfter, () => {
        if (_restoreInProgress) return; // AL-1: 恢复期间跳过切换后逻辑
        // 切换 → 大量 SETTINGS_UPDATED + DOM mutation
        // 实测 ST 可能持续 2-3 秒触发各种事件，因此把窗口加大到 4 秒
        _suspendUntil = Date.now() + SUSPEND_AFTER_SWITCH_MS;
        cancelPendingSave();
        setIgnoreInput(true, IGNORE_INPUT_AFTER_SWITCH_MS + 500);
        // 1) 早一点把"跟踪状态"指向新预设（避免下一次 doSave 比较错对象）
        setTimeout(() => {
            updateTrackingAfterSwitch();
        }, 200);
        // 2) 晚一点解锁 ignoreInput，避免切换尾部的 mutation 被当成用户输入
        setTimeout(() => {
            setIgnoreInput(false);
        }, IGNORE_INPUT_AFTER_SWITCH_MS);
    }));

    // ----- 通用预设切换事件（适用于所有 API）-----
    const presetChanged = getEventType('PRESET_CHANGED', 'preset_changed');
    _eventUnsubscribers.push(on(presetChanged, async (data) => {
        if (_restoreInProgress) return; // AL-1: 恢复期间跳过预设切换逻辑
        cancelPendingSave();
        setIgnoreInput(true, IGNORE_INPUT_AFTER_SWITCH_MS + 500);
        _suspendUntil = Date.now() + SUSPEND_AFTER_SWITCH_MS;

        if (data) {
            if (data.apiId) _currentApiId = data.apiId;
            if (data.name) _currentPresetName = data.name;
        }

        setTimeout(() => {
            updateTrackingAfterSwitch();
        }, 250);
        setTimeout(() => {
            setIgnoreInput(false);
        }, IGNORE_INPUT_AFTER_SWITCH_MS);
    }));

    // ----- 主 API 切换 -----
    const mainApiChanged = getEventType('MAIN_API_CHANGED', 'main_api_changed');
    _eventUnsubscribers.push(on(mainApiChanged, () => {
        if (_restoreInProgress) return; // AL-1: 恢复期间跳过 API 切换逻辑
        cancelPendingSave();
        setIgnoreInput(true, IGNORE_INPUT_AFTER_SWITCH_MS + 500);
        _suspendUntil = Date.now() + SUSPEND_AFTER_SWITCH_MS;

        setTimeout(() => {
            updateTrackingAfterSwitch();
        }, 250);
        setTimeout(() => {
            setIgnoreInput(false);
        }, IGNORE_INPUT_AFTER_SWITCH_MS);
    }));
}

// 切换预设后的"沉默期"窗口
// _suspendUntil: scheduleAutoSave 期间内拒绝新调度
// _ignoreInput:  DOM/MutationObserver 事件直接忽略
// 之所以这么长，是因为 ST 切换预设时会触发大量 DOM 重绘 + SETTINGS_UPDATED 风暴，
// 实测从切换瞬间到完全平静约需 2-3 秒
const SUSPEND_AFTER_SWITCH_MS = 4000;
const IGNORE_INPUT_AFTER_SWITCH_MS = 2500;

/**
 * 切换完成后更新内部跟踪状态
 *
 * 注意：在 ST 中，OAI_PRESET_CHANGED_AFTER 之后通常还会触发通用 PRESET_CHANGED，
 * 两者都会进入这里。如果两次结果一致，就跳过第二次（保持 idle）。
 */
function updateTrackingAfterSwitch() {
    const newApiId = getCurrentApiId();
    const newPresetName = getSelectedPresetName();
    const newPreset = getPresetSnapshot();
    const newHash = newPreset ? hashPreset(newPreset) : null;

    // 去重：相同 (apiId, name, hash) 在短时间内重复进来直接 return
    if (
        newApiId === _currentApiId
        && newPresetName === _currentPresetName
        && newHash === _lastSavedHash
        && !_dirty
    ) {
        return;
    }

    _currentApiId = newApiId;
    _currentPresetName = newPresetName;
    _lastSavedHash = newHash;
    _lastQuickFingerprint = _computeQuickFingerprint(newApiId);
    _dirty = false;
    _setStatus('idle');

    logger.debug(`Tracking updated: [${_currentApiId}] ${_currentPresetName} hash=${_lastSavedHash}`);

    // V-1: 首次切换到没有快照的预设时，自动创建初始快照
    if (newApiId && newPresetName) {
        seedSnapshotForPreset(newPresetName, newApiId).catch(e => {
            logger.debug(`[AutoSave] seed-on-switch failed for "${newPresetName}":`, e);
        });
    }
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
    _lastQuickFingerprint = null;
    _dirty = false;
    logger.warn('lastSavedHash forcibly reset');
}

/**
 * AL-1: 开始原子恢复操作。
 * 在此期间，所有自动保存事件处理器（SETTINGS_UPDATED、preset_changed、
 * OAI_PRESET_CHANGED_BEFORE/AFTER、DOM input/change、MAIN_API_CHANGED）
 * 均被完全屏蔽，不会产生任何副作用。
 *
 * 调用者必须确保在操作完成后调用 endAtomicRestore()。
 * 内置 10 秒超时自愈，防止异常导致永久卡住。
 */
let _restoreAutoResetTimer = null;
const RESTORE_TIMEOUT_MS = 10_000;

export function beginAtomicRestore() {
    _restoreInProgress = true;
    cancelPendingSave();
    setIgnoreInput(true, RESTORE_TIMEOUT_MS + 1000);

    // 超时自愈
    if (_restoreAutoResetTimer) clearTimeout(_restoreAutoResetTimer);
    _restoreAutoResetTimer = setTimeout(() => {
        if (_restoreInProgress) {
            logger.warn('Atomic restore auto-reset after timeout');
            endAtomicRestore(null);
        }
    }, RESTORE_TIMEOUT_MS);

    logger.debug('Atomic restore started — all event handlers suppressed');
}

/**
 * AL-1: 结束原子恢复操作，恢复正常事件处理。
 *
 * @param {string|null} hash - 恢复后预设的指纹哈希。
 *   传入具体 hash 值：将 _lastSavedHash 设为该值，表示"恢复后的状态就是已保存状态"
 *   传入 null：回退到 resetLastSavedHash 行为（强制下次认为有变化）
 * @param {object} [tracking] - 可选的跟踪信息更新
 * @param {string} [tracking.apiId] - 新的 API ID
 * @param {string} [tracking.presetName] - 新的预设名
 */
export function endAtomicRestore(hash, tracking = null) {
    if (_restoreAutoResetTimer) {
        clearTimeout(_restoreAutoResetTimer);
        _restoreAutoResetTimer = null;
    }

    // 更新跟踪信息
    if (tracking) {
        if (tracking.apiId) _currentApiId = tracking.apiId;
        if (tracking.presetName) _currentPresetName = tracking.presetName;
    }

    // 设置 hash：传入具体值表示"已保存"，null 表示强制下次变化
    if (hash !== null && hash !== undefined) {
        _lastSavedHash = hash;
        _lastQuickFingerprint = _computeQuickFingerprint(_currentApiId);
        logger.debug(`Atomic restore ended — hash set to ${hash}`);
    } else {
        _lastSavedHash = null;
        _lastQuickFingerprint = null;
        logger.debug('Atomic restore ended — hash reset to null');
    }

    _dirty = false;
    _restoreInProgress = false;

    // AM-0 P1b: 恢复后 2 秒抑制窗口，防止 PromptManager DOM 变化触发 doSave
    // savePresetSafe(skipUpdate:false) 会让 ST 重新加载预设数据到 UI，
    // PromptManager 重建 DOM 子树的 childList mutations 在此后数百毫秒内才完成。
    // 与 OAI_PRESET_CHANGED_AFTER 的处理模式一致（参见 bindPresetEvents）。
    const POST_RESTORE_SUSPEND_MS = 2000;
    _suspendUntil = Date.now() + POST_RESTORE_SUSPEND_MS;
    setIgnoreInput(true, POST_RESTORE_SUSPEND_MS + 500);
    setTimeout(() => {
        setIgnoreInput(false);
    }, POST_RESTORE_SUSPEND_MS);

    _setStatus('idle');

    logger.debug('Atomic restore completed — event handlers resumed, 2s suppress window active');
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
    _restoreInProgress = false;
    if (_restoreAutoResetTimer) {
        clearTimeout(_restoreAutoResetTimer);
        _restoreAutoResetTimer = null;
    }
    logger.info('AutoSave torn down');
}
