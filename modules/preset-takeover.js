/**
 * SillyTavern Preset Auto Save - Preset Takeover
 * 预设接管模块（核心特性）— Custom Dropdown Overlay 架构
 *
 * ⚠️ 核心原则（严格遵守）：
 *   1. 绝不修改 option.textContent — ST 的 text() 始终返回真实预设名
 *   2. 绝不从 select 中 detach/remove option — ST 的 find('option') 始终能找到所有预设
 *   3. 绝不拦截 select 的 change 事件 — ST 的原生 handler 始终正常执行
 *   4. 只通过 CSS 隐藏原生 select — opacity:0; pointer-events:none; position:absolute
 *   5. 用自定义 UI 替代视觉层 — 用户看到的是分组下拉，实际操作的是原生 select
 *
 * 数据流：
 *   select.options[] ──→ preset-grouping.js ──→ Custom Dropdown UI
 *                                                       │
 *                                                       ↓ (用户点击)
 *   $(select).val(targetValue).trigger('change') ──→ ST 原生 handler
 *                                                       │
 *                                                       ↓ (ST 事件)
 *   oai_preset_changed_after ──→ 更新 Custom Dropdown trigger 显示
 */
import { logger } from './logger.js';
import { getSettings, onSettingChange, updateSetting } from './settings.js';
import {
    on, getEventType, getCurrentApiId, escapeHtml, escapeAttr,
    getPresetSnapshot, savePresetSafe,
    toast, t,
} from './compatibility.js';
import {
    getSeriesInfo,
    pickRepresentativeVersion,
    normalizeSeriesKey,
    buildNestedGroupTree,
    compareVersion,
    getNodePath,
    findNodeByKey,
    collectAllPresetNames,
} from './preset-grouping.js';
import {
    initArchiveStore,
    listArchivedPresets,
    removeArchivedPreset,
} from './archive-store.js';
import { getSnapshots, addSnapshot, TRIGGER } from './history-store.js';
import { restoreArchiveEntries } from './core/archive-recovery.js';
// =====================================================
// 常量
// =====================================================
const SELECT_SELECTOR = 'select[data-preset-manager-for]';
const TAKEOVER_DATA_ATTR = 'data-pas-takeover';        // 标记此 select 已被接管
// 时间常量
const INIT_REFRESH_RETRY_MS = 800;    // 初始化后兜底刷新延迟（等待 ST DOM 稳定）
const SEED_SNAPSHOT_DELAY_MS = 3000;  // 启动种子快照延迟（等待预设列表完全加载）
const SELECT_UI_REFRESH_MS = 50;      // select 变更后 UI 刷新微延迟
// =====================================================
// 模块状态
// =====================================================
let _initialized = false;
let _takeoverActive = false;
// 事件取消订阅句柄
let _eventUnsubscribers = [];
let _settingUnsubscribe = null;
// 监听 select 自身 children 变化的 observer
let _selectObserver = null;
// 监听整个文档（捕获新 select 的出现）
let _docObserver = null;
// 我们是否在写入 DOM（用于让自己的 mutation 不触发自己的 observer）
let _selfMutating = false;
// 管理的 select 集合（用于 teardown 时清理）
const _managedSelects = new Set();
// ⚡ 防抖与去重缓存
let _refreshTimer = null;
let _lastRefreshTs = 0;
let _refreshSuppressUntil = 0;
let _forceNextRefresh = false;
// Bug fix: 缓存最后一次 refreshTakeover 传入的 overrides/tree，防止 SETTINGS_UPDATED 触发的二次 refresh() 用空值覆盖
let _cachedOverrides = null;
let _cachedTree = null;
const REFRESH_DEBOUNCE_MS = 220;
const REFRESH_MIN_INTERVAL_MS = 350;
const REFRESH_FORCE_MIN_INTERVAL_MS = 50;   // P0-4: force 模式下的硬节流，防止连续调用导致性能雪崩
// 每个 select 对应的 option 指纹（用于判断是否需要重新渲染 dropdown）
const _selectFingerprints = new WeakMap();
// =====================================================
// 预设名有效性检查（模块级，消除重复定义）
// =====================================================
/**
 * 判断预设名是否"无效"（空白、纯数字占位符等）
 * @param {*} name
 * @returns {boolean}
 */
