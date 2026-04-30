/**
 * SillyTavern Preset Auto Save - Preset Takeover
 * 预设接管模块（核心特性）
 *
 * 职责：
 *   1. 把原生预设下拉列表从"扁平的所有预设"改造成"系列名一览"
 *      - 同系列的多个版本只保留一个"代表 option"（value 仍是预设名以保证 DOM 兼容）
 *      - 代表 option 的 textContent 显示系列名
 *      - 其余版本的 option 暂时从 DOM 树中摘除（保留引用以便还原）
 *
 *   2. 拦截 select 的 change 事件：
 *      - 当用户选中某个代表 option 时，
 *        如果该系列有"用户指定的默认版本"，则把 select.value 改写为那个版本的预设名
 *        然后再触发原生 change，让 ST 加载真正的目标版本
 *
 *   3. 监听 SillyTavern 事件 + MutationObserver：
 *      - 当原生重新渲染下拉时，重做 takeover
 *      - 设置变化（takeoverEnabled / seriesDefaultApply / groupingManualOverrides）实时刷新
 *
 * 设计原则：
 *   - 不破坏原生数据：永远不修改 PresetManager 的预设数据本身
 *   - 全 DOM 层接管：还原时把保存的原始 option 节点重新插回，状态一致
 *   - 防御性编程：select 不存在 / value 未变 / 接管已开关时都不抛错
 */

import { logger } from './logger.js';
import { getSettings, onSettingChange } from './settings.js';
import { on, getEventType, getCurrentApiId, selectPresetSafe } from './compatibility.js';
import {
    parsePresetName,
    getSeriesInfo,
    pickRepresentativeVersion,
} from './preset-grouping.js';

// =====================================================
// 常量
// =====================================================
const SELECT_SELECTOR = 'select[data-preset-manager-for]';
const TAKEOVER_DATA_ATTR = 'data-pas-takeover';        // 标记此 select 已被接管
const REP_OPTION_DATA_ATTR = 'data-pas-rep';           // 该 option 是代表项 = "1"
const ORIGINAL_TEXT_DATA_ATTR = 'data-pas-orig-text';  // 原始 textContent（接管前）
const SERIES_KEY_DATA_ATTR = 'data-pas-series-key';    // 该代表 option 对应的系列名

// =====================================================
// 模块状态
// =====================================================
let _initialized = false;
let _takeoverActive = false;
let _refreshScheduled = false;

// 每个 select（按 apiId 索引）的"被摘除的非代表 option 列表"
//   _detachedOptions[apiId] = [{ option: HTMLOptionElement, prevSibling: HTMLElement | null }]
//   还原时按这个表插回去
const _detachedOptions = new Map();

// 事件取消订阅句柄
let _eventUnsubscribers = [];
let _settingUnsubscribe = null;

// 监听 select 自身 children 变化的 observer
let _selectObserver = null;

// 监听整个文档（捕获新 select 的出现）
let _docObserver = null;

// 我们是否在写入 DOM（用于让自己的 mutation 不触发自己的 observer）
let _selfMutating = false;

// 我们正在以"代表项策略"切换预设（用于 change 拦截避免递归）
let _selfChangingValue = false;

// =====================================================
// 初始化
// =====================================================
export async function initPresetTakeover() {
    if (_initialized) return;

    // 监听设置变化：开关 / 默认应用映射 / 手动覆盖 / 排除 都会影响接管
    _settingUnsubscribe = onSettingChange(({ key }) => {
        if (
            key === 'takeoverEnabled'
            || key === 'seriesDefaultApply'
            || key === 'groupingManualOverrides'
            || key === 'groupingExcluded'
            || key === 'groupingEnabled'
        ) {
            scheduleRefresh();
        }
    });

    // 监听 ST 事件：原生重新渲染预设下拉时重做 takeover
    const events = [
        'OAI_PRESET_CHANGED_AFTER',
        'PRESET_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'MAIN_API_CHANGED',
        'APP_READY',
        'SETTINGS_UPDATED',
    ];
    for (const evtName of events) {
        try {
            const evt = getEventType(evtName, evtName.toLowerCase());
            const unsub = on(evt, () => scheduleRefresh());
            if (typeof unsub === 'function') _eventUnsubscribers.push(unsub);
        } catch (e) {
            logger.debug(`takeover: failed to bind ${evtName}`, e);
        }
    }

    setupDocObserver();

    // 立即应用一次
    scheduleRefresh();

    _initialized = true;
    logger.success('Preset takeover ready');
}

