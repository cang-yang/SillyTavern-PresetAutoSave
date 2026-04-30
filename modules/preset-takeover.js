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
import { getSettings, onSettingChange, updateSetting } from './settings.js';
import {
    on, getEventType, getCurrentApiId, selectPresetSafe,
    getPresetManager, getPresetSnapshot, savePresetSafe, deletePresetSafe, getAllPresetNames,
    toast, t,
} from './compatibility.js';
import {
    parsePresetName,
    getSeriesInfo,
    pickRepresentativeVersion,
} from './preset-grouping.js';
import {
    initArchiveStore,
    archivePreset,
    listArchivedPresets,
    removeArchivedPreset,
    getArchiveCount,
} from './archive-store.js';
import { getSnapshots, addSnapshot, TRIGGER } from './history-store.js';

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
    if (_initialized) {
        logger.debug('Takeover already initialized, skip');
        return;
    }

    logger.info('[Takeover] Starting initialization...');

    // 初始化归档存储（数据接管模式需要）
    try {
        await initArchiveStore();
    } catch (e) {
        logger.warn('[Takeover] archive store init failed (data mode unavailable):', e);
    }

    // 监听设置变化
    _settingUnsubscribe = onSettingChange(({ key, newValue, oldValue }) => {
        if (
            key === 'takeoverEnabled'
            || key === 'seriesDefaultApply'
            || key === 'groupingManualOverrides'
            || key === 'groupingExcluded'
            || key === 'groupingEnabled'
        ) {
            logger.debug(`[Takeover] setting changed: ${key} → schedule refresh`);
            scheduleRefresh();
        }

        // 模式切换：dom ↔ data
        if (key === 'takeoverMode') {
            logger.info(`[Takeover] mode changed: ${oldValue} → ${newValue}`);
            if (oldValue === 'data' && newValue === 'dom') {
                // 从数据接管退回 DOM 接管 → 必须先把所有归档预设回写到 ST
                restoreAllFromArchive().catch(e =>
                    logger.error('[Takeover] failed to restore archives:', e)
                );
            } else if (oldValue === 'dom' && newValue === 'data') {
                // 从 DOM 接管 → 数据接管：先还原 DOM，再做归档
                if (_takeoverActive) restoreAllDom();
                applyDataTakeover().catch(e =>
                    logger.error('[Takeover] failed to apply data takeover:', e)
                );
            }
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
    let boundEventCount = 0;
    for (const evtName of events) {
        try {
            const evt = getEventType(evtName, evtName.toLowerCase());
            const unsub = on(evt, () => scheduleRefresh());
            if (typeof unsub === 'function') {
                _eventUnsubscribers.push(unsub);
                boundEventCount++;
            }
        } catch (e) {
            logger.debug(`[Takeover] failed to bind ${evtName}`, e);
        }
    }
    logger.debug(`[Takeover] bound ${boundEventCount}/${events.length} ST events`);

    setupDocObserver();

    _initialized = true;

    // 立即应用一次（同步 + 微延迟双保险）
    refresh();
    setTimeout(() => refresh(), 100);
    setTimeout(() => refresh(), 500);
    setTimeout(() => refresh(), 1500);

    // 启动种子：让"未修改的存量预设"立即出现在三级面板里
    // 不阻塞主流程：发起异步种子，悄悄完成
    setTimeout(() => {
        seedSnapshotsIfNeeded().catch(e =>
            logger.warn('[Takeover] seed snapshots failed:', e)
        );
    }, 2500);

    logger.success('[Takeover] Ready ✓');
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
        if (_takeoverActive) {
            logger.info(`[Takeover] disabling (enabled=${s.enabled} grouping=${s.groupingEnabled} takeover=${s.takeoverEnabled}) → restore native dropdown`);
            // 数据接管模式 → 必须先把归档恢复回 ST，再退出
            if (s.takeoverMode === 'data') {
                restoreAllFromArchive().catch(e => logger.error('[Takeover] data restore failed:', e));
            }
            restoreAllDom();
            _takeoverActive = false;
        } else {
            logger.debug(`[Takeover] inactive (enabled=${s.enabled} grouping=${s.groupingEnabled} takeover=${s.takeoverEnabled})`);
        }
        return;
    }

    // 模式分流：数据接管单独走异步流程
    if (s.takeoverMode === 'data') {
        applyDataTakeover().catch(e => logger.error('[Takeover] data takeover failed:', e));
        return;
    }

    // 应用接管
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (e) {
        logger.warn('[Takeover] querySelectorAll failed:', e);
        return;
    }

    if (!selects || selects.length === 0) {
        logger.debug('[Takeover] no select[data-preset-manager-for] found in DOM yet');
        return;
    }

    let appliedCount = 0;
    let totalSeries = 0;
    let totalDetached = 0;
    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        try {
            const stat = applyTakeoverToSelect(select);
            appliedCount++;
            if (stat) {
                totalSeries += stat.seriesCount || 0;
                totalDetached += stat.detachedCount || 0;
            }
        } catch (e) {
            logger.warn('[Takeover] failed for select:', e);
        }
    }

    if (appliedCount > 0) {
        if (!_takeoverActive) {
            logger.success(`[Takeover] activated · ${appliedCount} select(s) · ${totalSeries} series · ${totalDetached} option(s) merged`);
        } else {
            logger.debug(`[Takeover] refreshed · ${appliedCount} select(s) · ${totalSeries} series · ${totalDetached} merged`);
        }
    }

    _takeoverActive = appliedCount > 0;
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

    logger.debug(`[Takeover] applied to [${apiId}]: ${repAssignments.length} series, ${detachQueue.length} detached`);
    return {
        apiId,
        seriesCount: repAssignments.length,
        detachedCount: detachQueue.length,
    };
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

function restoreAllDom() {
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
    try { restoreAllDom(); } catch (_) {}

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

// =====================================================
// 数据级接管：直接通过 PresetManager 删除非代表预设
// 真正的"一劳永逸"模式：之后即使 ST 重启、用户禁用插件，状态也保持
// 卸载插件时通过 restoreAllFromArchive() 还原
// =====================================================

// 防止数据接管时多次并发调用
let _dataTakeoverRunning = false;

/**
 * 把所有同系列非代表预设：
 *   1. 通过 getPresetSnapshot 读取完整数据
 *   2. archivePreset 备份到 IndexedDB
 *   3. 通过 deletePresetSafe 从 ST 中删除
 *
 * 完成后 ST 的预设列表只剩"系列代表"，原生下拉自然干净
 * 用户卸载插件 / 切回 dom 模式时调用 restoreAllFromArchive 恢复
 */
async function applyDataTakeover() {
    if (_dataTakeoverRunning) {
        logger.debug('[Takeover-Data] already running, skip');
        return;
    }
    _dataTakeoverRunning = true;
    try {
        const settings = getSettings();
        if (!settings.takeoverDataConfirmed) {
            logger.warn('[Takeover-Data] not confirmed by user yet (takeoverDataConfirmed=false), abort');
            return;
        }

        const apiId = getCurrentApiId();
        if (!apiId) {
            logger.warn('[Takeover-Data] no current API id');
            return;
        }

        const overrides = settings.groupingManualOverrides || {};
        const excluded = settings.groupingExcluded || {};
        const seriesDefaults = settings.seriesDefaultApply || {};

        // 1) 拿到 ST 当前的全部预设列表
        const allObjs = getAllPresetNames() || [];
        const allNames = allObjs
            .map(o => (typeof o === 'string') ? o : (o && (o.name || o.preset_name)))
            .filter(s => typeof s === 'string' && s);

        if (allNames.length === 0) {
            logger.debug('[Takeover-Data] no presets in ST');
            return;
        }

        // 2) 按系列分组
        const seriesMap = new Map();
        for (const name of allNames) {
            if (excluded[name]) continue;
            const info = getSeriesInfo(name, overrides, excluded);
            if (info.excluded) continue;
            const key = info.series || name;
            if (!seriesMap.has(key)) seriesMap.set(key, []);
            seriesMap.get(key).push({
                presetName: name,
                version: info.version,
                duplicate: info.duplicate,
            });
        }

        // 3) 对每个系列：保留代表，归档+删除其它
        let archived = 0;
        let deleted = 0;
        let failed = 0;
        let totalToProcess = 0;
        for (const items of seriesMap.values()) {
            if (items.length > 1) totalToProcess += (items.length - 1);
        }
        if (totalToProcess > 0) {
            try {
                toast.info(t('Takeover Data Processing', { count: totalToProcess }));
            } catch (_) {}
        }

        const currentName = (typeof window !== 'undefined' && window.SillyTavern)
            ? (() => {
                try { return SillyTavern.getContext().getPresetManager?.(apiId)?.getSelectedPresetName?.() || ''; }
                catch (_) { return ''; }
            })()
            : '';

        for (const [seriesKey, items] of seriesMap) {
            if (items.length <= 1) continue; // 单版本系列跳过

            // 选代表：当前选中 > 用户配置默认 > 最新
            let rep = items.find(it => it.presetName === currentName);
            if (!rep) {
                rep = pickRepresentativeVersion(seriesKey, items, seriesDefaults);
            }
            if (!rep) continue;

            // 把非代表归档 + 删除
            for (const it of items) {
                if (it.presetName === rep.presetName) continue;
                try {
                    // 3.1) 读取完整数据
                    const data = getPresetSnapshot(it.presetName);
                    if (!data) {
                        logger.warn(`[Takeover-Data] cannot read preset "${it.presetName}", skip`);
                        failed++;
                        continue;
                    }
                    // 3.2) 归档
                    const ok = await archivePreset(apiId, it.presetName, data, seriesKey, 'takeover-merge');
                    if (!ok) {
                        logger.warn(`[Takeover-Data] archive failed for "${it.presetName}", skip delete`);
                        failed++;
                        continue;
                    }
                    archived++;
                    // 3.3) 从 ST 删除
                    const delOk = await deletePresetSafe(it.presetName, apiId);
                    if (delOk) {
                        deleted++;
                    } else {
                        logger.warn(`[Takeover-Data] delete failed for "${it.presetName}"`);
                        failed++;
                    }
                } catch (e) {
                    logger.error(`[Takeover-Data] error processing "${it.presetName}":`, e);
                    failed++;
                }
            }
        }

        if (archived > 0 || deleted > 0) {
            logger.success(`[Takeover-Data] complete: archived=${archived}, deleted=${deleted}, failed=${failed}`);
            try {
                toast.success(t('Takeover Data Done', { archived, deleted }));
            } catch (_) {}
            // 删除后 ST 会重渲下拉，但代表 option 还会显示原始预设名
            // → 再做一遍 DOM 接管的"代表项重命名"，让原下拉显示系列名
            setTimeout(() => {
                try {
                    const selects = document.querySelectorAll(SELECT_SELECTOR);
                    for (const sel of selects) {
                        if (!sel || !sel.isConnected) continue;
                        try { applyTakeoverToSelect(sel); } catch (_) {}
                    }
                } catch (_) {}
            }, 600);
        } else {
            logger.debug('[Takeover-Data] nothing to do (no multi-version series)');
            // 即使没有要归档的，也应做一次 DOM 接管使下拉显示系列名
            try {
                const selects = document.querySelectorAll(SELECT_SELECTOR);
                for (const sel of selects) {
                    if (!sel || !sel.isConnected) continue;
                    try { applyTakeoverToSelect(sel); } catch (_) {}
                }
            } catch (_) {}
        }
        _takeoverActive = true;
    } catch (e) {
        logger.error('[Takeover-Data] applyDataTakeover failed:', e);
    } finally {
        _dataTakeoverRunning = false;
    }
}

// =====================================================
// 种子快照：开启分组/接管时为现有预设自动建立 1 条初始快照
// 这样三级面板在用户做任何修改之前就能完整显示所有预设
// =====================================================
let _seedingRunning = false;

/**
 * 给当前 ST 所有现存预设建立"初始快照"（trigger='manual' / source='seed'）
 *   - 只对没有任何快照的预设执行
 *   - 已经有快照（无论数量多少）的预设跳过
 *   - 异步分批执行，避免一次性卡住主线程
 *   - 结果通过 toast 通知
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  true = 忽略 settings.seedSnapshotsDone 强制重跑
 * @param {boolean} [opts.silent=false] true = 不弹 toast（首次启动静默种子用）
 */
export async function seedSnapshotsIfNeeded(opts = {}) {
    const { force = false, silent = false } = opts;

    if (_seedingRunning) {
        logger.debug('[Seed] already running, skip');
        return { skipped: true };
    }

    const settings = getSettings();
    if (!settings.enabled || !settings.groupingEnabled) {
        logger.debug('[Seed] disabled by settings, skip');
        return { skipped: true };
    }
    if (!force && !settings.autoSeedOnTakeover) {
        logger.debug('[Seed] autoSeedOnTakeover=false, skip');
        return { skipped: true };
    }
    if (!force && settings.seedSnapshotsDone) {
        logger.debug('[Seed] already done in a previous session, skip');
        return { skipped: true };
    }

    _seedingRunning = true;
    try {
        const apiId = getCurrentApiId();
        if (!apiId) {
            logger.warn('[Seed] no current API id, skip');
            return { skipped: true };
        }

        const allObjs = getAllPresetNames() || [];
        const allNames = allObjs
            .map(o => (typeof o === 'string') ? o : (o && (o.name || o.preset_name)))
            .filter(s => typeof s === 'string' && s);

        if (allNames.length === 0) {
            logger.debug('[Seed] no presets in ST');
            return { skipped: true, total: 0 };
        }

        logger.info(`[Seed] checking ${allNames.length} presets for missing initial snapshots...`);
        if (!silent) {
            try { toast.info(t('Seed Snapshots Start', { count: allNames.length })); } catch (_) {}
        }

        let added = 0;
        let skipped = 0;
        let failed = 0;
        const total = allNames.length;

        // 分批：每 5 个让出主线程一次，避免阻塞 UI
        for (let i = 0; i < allNames.length; i++) {
            const name = allNames[i];
            try {
                // 已有快照 → 跳过
                const existing = await getSnapshots(apiId, name);
                if (Array.isArray(existing) && existing.length > 0) {
                    skipped++;
                } else {
                    // 读完整数据
                    const data = getPresetSnapshot(name);
                    if (!data || typeof data !== 'object') {
                        failed++;
                        continue;
                    }
                    // 用 MANUAL trigger 强制建一条（绕过 skipUnchangedSave）
                    const snap = await addSnapshot(name, apiId, data, TRIGGER.MANUAL);
                    if (snap) {
                        added++;
                    } else {
                        failed++;
                    }
                }
            } catch (e) {
                logger.debug(`[Seed] error for "${name}":`, e);
                failed++;
            }

            // 每 5 个 yield 一次（rAF / setTimeout）
            if (i % 5 === 4 && i < allNames.length - 1) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        logger.success(
            `[Seed] complete: added=${added}, skipped=${skipped}` +
            (failed > 0 ? `, failed=${failed}` : '') +
            ` (total=${total})`
        );
        if (!silent) {
            try {
                if (added > 0) {
                    toast.success(t('Seed Snapshots Done', { added, skipped, total }));
                } else if (total > 0) {
                    // 全部都已经有快照了 — 静默
                }
            } catch (_) {}
        }

        // 标记完成（无论这次是否真的添加，至少跑过一次了）
        try {
            updateSetting('seedSnapshotsDone', true);
        } catch (_) {}

        return { added, skipped, failed, total };
    } catch (e) {
        logger.error('[Seed] seedSnapshotsIfNeeded failed:', e);
        return { error: String(e) };
    } finally {
        _seedingRunning = false;
    }
}

/**
 * 强制重新种子（设置面板"重新扫描"按钮调用）
 * 会清掉 seedSnapshotsDone 标记，所有缺快照的预设会被补上一条
 */
export async function forceReseedSnapshots() {
    return seedSnapshotsIfNeeded({ force: true, silent: false });
}

/**
 * 从归档还原所有被数据接管的预设到 ST PresetManager
 *
 * 数据源优先级（每个被归档的预设独立判断）：
 *   1. ⭐ 最新快照（history-store）：归档之后用户在面板里编辑过 → 用最新版
 *   2. 归档原始数据（archive-store）：归档时的备份 → 兜底
 *   3. 都没有 → 标记失败
 *
 * 这样无论是用户在面板里继续修改了某个版本，还是从未动过，
 * 还原后都能拿到"最新最完整"的数据，绝不丢失任何用户修改。
 *
 * 调用时机：
 *   - 用户从 'data' 切回 'dom' 模式
 *   - 用户卸载插件（onDelete / onDisable）
 *   - 用户在面板手动点"恢复全部归档"
 */
export async function restoreAllFromArchive() {
    try {
        const archives = await listArchivedPresets();
        if (!archives || archives.length === 0) {
            logger.debug('[Takeover-Data] no archives to restore');
            return { restored: 0, failed: 0, fromSnapshot: 0, fromArchive: 0 };
        }

        let restored = 0;
        let failed = 0;
        let fromSnapshot = 0;
        let fromArchive = 0;

        for (const entry of archives) {
            try {
                if (!entry || !entry.apiId || !entry.presetName) {
                    failed++;
                    continue;
                }

                // ⭐ 优先选择最新快照（用户最近的修改）
                let dataToRestore = null;
                let sourceLabel = 'archive';

                try {
                    const snapshots = await getSnapshots(entry.apiId, entry.presetName);
                    if (Array.isArray(snapshots) && snapshots.length > 0) {
                        // history-store 内已经按时间倒序，第 0 条 = 最新
                        const latestSnap = snapshots[0];
                        if (latestSnap && latestSnap.preset && typeof latestSnap.preset === 'object') {
                            dataToRestore = latestSnap.preset;
                            sourceLabel = `snapshot(${latestSnap.id?.slice(0, 6) || '?'}, ts=${latestSnap.timestamp})`;
                            fromSnapshot++;
                        }
                    }
                } catch (e) {
                    logger.debug(`[Takeover-Data] snapshot lookup failed for "${entry.presetName}":`, e);
                }

                // 回退到归档原始数据
                if (!dataToRestore) {
                    if (!entry.data || typeof entry.data !== 'object') {
                        logger.warn(`[Takeover-Data] no data available for "${entry.presetName}"`);
                        failed++;
                        continue;
                    }
                    dataToRestore = entry.data;
                    sourceLabel = 'archive';
                    fromArchive++;
                }

                // 写回 ST PresetManager
                const ok = await savePresetSafe(entry.presetName, dataToRestore, { apiId: entry.apiId });
                if (ok) {
                    await removeArchivedPreset(entry.apiId, entry.presetName);
                    restored++;
                    logger.debug(`[Takeover-Data] restored "${entry.presetName}" from ${sourceLabel}`);
                } else {
                    logger.warn(`[Takeover-Data] savePreset failed for "${entry.presetName}"`);
                    failed++;
                }
            } catch (e) {
                logger.error(`[Takeover-Data] restore error for "${entry?.presetName}":`, e);
                failed++;
            }
        }

        logger.success(
            `[Takeover-Data] restore complete: ${restored} restored ` +
            `(${fromSnapshot} from latest snapshot · ${fromArchive} from archive)` +
            (failed > 0 ? ` · ${failed} failed` : '')
        );
        return { restored, failed, fromSnapshot, fromArchive };
    } catch (e) {
        logger.error('[Takeover-Data] restoreAllFromArchive failed:', e);
        return { restored: 0, failed: -1, fromSnapshot: 0, fromArchive: 0 };
    }
}

/**
 * 公开 API：列出当前归档（用于面板查看）
 */
export async function getArchiveSummary() {
    const archives = await listArchivedPresets();
    return {
        count: archives.length,
        items: archives.map(a => ({
            apiId: a.apiId,
            presetName: a.presetName,
            seriesKey: a.seriesKey,
            archivedAt: a.archivedAt,
            reason: a.reason,
        })),
    };
}