function _isInvalidPresetName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (!s) return true;
    if (/^[\s\-_.]*\d+[\s\-_.]*$/.test(s)) return true;
    return false;
}
// =====================================================
// 初始化
// =====================================================
export async function initPresetTakeover() {
    if (_initialized) {
        logger.debug('Takeover already initialized, skip');
        return;
    }
    _initialized = true;
    logger.info('[Takeover] Starting initialization (Custom Dropdown Overlay)...');
    // 初始化归档存储
    try {
        await initArchiveStore();
    } catch (e) {
        logger.warn('[Takeover] archive store init failed:', e);
    }
    // 监听设置变化
    _settingUnsubscribe = onSettingChange(({ key }) => {
        if (
            key === 'takeoverEnabled'
            || key === 'groupingManualOverrides'
            || key === 'groupingEnabled'
            || key === 'nestingEnabled'
            || key === 'nestingMaxDepth'
            || key === 'groupingTree'
            || key === 'enabled'
        ) {
            scheduleRefresh();
        }
    });
    // 监听 ST 事件
    const events = [
        'OAI_PRESET_CHANGED_AFTER',
        'PRESET_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'MAIN_API_CHANGED',
        'APP_READY',
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
    // SETTINGS_UPDATED：独立 throttle 到至少 2 秒间隔
    let _lastSettingsEvtTs = 0;
    try {
        const evt = getEventType('SETTINGS_UPDATED', 'settings_updated');
        const unsub = on(evt, () => {
            const now = Date.now();
            if (now - _lastSettingsEvtTs < 2000) return;
            _lastSettingsEvtTs = now;
            scheduleRefresh();
        });
        if (typeof unsub === 'function') {
            _eventUnsubscribers.push(unsub);
            boundEventCount++;
        }
    } catch (_) {}
    logger.debug(`[Takeover] bound ${boundEventCount} ST events`);
    setupDocObserver();
    // 立即应用一次 + 800ms 兜底
    refresh();
    setTimeout(() => refresh(), INIT_REFRESH_RETRY_MS);
    // 启动种子
    setTimeout(() => {
        seedSnapshotsIfNeeded({ silent: true }).catch(e =>
            logger.warn('[Takeover] seed snapshots failed:', e)
        );
    }, SEED_SNAPSHOT_DELAY_MS);
    logger.success('[Takeover] Ready ✓ (Custom Dropdown Overlay)');
}
// =====================================================
// 调度刷新（防抖 + 最小间隔节流）
// =====================================================
function scheduleRefresh() {
    if (_refreshTimer) return;
    const now = Date.now();
    const earliest = Math.max(now + REFRESH_DEBOUNCE_MS,
                               _lastRefreshTs + REFRESH_MIN_INTERVAL_MS);
    const wait = Math.max(0, earliest - now);
    _refreshTimer = setTimeout(() => {
        _refreshTimer = null;
        if (Date.now() < _refreshSuppressUntil) return;
        try {
            refresh();
        } catch (e) {
            logger.error('Preset takeover refresh failed:', e);
        }
    }, wait);
}
// =====================================================
// 计算 select 的 option 列表指纹（幂等判断）
// =====================================================
function computeSelectFingerprint(select) {
    if (!select) return '';
    const opts = select.options;
    const len = opts ? opts.length : 0;
    if (len === 0) return `${select.id || ''}::0`;
    const getText = (opt) => opt ? (opt.textContent || '') : '';
    const firstT = getText(opts[0]);
    const lastT = getText(opts[len - 1]);
    const midT = getText(opts[Math.floor(len / 2)]);
    return `${select.id || select.getAttribute('data-preset-manager-for') || ''}::${len}::${firstT}::${midT}::${lastT}::${select.value}`;
}
// =====================================================
// 主刷新逻辑
// =====================================================
// Bug B: 支持 forceOverrides/forceTree 外部传入，跳过 getSettings() 时序问题
function refresh(forceOverrides = null, forceTree = null) {
    // 若调用方未传参（如 SETTINGS_UPDATED 事件触发），使用缓存值
    if (!forceOverrides && _cachedOverrides) forceOverrides = _cachedOverrides;
    if (!forceTree && _cachedTree) forceTree = _cachedTree;
    const s = getSettings();
    const shouldActive = !!(s.enabled && s.groupingEnabled && s.takeoverEnabled);
    _lastRefreshTs = Date.now();
    if (!shouldActive) {
        if (_takeoverActive) {
            logger.info('[Takeover] disabling → removing custom dropdowns, restoring native selects');
            teardownAllDropdowns();
            _takeoverActive = false;
        }
        return;
    }
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (e) {
        logger.warn('[Takeover] querySelectorAll failed:', e);
        return;
    }
    if (!selects || selects.length === 0) return;
    const forceRebuild = _forceNextRefresh;
    _forceNextRefresh = false;
    const settings = getSettings();
    let appliedCount = 0;
    let skippedCount = 0;
    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        // 幂等跳过：option 指纹未变 + 已有 wrapper → 仅更新 trigger 显示 + active 状态
        // AG-1: forceRebuild 时跳过指纹检查，强制重建
        // Bug B: 外部传参时也强制重建（forceRebuild 逻辑不变，forceOverrides 非空时跳过缓存）
        const selFp = computeSelectFingerprint(select);
        const lastSelFp = _selectFingerprints.get(select);
        const wrapper = select.closest('.pas-dd-wrapper');
        if (!forceRebuild && !forceOverrides && lastSelFp === selFp && wrapper) {
            // 只更新 trigger 文本和 active 标记
            updateTriggerDisplay(select, wrapper);
            updateActiveState(select, wrapper);
            skippedCount++;
            continue;
        }
        try {
            applyTakeoverToSelect(select, forceOverrides, forceTree);
            appliedCount++;
            _selectFingerprints.set(select, computeSelectFingerprint(select));
        } catch (e) {
            logger.warn('[Takeover] failed for select:', e);
        }
    }
    _refreshSuppressUntil = Date.now() + 800;
    if (appliedCount > 0) {
        if (!_takeoverActive) {
            logger.success(`[Takeover] activated (overlay) · ${appliedCount} select(s)`);
        } else {
            logger.debug(`[Takeover] refreshed · ${appliedCount} applied${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}`);
        }
        _takeoverActive = true;
    } else {
        // all skipped - fingerprint cache hit
    }
}
// =====================================================
// 接管单个 select — 创建 Custom Dropdown Overlay
// =====================================================
// Bug B: forceOverrides/forceTree 优先于 getSettings()，绕过时序问题
function applyTakeoverToSelect(select, forceOverrides = null, forceTree = null) {
    const apiId = getApiIdOfSelect(select);
    const settings = getSettings();
    const overrides = forceOverrides || settings.groupingManualOverrides || {};
    const actualTree = forceTree || settings.groupingTree || {};
    const seriesDefaults = settings.seriesDefaultApply || {};
    // 如果已经创建了 wrapper，更新内容即可
    let wrapper = select.closest('.pas-dd-wrapper');
    if (wrapper) {
        const panel = wrapper.querySelector('.pas-dd-panel');
        if (panel) {
            renderDropdownContent(panel, select, apiId, overrides, seriesDefaults, forceTree);
            updateTriggerDisplay(select, wrapper);
            updateActiveState(select, wrapper);
        }
        return;
    }
    // P1 fix: 防御性检查 — select 必须有 parentNode 才能 insertBefore
    if (!select.parentNode) {
        logger.warn('[Takeover] select has no parentNode, skipping wrapper creation');
        return;
    }
    // 创建 wrapper，包裹 select
    wrapper = document.createElement('div');
    wrapper.className = 'pas-dd-wrapper';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'flex';
    wrapper.style.flex = '1 1 0';
    wrapper.style.minWidth = '0';
    // BUG-03 fix: _selfMutating 保护覆盖整个 DOM 创建过程
    let trigger, panel;
    _selfMutating = true;
    try {
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        // 隐藏原生 select（CSS only — ST 仍可通过 ID/selector 正常访问）
        select.style.opacity = '0';
        select.style.pointerEvents = 'none';
        select.style.position = 'absolute';
        select.style.width = '100%';
        select.style.height = '100%';
        select.style.top = '0';
        select.style.left = '0';
        select.style.zIndex = '-1';
        select.setAttribute(TAKEOVER_DATA_ATTR, '1');
        // 创建 trigger 按钮
        trigger = document.createElement('div');
        trigger.className = 'pas-dd-trigger';
        trigger.tabIndex = 0;
        trigger.innerHTML = `
            <span class="pas-dd-label"></span>
            <i class="fas fa-chevron-down pas-dd-chevron"></i>
        `;
        wrapper.appendChild(trigger);
        // 创建 panel（下拉面板）
        panel = document.createElement('div');
        panel.className = 'pas-dd-panel';
        panel.style.display = 'none';
        wrapper.appendChild(panel);
    } finally {
        _selfMutating = false;
    }
    // 渲染分组内容
    renderDropdownContent(panel, select, apiId, overrides, seriesDefaults);
    updateTriggerDisplay(select, wrapper);
    // ---------- 事件绑定 ----------
    // trigger 点击 → 显示/隐藏 panel
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.style.display !== 'none';
        if (isOpen) {
            closePanel(panel, trigger);
        } else {
            openPanel(panel, trigger);
        }
    });
    // 键盘导航
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger.click();
        } else if (e.key === 'Escape') {
            closePanel(panel, trigger);
        }
    });
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePanel(panel, trigger);
            trigger.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            navigateItems(panel, e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
            const focused = panel.querySelector('.pas-dd-item--focused');
            if (focused) focused.click();
        }
    });
    // 点击外部 → 关闭 panel
    const onDocClick = (e) => {
        if (!wrapper.contains(e.target)) {
            closePanel(panel, trigger);
        }
    };
    document.addEventListener('click', onDocClick, true);
    // 保存引用以便 teardown
    wrapper._pasDocClickHandler = onDocClick;
    // 标记为已管理
    _managedSelects.add(select);
    // 设置 select observer
    setupSelectObserver(select);
    logger.debug(`[Takeover] overlay applied to [${apiId}]`);
}
// =====================================================
// 渲染下拉面板内容
// =====================================================
// Bug B: forceTree 优先于 settings.groupingTree
function renderDropdownContent(panel, select, apiId, overrides, seriesDefaults, forceTree = null) {
    const settings = getSettings();
    // 从 select.options 读取所有预设名和 value
    const optionList = Array.from(select.options || []);
    if (optionList.length === 0) {
        panel.innerHTML = `<div class="pas-dd-empty">${escapeHtml(t('Grouping Dropdown Empty'))}</div>`;
        return;
    }
    const currentValue = select.value;
    // ================================================================
    // 嵌套模式：使用 buildNestedGroupTree 递归渲染
    // ================================================================
    if (settings.nestingEnabled) {
        renderDropdownNested(panel, select, optionList, currentValue, overrides, settings, forceTree);
        return;
    }
    // ================================================================
    // 扁平模式（原有逻辑，保持不变）
    // ================================================================
    // 收集有效预设名
    // 按系列分组（T4 fix: 使用 normalizeSeriesKey 确保与历史面板分组一致）
    const seriesGroups = new Map();          // normKey → items[]
    const seriesDisplayNames = new Map();    // normKey → 首次出现的原始大小写名
    const standaloneOptions = []; // 不参与分组的
    for (const option of optionList) {
        const presetName = (option.textContent || '').trim();
        const value = option.value;
        const realName = presetName || value;
        if (!realName || _isInvalidPresetName(realName)) {
            standaloneOptions.push({ presetName: realName || value, value });
            continue;
        }
        const info = getSeriesInfo(realName, overrides);
        const rawSeriesKey = info.series || realName;
        const normKey = normalizeSeriesKey(rawSeriesKey);
        if (!seriesGroups.has(normKey)) {
            seriesGroups.set(normKey, []);
            seriesDisplayNames.set(normKey, rawSeriesKey); // 保留首次出现的大小写形式
        }
        seriesGroups.get(normKey).push({
            presetName: realName,
            value,
            version: info.version,
            duplicate: info.duplicate,
            manualOverride: info.manualOverride,
        });
    }
    // 构建 HTML
    let html = '';
    // 排序系列：按系列名字母序
    const sortedSeries = Array.from(seriesGroups.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
    );
    for (const [normKey, items] of sortedSeries) {
        const displayName = seriesDisplayNames.get(normKey) || normKey;
        // 单版本系列 → 作为独立项（除非它是手动覆盖到自定义分组的，需要显示分组名）
        // AT-1 fix: manualOverride 的预设即使只有 1 个也要作为组渲染，
        //   否则自定义分组名在 takeover dropdown 中不可见
        if (items.length === 1 && !items[0].manualOverride) {
            const it = items[0];
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
            </div>`;
            continue;
        }
        // 多版本系列 → 组
        // 版本按版本号倒序（最新在前）
        items.sort((a, b) => compareVersion(b.version, a.version));
        const hasActiveInGroup = items.some(it => it.value === currentValue);
        // T7: 移除 ⭐ 默认预设标记；T5: group-body 默认 display:none（收起）
        html += `<div class="pas-dd-group" data-series-key="${escapeAttr(normKey)}">
            <div class="pas-dd-group-header${hasActiveInGroup ? ' pas-dd-group--has-active' : ''}" title="${escapeAttr(displayName)}">
                <span class="pas-dd-series-name">${escapeHtml(displayName)}</span>
                <span class="pas-dd-badge pas-dd-version-count">${items.length}</span>
                <i class="fas fa-chevron-right pas-dd-group-chevron"></i>
            </div>
            <div class="pas-dd-group-body" style="display:none;">`;
        for (const it of items) {
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                    <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
                    ${it.version ? `<span class="pas-dd-version-tag">${escapeHtml(it.version)}</span>` : ''}
                </div>`;
        }
        html += `</div></div>`;
    }
    // 独立预设（不可分组的）
    for (const it of standaloneOptions) {
        if (!it.presetName) continue;
        const isActive = it.value === currentValue;
        html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
            <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
        </div>`;
    }
    panel.innerHTML = html;
    // ---------- 绑定 panel 内事件（事件委托，只绑定一次） ----------
    if (!panel._pasClickBound) {
        panel._pasClickBound = true;
    // item 点击 → 切换预设
    panel.addEventListener('click', (e) => {
        const item = e.target.closest('.pas-dd-item');
        if (item) {
            e.stopPropagation();
            const value = item.getAttribute('data-value');
            if (value !== null) {
                onItemClick(select, value, panel);
            }
            return;
        }
        // 组头点击 → 展开/收起
        const header = e.target.closest('.pas-dd-group-header');
        if (header) {
            e.stopPropagation();
            const group = header.closest('.pas-dd-group');
            if (group) {
                toggleGroup(group);
            }
            return;
        }
    });
    } // end if (!panel._pasClickBound)
}
// =====================================================
// 嵌套模式渲染：构建嵌套树并递归生成 HTML
// =====================================================
/**
 * 嵌套模式：使用 buildNestedGroupTree 构建嵌套组树并渲染下拉面板
 * @param {HTMLElement} panel - 下拉面板容器
 * @param {HTMLSelectElement} select - 原生 select 元素
 * @param {Array<HTMLOptionElement>} optionList - 所有 option 元素
 * @param {string} currentValue - 当前选中的值
 * @param {object} overrides - groupingManualOverrides
 * @param {object} settings - 完整设置对象
 */
// Bug B: forceTree 优先于 settings.groupingTree
function renderDropdownNested(panel, select, optionList, currentValue, overrides, settings, forceTree = null) {
    // 1. 收集有效预设名
    const allPresetNames = [];
    /** @type {Map<string, {value: string, presetName: string, version: string, duplicate: string, manualOverride: boolean}>} */
    const optionsMap = new Map();
    for (const opt of optionList) {
        const name = (opt.textContent || '').trim();
        if (!name || _isInvalidPresetName(name)) continue;
        if (optionsMap.has(name)) continue; // 去重
        allPresetNames.push(name);
        const info = getSeriesInfo(name, overrides);
        optionsMap.set(name, {
            value: opt.value,
            presetName: name,
            version: info.version,
            duplicate: info.duplicate,
            manualOverride: info.manualOverride,
        });
    }
    // 2. 构建嵌套树（Bug B: forceTree 优先）
    const tree = forceTree || settings.groupingTree || {};
    const maxDepth = settings.nestingMaxDepth || 3;
    const rootNodes = buildNestedGroupTree(allPresetNames, overrides, tree, maxDepth);
    //    使用共享函数 getNodePath 获取祖先 key 链，再映射为 displayName 拼接成显示路径
    const keyToDisplay = new Map();
    (function collectDisplayNames(nodes) {
        for (const node of nodes) {
            keyToDisplay.set(node.key, node.displayName);
            if (node.children && node.children.length > 0) collectDisplayNames(node.children);
        }
    })(rootNodes);
    /** @type {Map<string, string>} */
    const nestedPathMap = new Map();
    (function buildPaths(nodes) {
        for (const node of nodes) {
            const keyPath = getNodePath(tree, node.key);
            const displayPath = keyPath.length > 0
                ? keyPath.map(k => keyToDisplay.get(k) || k).join(' / ')
                : node.displayName;
            for (const presetName of node.items) {
                if (!nestedPathMap.has(presetName)) {
                    nestedPathMap.set(presetName, displayPath);
                }
            }
            if (node.children && node.children.length > 0) buildPaths(node.children);
        }
    })(rootNodes);
    // 4. 递归渲染 HTML
    let html = renderNestedDropdownGroups(rootNodes, optionsMap, currentValue, overrides);
    // 5. 无效预设名 → 独立项
    for (const opt of optionList) {
        const name = (opt.textContent || '').trim();
        if (!name || !_isInvalidPresetName(name)) continue;
        if (!name && !opt.value) continue;
        const display = name || opt.value;
        const isActive = opt.value === currentValue;
        html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(opt.value)}" data-preset-name="${escapeAttr(display)}" title="${escapeAttr(display)}">
            <span class="pas-dd-item-name">${escapeHtml(display)}</span>
        </div>`;
    }
    panel.innerHTML = html;
    // 存储路径映射，供 updateTriggerDisplay 使用
    panel._pasNestedPathMap = nestedPathMap;
    // 6. 绑定 panel 点击事件（与扁平模式共用同一个事件委托）
    if (!panel._pasClickBound) {
        panel._pasClickBound = true;
        panel.addEventListener('click', (e) => {
            const item = e.target.closest('.pas-dd-item');
            if (item) {
                e.stopPropagation();
                const value = item.getAttribute('data-value');
                if (value !== null) {
                    onItemClick(select, value, panel);
                }
                return;
            }
            // 组头点击 → 展开/收起（嵌套组头同样使用 .pas-dd-group-header）
            const header = e.target.closest('.pas-dd-group-header');
            if (header) {
                e.stopPropagation();
                const group = header.closest('.pas-dd-group');
                if (group) {
                    toggleGroup(group);
                }
                return;
            }
        });
    }
}
/**
 * 递归检查节点及其子树是否包含当前激活的预设。
 * 使用共享函数 collectAllPresetNames 完成子树遍历，然后通过 optionsMap 查找 value 匹配。
 *
 * @param {object} node - 树节点
 * @param {Map<string, object>} optionsMap - 预设名 → option 信息映射
 * @param {string} currentValue - 当前选中的 value
 * @returns {boolean}
 */