// =====================================================
// 调度刷新（防抖）
// =====================================================
function scheduleRefresh() {
    if (_refreshScheduled) return;
    _refreshScheduled = true;
    // 用 rAF + 50ms 微延迟：rAF 让浏览器先完成上一帧；50ms 让 ST 的连续事件合并
    requestAnimationFrame(() => {
        setTimeout(() => {
            _refreshScheduled = false;
            try {
                refresh();
            } catch (e) {
                logger.error('Preset takeover refresh failed:', e);
            }
        }, 50);
    });
}

/**
 * 主刷新逻辑：根据当前 settings 决定开 / 关，并作用到所有 select
 */
function refresh() {
    const s = getSettings();
    const shouldActive = !!(s.enabled && s.groupingEnabled && s.takeoverEnabled);

    if (!shouldActive) {
        // 需要关闭接管 → 还原所有 select
        if (_takeoverActive) {
            restoreAll();
            _takeoverActive = false;
            logger.info('Takeover disabled, restored native dropdown');
        }
        return;
    }

    // 应用接管
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return;
    }
    if (!selects || selects.length === 0) return;

    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        try {
            applyTakeoverToSelect(select);
        } catch (e) {
            logger.warn('Failed to takeover select:', e);
        }
    }

    _takeoverActive = true;
}

// =====================================================
// 接管单个 select
// =====================================================
/**
 * @param {HTMLSelectElement} select
 */
