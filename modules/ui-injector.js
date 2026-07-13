/**
 * SillyTavern Preset Auto Save - UI Injector
 * 负责将历史按钮、状态指示器注入到预设栏
 *
 * 关键策略:
 *   1. 监听所有 select[data-preset-manager-for] 自动适配多种 API
 *   2. 多重保障：APP_INITIALIZED 立即注入 + 事件触发重注入 + MutationObserver 兜底 + 定时检查
 *   3. 注入位置: 历史按钮在最右边，状态点在select左侧
 */

import { logger } from './logger.js';
import { getSettings, onSettingChange } from './settings.js';
import { on, getEventType, t } from './compatibility.js';
import { registerStatusSetter } from './auto-save.js';
import { RuntimeTimerRegistry } from './core/runtime-timers.js';
import {
    applyStatusIndicatorPresentation,
    applyStatusIndicatorState,
    STATUS_INDICATOR_STATES,
} from './core/status-indicator.js';
import { getSaveStatus, saveStatusLabelKey, setSaveStatus } from './core/save-status.js';

// =====================================================
// 常量
// =====================================================
const HISTORY_BTN_CLASS = 'pas-history-btn';
const STATUS_DOT_CLASS = 'pas-status-dot';
const HISTORY_BTN_ID_PREFIX = 'pas_history_btn_';
const STATUS_DOT_ID_PREFIX = 'pas_status_dot_';

function statusLabel(state) {
    return t(saveStatusLabelKey(state));
}

// =====================================================
// 状态
// =====================================================
let _onHistoryClick = null;
let _observer = null;
let _injectScheduled = false;
let _statusResetTimer = null;
let _intervalId = null;
let _initialized = false;
let _settingUnsubscribe = null;
let _eventUnsubscribers = [];
const _runtimeTimers = new RuntimeTimerRegistry();

// =====================================================
// 初始化
// =====================================================
/**
 * 初始化 UI 注入
 * @param {Function} onHistoryClick 历史按钮点击回调
 */
export async function initUIInjector(onHistoryClick) {
    if (_initialized) return;

    _onHistoryClick = typeof onHistoryClick === 'function' ? onHistoryClick : null;

    // 注册状态设置器到 auto-save
    registerStatusSetter(setStatusDot);

    // 监听设置变化
    _settingUnsubscribe = onSettingChange(({ key }) => {
        if (key === 'showStatusIndicator') {
            updateStatusDotVisibility();
        }
    });

    // 立即注入
    scheduleInject();

    // 监听切换事件
    setupEventListeners();

    // MutationObserver 兜底
    setupObserver();

    // 定时检查兜底：仅前 30 秒每 2 秒查一次，30 秒后熄灭
    //   - MutationObserver 已经覆盖大多数情况
    //   - 这个 interval 仅用来兜底"页面早期 ST 还在加载"的极端场景
    //   - 30 秒后大概率早就注入完成；此后由 MutationObserver 接管
    let _earlyInjectChecks = 0;
    _intervalId = _runtimeTimers.repeat(() => {
        _earlyInjectChecks++;
        if (hasInjected() || _earlyInjectChecks > 15) {
            _runtimeTimers.cancel(_intervalId);
            _intervalId = null;
            return;
        }
        scheduleInject();
    }, 2000);

    _initialized = true;
    logger.success('UI injector ready');
}

// =====================================================
// 注入调度（节流）
// =====================================================
function scheduleInject() {
    if (_injectScheduled) return;
    _injectScheduled = true;

    _runtimeTimers.schedule(() => {
        _injectScheduled = false;
        try {
            injectAll();
        } catch (e) {
            logger.error('Injection failed:', e);
        }
    }, 100);
}

function injectAll() {
    injectHistoryButtons();
    injectStatusDots();
    syncStatusIndicators(getSaveStatus());
    updateStatusDotVisibility();
}

function hasInjected() {
    return !!document.querySelector(`.${HISTORY_BTN_CLASS}`);
}