function _nodeHasActive(node, optionsMap, currentValue) {
    const allNames = collectAllPresetNames([node]);
    return allNames.some(name => {
        const opt = optionsMap.get(name);
        return opt && opt.value === currentValue;
    });
}
/**
 * 递归渲染嵌套下拉组 HTML
 * @param {Array} rootNodes - 根节点数组（来自 buildNestedGroupTree）
 * @param {Map<string, object>} optionsMap - 预设名 → { value, presetName, version, duplicate, manualOverride }
 * @param {string} currentValue - 当前选中的值
 * @returns {string} HTML 字符串
 */
function renderNestedDropdownGroups(rootNodes, optionsMap, currentValue, overrides) {
    let html = '';
    for (const node of rootNodes) {
        // 递归子节点（先递归，获取子节点 HTML）
        const childHtml = node.children && node.children.length > 0
            ? renderNestedDropdownGroups(node.children, optionsMap, currentValue, overrides)
            : '';
        // 跳过空壳节点：自身无 items + 递归子节点 HTML 也为空 → 不渲染
        const hasOverride = overrides && Object.values(overrides).some(v => normalizeSeriesKey(v) === node.key);
        if (node.items.length === 0 && !childHtml.trim() && !hasOverride) continue;
        const depth = node.depth;
        const hasActive = _nodeHasActive(node, optionsMap, currentValue);
        const itemCount = node.items.length;
        const childCount = node.children.length;
        // 构建统计标签文本
        let badgeText = '';
        if (itemCount > 0) badgeText += `${itemCount}项`;
        if (childCount > 0) badgeText += (badgeText ? `, ${childCount}子组` : `${childCount}子组`);
        html += `<div class="pas-dd-group pas-dd-nested" data-series-key="${escapeAttr(node.key)}">
            <div class="pas-dd-group-header pas-dd-level-${depth}${hasActive ? ' pas-dd-group--has-active' : ''}" title="${escapeAttr(node.displayName)}">
                <span class="pas-dd-series-name">${escapeHtml(node.displayName)}</span>
                ${badgeText ? `<span class="pas-dd-badge pas-dd-version-count">${escapeHtml(badgeText)}</span>` : ''}
                <i class="fas fa-chevron-right pas-dd-group-chevron"></i>
            </div>
            <div class="pas-dd-group-body" style="display:none;">`;
        // 渲染直接归属于当前节点的预设项（按版本倒序）
        const directItems = node.items
            .map(name => optionsMap.get(name))
            .filter(Boolean);
        directItems.sort((a, b) => compareVersion(b.version, a.version));
        for (const it of directItems) {
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                    <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
                    ${it.version ? `<span class="pas-dd-version-tag">${escapeHtml(it.version)}</span>` : ''}
                </div>`;
        }
        // 追加递归子节点 HTML
        html += childHtml;
        html += `</div></div>`;
    }
    return html;
}
// =====================================================
// item 点击 → 通过原生 select 切换预设
// =====================================================
function onItemClick(select, value, panel) {
    // 通过 jQuery 设值并触发 change — ST 原生 handler 完全接管
    try {
        const $ = window.jQuery || window.$;
        if ($) {
            $(select).val(String(value)).trigger('change');
        } else {
            select.value = String(value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // 验证 val 是否实际生效（option 不存在时 jQuery 会静默失败）
        const actual = select.value;
        if (actual !== String(value)) {
            logger.warn(`[Takeover] onItemClick: val mismatch — expected="${value}" actual="${actual}"`);
            toast.warning(t('Preset Switch Failed'));
        }
    } catch (e) {
        logger.warn('[Takeover] onItemClick failed:', e);
    }
    // 关闭 panel
    const wrapper = select.closest('.pas-dd-wrapper');
    if (wrapper) {
        const trigger = wrapper.querySelector('.pas-dd-trigger');
        closePanel(panel, trigger);
    }
    // 刷新 UI（trigger 显示 + active 状态）
    setTimeout(() => {
        const w = select.closest('.pas-dd-wrapper');
        if (w) {
            updateTriggerDisplay(select, w);
            updateActiveState(select, w);
        }
    }, SELECT_UI_REFRESH_MS);
}
// =====================================================
// 组的展开/收起
// =====================================================
function toggleGroup(group) {
    const body = group.querySelector('.pas-dd-group-body');
    const chevron = group.querySelector('.pas-dd-group-chevron');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chevron) {
        chevron.classList.toggle('fa-chevron-right', isOpen);
        chevron.classList.toggle('fa-chevron-down', !isOpen);
    }
    group.classList.toggle('pas-dd-group--open', !isOpen);
}
// =====================================================
// 更新 trigger 显示文字
// =====================================================
function updateTriggerDisplay(select, wrapper) {
    const label = wrapper.querySelector('.pas-dd-label');
    if (!label) return;
    // P0 fix: 防御性获取 selectedOpt — 与 compatibility.js:getSelectedPresetName() 同模式
    // 某些 ST 版本下 select 可能不是真正的 HTMLSelectElement（如 sysprompt/reasoning/instruct），
    // 没有 .options 属性，直接 select.options[select.selectedIndex] 会触发 TypeError。
    let selectedOpt = null;
    try {
        if (select && select.options && Number.isInteger(select.selectedIndex) && select.selectedIndex >= 0) {
            selectedOpt = select.options[select.selectedIndex];
        }
    } catch (_) { /* fallback null */ }
    if (!selectedOpt || typeof selectedOpt.textContent !== 'string') {
        label.textContent = '—';
        label.title = '';
        return;
    }
    const presetName = selectedOpt.textContent.trim();
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const info = getSeriesInfo(presetName, overrides);
    if (info.version && info.series) {
        label.textContent = `${info.series} · ${info.version}`;
    } else {
        label.textContent = presetName;
    }
    // title 属性：嵌套模式下显示完整路径，扁平模式显示预设原名
    const panel = wrapper.querySelector('.pas-dd-panel');
    if (settings.nestingEnabled && panel && panel._pasNestedPathMap) {
        const nestedPath = panel._pasNestedPathMap.get(presetName);
        if (nestedPath) {
            label.title = `分组: ${nestedPath}\n预设: ${presetName}`;
        } else {
            label.title = presetName;
        }
    } else {
        label.title = presetName;
    }
}
// =====================================================
// 更新 active 状态
// =====================================================
function updateActiveState(select, wrapper) {
    const panel = wrapper.querySelector('.pas-dd-panel');
    if (!panel) return;
    const currentValue = select.value;
    // 更新 items
    const allItems = panel.querySelectorAll('.pas-dd-item');
    for (const item of allItems) {
        const v = item.getAttribute('data-value');
        item.classList.toggle('pas-dd-item--active', v === currentValue);
    }
    // 更新 group headers 的 has-active 标记
    const groups = panel.querySelectorAll('.pas-dd-group');
    for (const group of groups) {
        const hasActive = group.querySelector('.pas-dd-item--active') !== null;
        const header = group.querySelector('.pas-dd-group-header');
        if (header) {
            header.classList.toggle('pas-dd-group--has-active', hasActive);
        }
    }
}
// =====================================================
// Panel 开/关
// =====================================================
function openPanel(panel, trigger) {
    panel.style.display = 'block';
    // 阶段11：动态 max-width（面板左边缘到视口右边缘-16px安全边距）
    const triggerRect = trigger.getBoundingClientRect();
    panel.style.maxWidth = Math.min(380, window.innerWidth - triggerRect.left - 16) + 'px';
    
    if (trigger) {
        trigger.classList.add('pas-dd-trigger--open');
        const chevron = trigger.querySelector('.pas-dd-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-up');
        }
    }
    // panel 仍留在 wrapper 内 → panel.parentElement 即 wrapper
    const wrapper = panel.parentElement;
    if (wrapper) {
        const select = wrapper.querySelector('select');
        if (select) {
            updateActiveState(select, wrapper);
        }
    }
    // M-2B: 读取 takeoverDefaultExpand 设置决定展开策略
    const settings = getSettings();
    const expandAll = settings.takeoverDefaultExpand;
    // T5: 先收起所有组
    const allOpenGroups = panel.querySelectorAll('.pas-dd-group.pas-dd-group--open');
    for (const g of allOpenGroups) {
        toggleGroup(g); // 收起已展开的组
    }
    if (expandAll) {
        // N-1: 展开所有一级组（不展开二级内容）
        // 嵌套模式下仅展开根级组（depth=0），扁平模式下展开所有
        let rootGroups;
        if (settings.nestingEnabled) {
            // 嵌套模式：仅展开 depth=0 的根级组头
            rootGroups = panel.querySelectorAll('.pas-dd-group-header.pas-dd-level-0');
        } else {
            // 扁平模式：展开所有（与原来行为一致）
            rootGroups = panel.querySelectorAll('.pas-dd-group-header');
        }
        for (const header of rootGroups) {
            const group = header.closest('.pas-dd-group');
            if (group && !group.classList.contains('pas-dd-group--open')) {
                toggleGroup(group);
            }
        }
    }
    // expandAll=false 时，所有组保持收起，不展开任何组
}
function closePanel(panel, trigger) {
    if (panel) {
        panel.style.display = 'none';
        panel.style.maxWidth = '';
    }
    if (trigger) {
        trigger.classList.remove('pas-dd-trigger--open');
        const chevron = trigger.querySelector('.pas-dd-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-up');
            chevron.classList.add('fa-chevron-down');
        }
    }
}
// =====================================================
// 键盘导航
// =====================================================
function navigateItems(panel, direction) {
    // 收集所有可聚焦项（排除 display:none 的元素及其祖先被隐藏的元素）
    const allCandidates = panel.querySelectorAll('.pas-dd-item');
    const items = Array.from(allCandidates).filter(el => {
        // 排除自身 display:none
        if (el.style.display === 'none') return false;
        // 排除被隐藏的 group-body 内的元素（通过检查祖先 .pas-dd-group-body 的 display 状态）
        const body = el.closest('.pas-dd-group-body');
        if (body && body.style.display === 'none') return false;
        return true;
    });
    if (items.length === 0) return;
    const current = panel.querySelector('.pas-dd-item--focused');
    let idx = current ? items.indexOf(current) : -1;
    if (current) current.classList.remove('pas-dd-item--focused');
    idx += direction;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items[idx].classList.add('pas-dd-item--focused');
    items[idx].scrollIntoView({ block: 'nearest' });
}
// =====================================================
// 拆除所有自定义 dropdown（还原原生 select）
// =====================================================
function teardownAllDropdowns() {
    for (const select of _managedSelects) {
        teardownDropdown(select);
    }
    _managedSelects.clear();
    // P0-3: 所有 dropdown 已销毁，断开 MutationObserver 防止泄漏
    if (_selectObserver) {
        try { _selectObserver.disconnect(); } catch (_) {}
        _selectObserver = null;
    }
    if (_docObserver) {
        try { _docObserver.disconnect(); } catch (_) {}
        _docObserver = null;
    }
    // 清除所有 select 上的 pasObserved 标记，确保重新启用接管时不会跳过 observer 注册
    try {
        document.querySelectorAll('select.pas-takeover-select[data-pas-observed]').forEach(s => {
            delete s.dataset.pasObserved;
        });
    } catch (_) {}
}
function teardownDropdown(select) {
    if (!select) return;
    const wrapper = select.closest('.pas-dd-wrapper');
    if (!wrapper) return;
    _selfMutating = true;
    try {
        // 还原 select 样式
        select.style.opacity = '';
        select.style.pointerEvents = '';
        select.style.position = '';
        select.style.width = '';
        select.style.height = '';
        select.style.top = '';
        select.style.left = '';
        select.style.zIndex = '';
        select.removeAttribute(TAKEOVER_DATA_ATTR);
        // 从 document 上移除 click handler
        if (wrapper._pasDocClickHandler) {
            document.removeEventListener('click', wrapper._pasDocClickHandler, true);
            wrapper._pasDocClickHandler = null;
        }
        // 将 select 移回 wrapper 的 parent，然后移除 wrapper
        const parent = wrapper.parentNode;
        if (parent) {
            parent.insertBefore(select, wrapper);
            parent.removeChild(wrapper);
        }
    } finally {
        _selfMutating = false;
    }
}
// =====================================================
// MutationObserver
// =====================================================
function setupSelectObserver(select) {
    if (!_selectObserver) {
        _selectObserver = new MutationObserver((mutations) => {
            if (_selfMutating) return;
            if (Date.now() < _refreshSuppressUntil) return;
            let needRefresh = false;
            for (const m of mutations) {
                if (m.type !== 'childList') continue;
                if (!m.addedNodes.length && !m.removedNodes.length) continue;
                const hasOption = (nodes) => {
                    for (const n of nodes) {
                        if (n && n.nodeType === 1 && n.tagName === 'OPTION') return true;
                    }
                    return false;
                };
                if (hasOption(m.addedNodes) || hasOption(m.removedNodes)) {
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
        if (Date.now() < _refreshSuppressUntil) return;
        for (const m of mutations) {
            if (m.type !== 'childList' || !m.addedNodes.length) continue;
            for (const n of m.addedNodes) {
                if (!(n instanceof Element)) continue;
                if (n.matches?.(SELECT_SELECTOR) || n.querySelector?.(SELECT_SELECTOR)) {
                    scheduleRefresh();
                    return;
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
// 工具函数
// =====================================================
function getApiIdOfSelect(select) {
    const apiIds = (select.getAttribute('data-preset-manager-for') || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return apiIds[0] || 'openai';
}
// escapeAttr 已从 compatibility.js 导入（见文件顶部）
// compareVersion 已从 preset-grouping.js 统一导入（见文件顶部）
// =====================================================
// 公开 API
// =====================================================
/**
 * 重做接管（外部触发）
 * @param {object} [options]
 * @param {boolean} [options.force] - 若为 true，跳过防抖/抑制/指纹缓存，立即强制重建所有 dropdown
 */
export function refreshTakeover({ force = false, _overrides = null, _tree = null } = {}) {
    // Bug fix: 缓存 overrides/tree，防止 SETTINGS_UPDATED 触发的二次 refresh() 用空值覆盖
    if (_overrides) _cachedOverrides = _overrides;
    if (_tree) _cachedTree = _tree;
    if (!force) {
        // 非 force 模式暂不支持额外参数传递，走常规调度
        scheduleRefresh();
        return;
    }
    // P0-4: force 模式下的硬节流 — 连续调用间隔不得低于 REFRESH_FORCE_MIN_INTERVAL_MS
    const now = Date.now();
    if (now - _lastRefreshTs < REFRESH_FORCE_MIN_INTERVAL_MS) {
        // Bug 6 fix: 节流降级时也要设置 _forceNextRefresh，确保下次 scheduleRefresh 触发的 refresh() 强制重建
        // 否则 groupingTree 变更后接管面板不会更新嵌套视图
        _forceNextRefresh = true;
        // 过于密集，降级为 scheduleRefresh（合并到常规防抖流程）
        logger.debug('[Takeover] refreshTakeover({ force: true }) throttled — too frequent, falling back to scheduleRefresh');
        scheduleRefresh();
        return;
    }
    // AG-1: 强制模式 — 清除所有守卫，立即重建
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
    _refreshSuppressUntil = 0;
    _forceNextRefresh = true;
    logger.debug('[Takeover] refreshTakeover({ force: true }) — immediate rebuild');
    try {
        // Bug B: 支持外部传入 overrides/tree，绕过 getSettings() 时序问题
        refresh(_overrides, _tree);
    } catch (e) {
        logger.error('[Takeover] force refresh failed:', e);
    }
}
/**
 * 返回指定 API 的所有预设名（直接从 select.options 读取，不再有 detached 概念）
 *
 * @param {string} [filterApiId] 仅返回该 apiId 的预设；不传 = 当前 API；'*' = 全部
 * @returns {Array<{apiId: string, presetName: string, detached: boolean}>}
 */
export function listAllPresetsIncludingDetached(filterApiId) {
    const out = [];
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return out;
    }
    let target = filterApiId;
    if (target === undefined || target === null) {
        try { target = getCurrentApiId(); } catch (_) { target = 'openai'; }
    }
    const wantAll = (target === '*');
    const seen = new Set();
    for (const sel of selects) {
        if (!sel || !sel.isConnected) continue;
        const apiId = getApiIdOfSelect(sel);
        if (!wantAll && apiId !== target) continue;
        for (const opt of sel.options || []) {
            const realName = (opt.textContent || opt.value || '').trim();
            if (_isInvalidPresetName(realName)) continue;
            const key = `${apiId}::${realName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ apiId, presetName: realName, detached: false });
        }
    }
    return out;
}
/**
 * 列出所有 select 当前可见的"系列代表"
 * 返回 [{ apiId, seriesKey, items, representativeName, versionCount }]
 */