function applyTakeoverToSelect(select) {
    const apiId = getApiIdOfSelect(select);

    // 先把所有原本被摘除的还原 → 然后重新计算（保证幂等）
    restoreSelect(select, apiId);

    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const excluded = settings.groupingExcluded || {};
    const seriesDefaults = settings.seriesDefaultApply || {};

    // 1) 收集所有 option（跳过 disabled / value="" 的占位项）
    const optionList = Array.from(select.options || []);
    if (optionList.length === 0) return;

    // 2) 按系列分组：seriesKey -> [{ option, presetName, version, parsed }]
    const seriesGroups = new Map();
    const standalone = [];  // 解析失败 / excluded 的项（保持原样）
    for (const option of optionList) {
        const value = option.value;
        const presetName = option.textContent;
        // ST 的预设下拉里：value === presetName（presetManager 用 name 作为 value）
        // 占位项（如空 value）跳过接管
        if (!value && !presetName) {
            standalone.push(option);
            continue;
        }
        const realName = presetName || value;
        // excluded 的预设保持原样
        if (excluded[realName]) {
            standalone.push(option);
            continue;
        }

        const info = getSeriesInfo(realName, overrides, excluded);
        const seriesKey = info.series || realName;

        if (!seriesGroups.has(seriesKey)) {
            seriesGroups.set(seriesKey, []);
        }
        seriesGroups.get(seriesKey).push({
            option,
            presetName: realName,
            version: info.version,
            duplicate: info.duplicate,
        });
    }

    // 3) 选出每个系列的"代表 option"
    //    优先级：当前选中的 option（避免 UI/数据不同步）→ seriesDefaultApply[seriesKey] → pickLatestVersion
    //    重要：如果某个系列内"当前选中"的 option 不是默认/最新，则升格它为代表，避免摘除导致 select.value 跳变
    const currentSelectValue = select.value;
    const detachQueue = [];
    const repAssignments = [];
    for (const [seriesKey, items] of seriesGroups) {
        let rep = null;

        // 3.1) 当前选中的 option 优先（最稳定，不会触发 select 自动跳变）
        const currentMatch = items.find(it => it.option.value === currentSelectValue);
        if (currentMatch) {
            rep = currentMatch;
        } else {
            // 3.2) 用户配置的默认应用 / latest
            rep = pickRepresentativeVersion(seriesKey, items, seriesDefaults);
        }
        if (!rep) continue;
        repAssignments.push({ option: rep.option, seriesKey, items });

        // 其它 option 进入待摘除队列
        for (const it of items) {
            if (it.option !== rep.option) {
                detachQueue.push(it.option);
            }
        }
    }

    // 4) 写入 DOM（标记自身写入避免 observer 反复触发）
    _selfMutating = true;
    try {
        // 4.1) 给 select 加上接管标记
        select.setAttribute(TAKEOVER_DATA_ATTR, '1');

        // 4.2) 改写每个代表 option 的 textContent 为系列名
        for (const { option, seriesKey, items } of repAssignments) {
            // 保存原始文本用于还原
            if (!option.hasAttribute(ORIGINAL_TEXT_DATA_ATTR)) {
                option.setAttribute(ORIGINAL_TEXT_DATA_ATTR, option.textContent || '');
            }
            const versionCount = items.length;
            // 同系列只有 1 个版本时不显示 (1)，多版本时附带数量提示
            const displayName = versionCount > 1 ? `${seriesKey}` : seriesKey;
            option.textContent = displayName;
            option.setAttribute(REP_OPTION_DATA_ATTR, '1');
            option.setAttribute(SERIES_KEY_DATA_ATTR, seriesKey);
            if (versionCount > 1) {
                option.title = `${seriesKey} · ${versionCount} 个版本`;
            } else {
                option.removeAttribute('title');
            }
        }

        // 4.3) 把待摘除 option 从 DOM 移除（保存引用 + 前一个兄弟）
        const detachedList = _detachedOptions.get(apiId) || [];
        for (const opt of detachQueue) {
            const prevSibling = opt.previousElementSibling || null;
            const parent = opt.parentNode;
            if (parent) {
                detachedList.push({ option: opt, prevSibling, parent });
                parent.removeChild(opt);
            }
        }
        _detachedOptions.set(apiId, detachedList);
    } finally {
        _selfMutating = false;
    }

    // 5) 拦截 change（一次性，幂等）
    if (!select.dataset.pasChangeBound) {
        select.dataset.pasChangeBound = '1';
        select.addEventListener('change', onSelectChangeIntercept, true);
    }

    // 6) 启动 select 子树 observer（监听 ST 重新渲染）
    setupSelectObserver(select);

    logger.debug(`takeover applied to [${apiId}]: ${repAssignments.length} series, ${detachQueue.length} detached`);
}

// =====================================================
// change 拦截：用户选中代表项 → 应用真正的默认版本
// =====================================================
function onSelectChangeIntercept(e) {
    if (_selfChangingValue) return;
    const select = e.currentTarget;
    if (!select || !select.tagName || select.tagName.toLowerCase() !== 'select') return;
    if (!select.hasAttribute(TAKEOVER_DATA_ATTR)) return;

    const settings = getSettings();
    if (!(settings.enabled && settings.groupingEnabled && settings.takeoverEnabled)) {
        return;
    }

    const value = select.value;
    if (!value) return;
    const opt = Array.from(select.options).find(o => o.value === value);
    if (!opt) return;

    // 判断是否为接管后的"代表 option"
    if (!opt.hasAttribute(REP_OPTION_DATA_ATTR)) return;

    const seriesKey = opt.getAttribute(SERIES_KEY_DATA_ATTR);
    if (!seriesKey) return;

    // 查找该系列的"用户指定默认版本"
    const seriesDefaults = settings.seriesDefaultApply || {};
    const targetName = seriesDefaults[seriesKey];
    // 如果没指定，或者指定的就是当前 value，啥也不做
    if (!targetName || targetName === value) {
        return;
    }

    // 检查目标版本是否仍存在（在被摘除列表中）
    const apiId = getApiIdOfSelect(select);
    const detached = _detachedOptions.get(apiId) || [];
    const exists = detached.some(d => d.option.value === targetName)
        || Array.from(select.options).some(o => o.value === targetName);
    if (!exists) {
        logger.warn(`takeover: configured default version "${targetName}" missing for series "${seriesKey}"`);
        return;
    }

    // 阻止默认事件传播，先不让 ST 加载代表预设
    e.stopImmediatePropagation();
    e.preventDefault();

    // 通过 PresetManager 直接应用目标预设
    _selfChangingValue = true;
    try {
        const ok = selectPresetSafe(targetName);
        if (!ok) {
            logger.warn(`takeover: selectPresetSafe(${targetName}) failed`);
        } else {
            logger.debug(`takeover: redirected ${seriesKey} → ${targetName}`);
        }
    } finally {
        _selfChangingValue = false;
    }
}