// =====================================================
// 历史按钮注入
// =====================================================
function injectHistoryButtons() {
    let selects;
    try {
        selects = document.querySelectorAll('select[data-preset-manager-for]');
    } catch (_) {
        return;
    }

    for (const select of selects) {
        // 防御：select 已被脱离 DOM
        if (!select || !select.isConnected) continue;

        const apiIds = (select.getAttribute('data-preset-manager-for') || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const apiId = apiIds[0] || 'openai';

        const btnId = HISTORY_BTN_ID_PREFIX + apiId;
        if (document.getElementById(btnId)) continue;

        // 寻找合适的注入容器（应该是包含其他按钮的栏目）
        const container = findInjectionContainer(select);
        if (!container) {
            logger.debug(`No suitable container for: ${apiId}`);
            continue;
        }

        try {
            const btn = createHistoryButton(apiId, btnId);
            container.appendChild(btn);
            logger.debug(`History button injected: [${apiId}]`);
        } catch (e) {
            logger.warn(`Failed to inject history button for ${apiId}:`, e);
        }
    }
}

/**
 * 寻找合适的注入容器
 * 策略：select 的父元素必须包含其他按钮（menu_button），否则向上查找
 */
function findInjectionContainer(select) {
    let container = select.parentElement;
    if (!container) return null;

    // 检查父元素是否包含其他按钮
    if (container.querySelector('.menu_button, button[type="button"]')) {
        return container;
    }

    // 向上查找一层
    container = container.parentElement;
    if (container && container.querySelector('.menu_button')) {
        return container;
    }

    // 兜底：返回 select 的直接父元素
    return select.parentElement;
}

function createHistoryButton(apiId, btnId) {
    const btn = document.createElement('div');
    btn.id = btnId;
    btn.className = `menu_button menu_button_icon fa-solid fa-clock-rotate-left ${HISTORY_BTN_CLASS}`;
    btn.title = t('History Button Title');
    btn.setAttribute('data-pas-element', 'history-btn');
    btn.setAttribute('data-api-id', apiId);
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', t('History Button Title'));

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (_onHistoryClick) {
            try {
                _onHistoryClick(apiId);
            } catch (err) {
                logger.error('History click handler error:', err);
            }
        }
    });

    // 键盘可访问
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            btn.click();
        }
    });

    return btn;
}