export function listSeriesFromNativeSelects() {
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const out = [];
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return out;
    }
    const seenSeriesByApi = new Map();
    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        const apiId = getApiIdOfSelect(select);
        // 直接从 select.options 读取所有预设名（不再有 detached）
        const allNames = Array.from(select.options || [])
            .map(o => (o.textContent || '').trim())
            .filter(Boolean);
        const unique = [...new Set(allNames)];
        // T4 fix: 使用 normalizeSeriesKey 确保与 renderDropdownContent 分组一致
        const seriesGroups = new Map();
        const seriesDisplayKeys = new Map(); // normKey → first-seen original case
        for (const name of unique) {
            const info = getSeriesInfo(name, overrides);
            const rawSeriesKey = info.series || name;
            const normKey = normalizeSeriesKey(rawSeriesKey);
            if (!seriesGroups.has(normKey)) {
                seriesGroups.set(normKey, []);
                seriesDisplayKeys.set(normKey, rawSeriesKey);
            }
            seriesGroups.get(normKey).push({
                presetName: name,
                version: info.version,
                duplicate: info.duplicate,
                manualOverride: info.manualOverride,
            });
        }
        if (!seenSeriesByApi.has(apiId)) seenSeriesByApi.set(apiId, new Set());
        const seenSet = seenSeriesByApi.get(apiId);
        for (const [normKey, items] of seriesGroups) {
            if (seenSet.has(normKey)) continue;
            seenSet.add(normKey);
            const displayKey = seriesDisplayKeys.get(normKey) || normKey;
            const rep = pickRepresentativeVersion(displayKey, items, settings.seriesDefaultApply || {});
            out.push({
                apiId,
                seriesKey: displayKey,
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
    try { teardownAllDropdowns(); } catch (_) {}
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
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
            delete s.dataset.pasObserved;
        }
    } catch (_) {}
    _managedSelects.clear();
    _refreshSuppressUntil = 0;
    _takeoverActive = false;
    _initialized = false;
    logger.info('Preset takeover torn down');
}
// =====================================================
// 种子快照
// =====================================================
let _seedingRunning = false;
/**
 * 给当前 ST 所有现存预设建立"初始快照"
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]
 * @param {boolean} [opts.silent=false]
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
    // AT0: 如果首次扫描向导尚未完成（用户还没确认"建立分组"），跳过自动种子
    if (!force && !settings.groupingFirstScanDone) {
        logger.debug('[Seed] groupingFirstScanDone=false, skip until user confirms');
        return { skipped: true };
    }
    if (!force && !settings.autoSeedOnTakeover) {
        logger.debug('[Seed] autoSeedOnTakeover=false, skip');
        return { skipped: true };
    }
    _seedingRunning = true;
    try {
        const apiId = getCurrentApiId();
        if (!apiId) {
            logger.warn('[Seed] no current API id, skip');
            return { skipped: true };
        }
        // 直接用 listAllPresetsIncludingDetached（现在读 select.options，不再有 detached）
        const fromDOM = listAllPresetsIncludingDetached(apiId) || [];
        const allNames = fromDOM
            .filter(e => e && e.apiId === apiId && typeof e.presetName === 'string' && e.presetName)
            .map(e => e.presetName);
        if (allNames.length === 0) {
            logger.debug('[Seed] no presets in ST');
            return { skipped: true, total: 0 };
        }
        if (silent) {
            logger.debug(`[Seed] checking ${allNames.length} presets for missing initial snapshots...`);
        } else {
            logger.info(`[Seed] checking ${allNames.length} presets for missing initial snapshots...`);
        }
        if (!silent) {
            try { toast.info(t('Seed Snapshots Start', { count: allNames.length })); } catch (_) {}
        }
        let added = 0;
        let skipped = 0;
        let failed = 0;
        const total = allNames.length;
        for (let i = 0; i < allNames.length; i++) {
            const name = allNames[i];
            try {
                const existing = await getSnapshots(apiId, name);
                if (Array.isArray(existing) && existing.length > 0) {
                    skipped++;
                } else {
                    const data = getPresetSnapshot(name);
                    if (!data || typeof data !== 'object') {
                        failed++;
                        continue;
                    }
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
            if (i % 5 === 4 && i < allNames.length - 1) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
        const seedLogMsg =
            `[Seed] complete: added=${added}, skipped=${skipped}` +
            (failed > 0 ? `, failed=${failed}` : '') +
            ` (total=${total})`;
        if (added > 0) {
            logger.success(seedLogMsg);
        } else {
            logger.debug(seedLogMsg);
        }
        if (!silent) {
            try {
                if (added > 0) {
                    toast.success(t('Seed Snapshots Done', { added, skipped, total }));
                }
            } catch (_) {}
        }
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
 * 为单个预设创建初始快照（如果尚无快照）
 * V-1: 用于导入检测和切换时补种，避免新导入预设显示 "0 · 0 B · —"
 *
 * @param {string} presetName
 * @param {string} [apiId] - 不传则自动获取当前 API
 * @returns {Promise<{seeded: boolean}>}
 */