// =====================================================
// 还原：把单个 select 的所有摘除 option 重新插回
// =====================================================
function restoreSelect(select, apiId) {
    if (!select) return;
    const detached = _detachedOptions.get(apiId);
    if (!detached || detached.length === 0) {
        cleanupSelectAttributes(select);
        return;
    }

    _selfMutating = true;
    try {
        for (const entry of detached) {
            try {
                const { option, prevSibling, parent } = entry;
                if (!parent) continue;
                if (option.parentNode) continue; // 已经在 DOM 中
                if (prevSibling && prevSibling.parentNode === parent) {
                    parent.insertBefore(option, prevSibling.nextSibling);
                } else {
                    // 兜底：插到末尾
                    parent.appendChild(option);
                }
            } catch (_) {
                // 忽略单个失败
            }
        }
        // 还原代表 option 的原始文本
        const reps = select.querySelectorAll(`option[${REP_OPTION_DATA_ATTR}="1"]`);
        for (const opt of reps) {
            const orig = opt.getAttribute(ORIGINAL_TEXT_DATA_ATTR);
            if (orig !== null) {
                opt.textContent = orig;
            }
            opt.removeAttribute(REP_OPTION_DATA_ATTR);
            opt.removeAttribute(SERIES_KEY_DATA_ATTR);
            opt.removeAttribute(ORIGINAL_TEXT_DATA_ATTR);
            opt.removeAttribute('title');
        }
    } finally {
        _selfMutating = false;
    }

    _detachedOptions.delete(apiId);
    cleanupSelectAttributes(select);
}

function cleanupSelectAttributes(select) {
    select.removeAttribute(TAKEOVER_DATA_ATTR);
}

function restoreAll() {
    let selects;
    try {
        selects = document.querySelectorAll(`select[${TAKEOVER_DATA_ATTR}="1"]`);
    } catch (_) {
        return;
    }
    for (const select of selects) {
        const apiId = getApiIdOfSelect(select);
        try {
            restoreSelect(select, apiId);
        } catch (e) {
            logger.debug('restoreSelect error:', e);
        }
    }
    // 防御：清空映射
    _detachedOptions.clear();
}

// =====================================================
// MutationObserver：当原生 select 子树变化（ST 重渲染）
// =====================================================
function setupSelectObserver(select) {
    if (!_selectObserver) {
        _selectObserver = new MutationObserver((mutations) => {
            if (_selfMutating) return;
            // 只关心 childList 变化
            let needRefresh = false;
            for (const m of mutations) {
                if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                    needRefresh = true;
                    break;
                }
            }
            if (needRefresh) scheduleRefresh();
        });
    }
    if (!select.dataset.pasObserved) {
        select.dataset.pasObserved = '1';
        try {
            _selectObserver.observe(select, { childList: true });
        } catch (_) {}
    }
}

function setupDocObserver() {
    if (_docObserver) return;
    _docObserver = new MutationObserver((mutations) => {
        if (_selfMutating) return;
        // 简单策略：只要有节点新增 → 调度一次刷新
        for (const m of mutations) {
            if (m.type === 'childList' && m.addedNodes.length) {
                // 只在新加入的节点里包含 select 时才刷新
                for (const n of m.addedNodes) {
                    if (!(n instanceof Element)) continue;
                    if (n.matches?.(SELECT_SELECTOR) || n.querySelector?.(SELECT_SELECTOR)) {
                        scheduleRefresh();
                        return;
                    }
                }
            }
        }
    });
    try {
        _docObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });
    } catch (_) {}
}

