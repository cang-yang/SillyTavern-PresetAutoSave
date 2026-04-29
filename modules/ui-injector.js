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

// =====================================================
// 常量
// =====================================================
const HISTORY_BTN_CLASS = 'pas-history-btn';
const STATUS_DOT_CLASS = 'pas-status-dot';
const HISTORY_BTN_ID_PREFIX = 'pas_history_btn_';
const STATUS_DOT_ID_PREFIX = 'pas_status_dot_';

const STATUS_KEYS = {
    idle: 'Status Idle',
    pending: 'Status Pending',
    saving: 'Status Saving',
    saved: 'Status Saved',
    error: 'Status Error',
};

function statusLabel(state) {
    return t(STATUS_KEYS[state] || 'Status Idle');
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

    // 定时检查兜底（成本极低）
    _intervalId = setInterval(() => {
        if (!hasInjected()) {
            scheduleInject();
        }
    }, 5000);

    _initialized = true;
    logger.success('UI injector ready');
}

// =====================================================
// 注入调度（节流）
// =====================================================
function scheduleInject() {
    if (_injectScheduled) return;
    _injectScheduled = true;

    setTimeout(() => {
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
    updateStatusDotVisibility();
}

function hasInjected() {
    return !!document.querySelector(`.${HISTORY_BTN_CLASS}`);
}

// =====================================================
// 历史按钮注入
// =====================================================
function injectHistoryButtons() {
    const selects = document.querySelectorAll('select[data-preset-manager-for]');

    for (const select of selects) {
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

        const btn = createHistoryButton(apiId, btnId);
        container.appendChild(btn);

        logger.debug(`History button injected: [${apiId}]`);
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
    const selects = document.querySelectorAll('select[data-preset-manager-for]');

    for (const select of selects) {
        const apiIds = (select.getAttribute('data-preset-manager-for') || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const apiId = apiIds[0] || 'openai';

        const dotId = STATUS_DOT_ID_PREFIX + apiId;
        if (document.getElementById(dotId)) continue;

        const dot = createStatusDot(apiId, dotId);

        // 插入到 select 之前
        select.parentNode.insertBefore(dot, select);

        logger.debug(`Status dot injected: [${apiId}]`);
    }
}

function createStatusDot(apiId, dotId) {
    const dot = document.createElement('span');
    dot.id = dotId;
    dot.className = `${STATUS_DOT_CLASS} pas-status-idle`;
    dot.title = statusLabel('idle');
    dot.setAttribute('data-pas-element', 'status-dot');
    dot.setAttribute('data-api-id', apiId);
    dot.setAttribute('aria-live', 'polite');
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
    const validStates = ['idle', 'pending', 'saving', 'saved', 'error'];
    if (!validStates.includes(state)) return;

    const label = statusLabel(state);
    const dots = document.querySelectorAll(`.${STATUS_DOT_CLASS}`);
    for (const dot of dots) {
        validStates.forEach(s => dot.classList.remove(`pas-status-${s}`));
        dot.classList.add(`pas-status-${state}`);
        dot.title = label;
    }

    // saved/error 状态自动恢复 idle
    clearTimeout(_statusResetTimer);
    if (state === 'saved') {
        _statusResetTimer = setTimeout(() => setStatusDot('idle'), 2000);
    } else if (state === 'error') {
        _statusResetTimer = setTimeout(() => setStatusDot('idle'), 4000);
    }
}

// =====================================================
// 事件监听 - 切换/加载后重新注入
// =====================================================
function setupEventListeners() {
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
            setTimeout(scheduleInject, 100);
        });
        _eventUnsubscribers.push(unsub);
    }
}

// =====================================================
// MutationObserver 兜底
// =====================================================
function setupObserver() {
    if (_observer) return;

    let pending = false;

    _observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;

        setTimeout(() => {
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
    if (_observer) {
        _observer.disconnect();
        _observer = null;
    }
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
    if (_statusResetTimer) {
        clearTimeout(_statusResetTimer);
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