export async function seedSnapshotForPreset(presetName, apiId) {
    try {
        const aid = apiId || getCurrentApiId();
        if (!aid || !presetName) return { seeded: false };
        const existing = await getSnapshots(aid, presetName);
        if (Array.isArray(existing) && existing.length > 0) {
            return { seeded: false };
        }
        const data = getPresetSnapshot(presetName);
        if (!data || typeof data !== 'object') {
            logger.debug(`[Seed] no data for "${presetName}", skip single-seed`);
            return { seeded: false };
        }
        const snap = await addSnapshot(presetName, aid, data, TRIGGER.MANUAL);
        if (snap) {
            logger.info(`[Seed] initial snapshot created for "${presetName}"`);
            return { seeded: true };
        }
        return { seeded: false };
    } catch (e) {
        logger.debug(`[Seed] seedSnapshotForPreset error for "${presetName}":`, e);
        return { seeded: false };
    }
}
/**
 * 强制重新种子
 */
export async function forceReseedSnapshots() {
    return seedSnapshotsIfNeeded({ force: true, silent: false });
}
/**
 * 从归档还原所有被数据接管的预设到 ST PresetManager
 */
export async function restoreAllFromArchive() {
    try {
        const archives = await listArchivedPresets({ strict: true });
        if (!archives || archives.length === 0) {
            logger.debug('[Takeover-Data] no archives to restore');
            return { restored: 0, failed: 0, cleanupFailed: 0, fromSnapshot: 0, fromArchive: 0 };
        }
        const result = await restoreArchiveEntries(archives, {
            getSnapshots,
            persistPreset: async (entry, preset, context) => {
                await savePresetSafe(entry.presetName, preset, { apiId: entry.apiId });
                const sourceLabel = context.source === 'snapshot'
                    ? `snapshot(${context.snapshot?.id?.slice(0, 6) || '?'}, ts=${context.snapshot?.timestamp})`
                    : 'archive';
                logger.debug(`[Takeover-Data] restored "${entry.presetName}" from ${sourceLabel}`);
            },
            removeArchive: entry => removeArchivedPreset(entry.apiId, entry.presetName),
            onError: ({ phase, archive, error }) => {
                const message = `[Takeover-Data] ${phase} failed for "${archive?.presetName || '?'}"`;
                if (phase === 'snapshot') logger.debug(message, error);
                else logger.warn(message, error);
            },
        });
        logger.success(
            `[Takeover-Data] restore complete: ${result.restored} restored ` +
            `(${result.fromSnapshot} from latest snapshot · ${result.fromArchive} from archive)` +
            (result.failed > 0 ? ` · ${result.failed} failed` : '') +
            (result.cleanupFailed > 0 ? ` · ${result.cleanupFailed} archive cleanup failed` : '')
        );
        return result;
    } catch (e) {
        logger.error('[Takeover-Data] restoreAllFromArchive failed:', e);
        return { restored: 0, failed: 1, cleanupFailed: 0, fromSnapshot: 0, fromArchive: 0, error: String(e) };
    }
}
/**
 * 公开 API：列出当前归档
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