// =====================================================
// 工具
// =====================================================
function getApiIdOfSelect(select) {
    const apiIds = (select.getAttribute('data-preset-manager-for') || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return apiIds[0] || 'openai';
}

// =====================================================
// 公开 API：从面板调用
// =====================================================
/**
 * 强制重做接管（外部触发）
 */
export function refreshTakeover() {
    scheduleRefresh();
}

/**
 * 列出所有 select 当前可见的"系列代表"
 *  返回 [{ apiId, seriesKey, presetName, items: [{ presetName, version }] }]
 *  用于历史面板展示"原生列表"
 */
export function listSeriesFromNativeSelects() {
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const excluded = settings.groupingExcluded || {};

    const out = [];
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return out;
    }

    const seenSeriesByApi = new Map();  // apiId -> Set(seriesKey)

    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        const apiId = getApiIdOfSelect(select);

        // 收集 select 中可见 option + 已被摘除的 option，合并出"完整列表"
        const visible = Array.from(select.options || []).map(o => o.value || o.textContent).filter(Boolean);
        const detached = (_detachedOptions.get(apiId) || []).map(d => d.option.value || d.option.textContent).filter(Boolean);
        const all = [...new Set([...visible, ...detached])];

        const seriesGroups = new Map();
        for (const name of all) {
            if (excluded[name]) continue;
            const info = getSeriesInfo(name, overrides, excluded);
            const seriesKey = info.series || name;
            if (!seriesGroups.has(seriesKey)) seriesGroups.set(seriesKey, []);
            seriesGroups.get(seriesKey).push({
                presetName: name,
                version: info.version,
                duplicate: info.duplicate,
                manualOverride: info.manualOverride,
            });
        }

        if (!seenSeriesByApi.has(apiId)) seenSeriesByApi.set(apiId, new Set());
        const seenSet = seenSeriesByApi.get(apiId);

        for (const [seriesKey, items] of seriesGroups) {
            if (seenSet.has(seriesKey)) continue;
            seenSet.add(seriesKey);

            const rep = pickRepresentativeVersion(seriesKey, items, settings.seriesDefaultApply || {});
            out.push({
                apiId,
                seriesKey,
                items,
                representativeName: rep ? rep.presetName : (items[0]?.presetName || ''),
                versionCount: items.length,
            });
        }
    }
    return out;
}

/**
 * 获取当前预设所属系列的"默认应用版本"
 */
export function getSeriesDefaultApply(seriesKey) {
    const map = getSettings().seriesDefaultApply || {};
    return map[seriesKey] || '';
}

// =====================================================
// 卸载
// =====================================================
export function teardown() {
    try { restoreAll(); } catch (_) {}

    if (_selectObserver) {
        try { _selectObserver.disconnect(); } catch (_) {}
        _selectObserver = null;
    }
    if (_docObserver) {
        try { _docObserver.disconnect(); } catch (_) {}
        _docObserver = null;
    }

    for (const unsub of _eventUnsubscribers) {
        try { typeof unsub === 'function' && unsub(); } catch (_) {}
    }
    _eventUnsubscribers = [];

    if (_settingUnsubscribe) {
        try { _settingUnsubscribe(); } catch (_) {}
        _settingUnsubscribe = null;
    }

    // 清掉所有 select 上的标记
    try {
        const allSel = document.querySelectorAll('select[data-preset-manager-for]');
        for (const s of allSel) {
            delete s.dataset.pasChangeBound;
            delete s.dataset.pasObserved;
            // 安全地移除 listener（用 capture: true 注册需 capture: true 移除）
            try { s.removeEventListener('change', onSelectChangeIntercept, true); } catch (_) {}
        }
    } catch (_) {}

    _detachedOptions.clear();
    _takeoverActive = false;
    _initialized = false;
    logger.info('Preset takeover torn down');
}