// =====================================================
// 状态指示器注入
// =====================================================
function injectStatusDots() {
    let selects;
    try {
        selects = document.querySelectorAll('select[data-preset-manager-for]');
    } catch (_) {
        return;
    }

    for (const select of selects) {
        // 防御：select 已脱离 DOM 或父节点不存在
        if (!select || !select.isConnected || !select.parentNode) continue;

        const apiIds = (select.getAttribute('data-preset-manager-for') || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const apiId = apiIds[0] || 'openai';

        const dotId = STATUS_DOT_ID_PREFIX + apiId;
        if (document.getElementById(dotId)) continue;

        try {
            const dot = createStatusDot(apiId, dotId);
            // 插入到 select 之前
            select.parentNode.insertBefore(dot, select);
            logger.debug(`Status dot injected: [${apiId}]`);
        } catch (e) {
            logger.warn(`Failed to inject status dot for ${apiId}:`, e);
        }
    }
}

function createStatusDot(apiId, dotId) {
    const dot = document.createElement('span');
    dot.id = dotId;
    dot.className = STATUS_DOT_CLASS;
    dot.setAttribute('data-pas-element', 'status-dot');
    dot.setAttribute('data-api-id', apiId);
    dot.setAttribute('role', 'status');
    dot.setAttribute('aria-live', 'polite');
    const state = getSaveStatus();
    applyStatusIndicatorState(dot, state, statusLabel(state));
    return dot;
}

function updateStatusDotVisibility() {
    const show = getSettings().showStatusIndicator;
    const dots = document.querySelectorAll(`.${STATUS_DOT_CLASS}`);
    for (const dot of dots) {
        dot.style.display = show ? '' : 'none';
    }
}

// =====================================================
// 状态切换（供 auto-save 调用）
// =====================================================
export function setStatusDot(state) {
    if (!STATUS_INDICATOR_STATES.includes(state) || !setSaveStatus(state)) return;

    syncStatusIndicators(state);

    // saved/error 状态自动恢复 idle
    if (_statusResetTimer) _runtimeTimers.cancel(_statusResetTimer);
    if (state === 'saved') {
        _statusResetTimer = _runtimeTimers.schedule(() => setStatusDot('idle'), 2000);
    } else if (state === 'error') {
        _statusResetTimer = _runtimeTimers.schedule(() => setStatusDot('idle'), 4000);
    }
}

function syncStatusIndicators(state) {
    const label = statusLabel(state);
    const dots = document.querySelectorAll(`.${STATUS_DOT_CLASS}`);
    for (const dot of dots) {
        applyStatusIndicatorPresentation(dot, state, label);
    }
}

// =====================================================
// 事件监听 - 切换/加载后重新注入
// =====================================================
function setupEventListeners() {
    // 幂等保护：先清理已有订阅，防止重复绑定
    if (_eventUnsubscribers.length > 0) {
        for (const unsub of _eventUnsubscribers) {
            try { typeof unsub === 'function' && unsub(); } catch (_) {}
        }
        _eventUnsubscribers = [];
    }

    const events = [
        'OAI_PRESET_CHANGED_AFTER',
        'PRESET_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'MAIN_API_CHANGED',
        'APP_READY',
        'SETTINGS_UPDATED',
    ];

    for (const evtName of events) {
        const evt = getEventType(evtName, evtName.toLowerCase());
        const unsub = on(evt, () => {
            _runtimeTimers.schedule(scheduleInject, 100);
        });
        if (typeof unsub === 'function') {
            _eventUnsubscribers.push(unsub);
        }
    }
}

// =====================================================
// MutationObserver 兜底
// =====================================================
function setupObserver() {
    if (_observer) return;

    let pending = false;

    // ST 切换 API 时会一次性产生几十条 mutation；这里只做一次轻量检查
    _observer = new MutationObserver((mutations) => {
        if (pending) return;
        // 快速过滤：只关心新增/删除节点，且数量不为 0
        let relevant = false;
        for (const m of mutations) {
            if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                relevant = true;
                break;
            }
        }
        if (!relevant) return;

        pending = true;
        _runtimeTimers.schedule(() => {
            pending = false;
            // 仅在按钮丢失时才重新注入（避免无意义的工作）
            if (!hasInjected()) {
                scheduleInject();
            }
        }, 300);
    });

    // 优先监听设置面板容器（更精确，性能更好）
    const targets = [
        document.querySelector('#left-nav-panel'),
        document.querySelector('#top-settings-holder'),
        document.querySelector('#openai_api'),
        document.querySelector('#textgenerationwebui_api-settings'),
    ].filter(Boolean);

    if (targets.length > 0) {
        for (const target of targets) {
            _observer.observe(target, {
                childList: true,
                subtree: true,
            });
        }
        logger.debug(`Observer attached to ${targets.length} targets`);
    } else {
        // 兜底: 找不到容器时仍然监听 body, 但仅 childList 不递归
        _observer.observe(document.body, {
            childList: true,
            subtree: false,
        });
        logger.debug('Observer attached to body (fallback, non-recursive)');
    }
}

// =====================================================
// 卸载（onDelete 用）
// =====================================================
export function teardown() {
    _runtimeTimers.clearAll();
    registerStatusSetter(() => {});
    _injectScheduled = false;
    if (_observer) {
        _observer.disconnect();
        _observer = null;
    }
    if (_intervalId) {
        _intervalId = null;
    }
    if (_statusResetTimer) {
        _statusResetTimer = null;
    }

    if (_settingUnsubscribe) {
        try { _settingUnsubscribe(); } catch (_) {}
        _settingUnsubscribe = null;
    }

    for (const unsub of _eventUnsubscribers) {
        try { typeof unsub === 'function' && unsub(); } catch (_) {}
    }
    _eventUnsubscribers = [];

    // 移除所有注入的元素
    document.querySelectorAll(`.${HISTORY_BTN_CLASS}, .${STATUS_DOT_CLASS}`)
        .forEach(el => el.remove());

    _initialized = false;
    logger.info('UI injector torn down');
}
