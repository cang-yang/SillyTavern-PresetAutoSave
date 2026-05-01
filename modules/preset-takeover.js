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
    on, getEventType, getCurrentApiId, escapeHtml,
    getPresetSnapshot, savePresetSafe,
    toast, t,
} from './compatibility.js';
import {
    getSeriesInfo,
    pickRepresentativeVersion,
    pickLatestVersion,
    normalizeSeriesKey,
} from './preset-grouping.js';
import {
    initArchiveStore,
    listArchivedPresets,
    removeArchivedPreset,
} from './archive-store.js';
import { getSnapshots, addSnapshot, TRIGGER } from './history-store.js';

// =====================================================
// 常量
// =====================================================
const SELECT_SELECTOR = 'select[data-preset-manager-for]';
const TAKEOVER_DATA_ATTR = 'data-pas-takeover';        // 标记此 select 已被接管

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
const REFRESH_DEBOUNCE_MS = 220;
const REFRESH_MIN_INTERVAL_MS = 350;

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
            || key === 'groupingExcluded'
            || key === 'groupingEnabled'
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
    setTimeout(() => refresh(), 800);

    // 启动种子
    setTimeout(() => {
        seedSnapshotsIfNeeded({ silent: true }).catch(e =>
            logger.warn('[Takeover] seed snapshots failed:', e)
        );
    }, 3000);

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
function refresh() {
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

    let appliedCount = 0;
    let skippedCount = 0;
    for (const select of selects) {
        if (!select || !select.isConnected) continue;

        // 幂等跳过：option 指纹未变 + 已有 wrapper → 仅更新 trigger 显示 + active 状态
        const selFp = computeSelectFingerprint(select);
        const lastSelFp = _selectFingerprints.get(select);
        const wrapper = select.closest('.pas-dd-wrapper');

        if (lastSelFp === selFp && wrapper) {
            // 只更新 trigger 文本和 active 标记
            updateTriggerDisplay(select, wrapper);
            updateActiveState(select, wrapper);
            skippedCount++;
            continue;
        }

        try {
            applyTakeoverToSelect(select);
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
    }
}

// =====================================================
// 接管单个 select — 创建 Custom Dropdown Overlay
// =====================================================
function applyTakeoverToSelect(select) {
    const apiId = getApiIdOfSelect(select);
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const excluded = settings.groupingExcluded || {};
    const seriesDefaults = settings.seriesDefaultApply || {};

    // 如果已经创建了 wrapper，更新内容即可
    let wrapper = select.closest('.pas-dd-wrapper');
    if (wrapper) {
        const panel = wrapper.querySelector('.pas-dd-panel');
        if (panel) {
            renderDropdownContent(panel, select, apiId, overrides, excluded, seriesDefaults);
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
    renderDropdownContent(panel, select, apiId, overrides, excluded, seriesDefaults);
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

    // M-2A: autoSetSeriesDefaults 调用已移除（默认预设功能已移除）

    logger.debug(`[Takeover] overlay applied to [${apiId}]`);
}

// =====================================================
// 渲染下拉面板内容
// =====================================================
function renderDropdownContent(panel, select, apiId, overrides, excluded, seriesDefaults) {
    // 从 select.options 读取所有预设名和 value
    const optionList = Array.from(select.options || []);
    if (optionList.length === 0) {
        panel.innerHTML = '<div class="pas-dd-empty">暂无预设</div>';
        return;
    }

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
            standaloneOptions.push({ presetName: realName || value, value, excluded: false });
            continue;
        }

        if (excluded[realName]) {
            standaloneOptions.push({ presetName: realName, value, excluded: true });
            continue;
        }

        const info = getSeriesInfo(realName, overrides, excluded);
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
        });
    }

    // 构建 HTML
    const currentValue = select.value;
    let html = '';

    // 排序系列：按系列名字母序
    const sortedSeries = Array.from(seriesGroups.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
    );

    for (const [normKey, items] of sortedSeries) {
        const displayName = seriesDisplayNames.get(normKey) || normKey;

        // 单版本系列 → 作为独立项
        if (items.length === 1) {
            const it = items[0];
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}">
                <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
            </div>`;
            continue;
        }

        // 多版本系列 → 组
        // 版本按版本号倒序（最新在前）
        items.sort((a, b) => _compareVersionInline(b.version, a.version));

        const hasActiveInGroup = items.some(it => it.value === currentValue);

        // T7: 移除 ⭐ 默认预设标记；T5: group-body 默认 display:none（收起）
        html += `<div class="pas-dd-group" data-series-key="${escapeAttr(normKey)}">
            <div class="pas-dd-group-header${hasActiveInGroup ? ' pas-dd-group--has-active' : ''}">
                <span class="pas-dd-series-name">${escapeHtml(displayName)}</span>
                <span class="pas-dd-badge pas-dd-version-count">${items.length}</span>
                <i class="fas fa-chevron-right pas-dd-group-chevron"></i>
            </div>
            <div class="pas-dd-group-body" style="display:none;">`;

        for (const it of items) {
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}">
                    <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
                    ${it.version ? `<span class="pas-dd-version-tag">${escapeHtml(it.version)}</span>` : ''}
                </div>`;
        }

        html += `</div></div>`;
    }

    // 独立预设（excluded 或不可分组的）
    for (const it of standaloneOptions) {
        if (!it.presetName) continue;
        const isActive = it.value === currentValue;
        html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}">
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
    }, 50);
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
    const excluded = settings.groupingExcluded || {};
    const info = getSeriesInfo(presetName, overrides, excluded);

    if (info.version && info.series) {
        label.textContent = `${info.series} · ${info.version}`;
    } else {
        label.textContent = presetName;
    }
    label.title = presetName;
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
    if (trigger) {
        trigger.classList.add('pas-dd-trigger--open');
        const chevron = trigger.querySelector('.pas-dd-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-up');
        }
    }

    // T6: 打开面板时更新 active 状态，确保高亮正确
    const wrapper = panel.closest('.pas-dd-wrapper');
    if (wrapper) {
        const select = wrapper.querySelector('select');
        if (select) {
            updateActiveState(select, wrapper);
        }
    }

    // M-2B: 读取 takeoverDefaultExpand 设置决定展开策略
    const expandAll = getSettings().takeoverDefaultExpand;

    // T5: 先收起所有组
    const allGroups = panel.querySelectorAll('.pas-dd-group.pas-dd-group--open');
    for (const g of allGroups) {
        toggleGroup(g); // 收起已展开的组
    }

    if (expandAll) {
        // N-1: 展开所有一级组（不展开二级内容）
        const collapsed = panel.querySelectorAll('.pas-dd-group:not(.pas-dd-group--open)');
        for (const g of collapsed) {
            toggleGroup(g);
        }
    }
    // N-1: expandAll=false 时，所有组保持收起，不展开任何组
}

function closePanel(panel, trigger) {
    if (panel) panel.style.display = 'none';
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
    const items = Array.from(panel.querySelectorAll('.pas-dd-item:not([style*="display: none"])'));
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
// 自动设置系列默认版本
// =====================================================
function autoSetSeriesDefaults(select, apiId, overrides, excluded, seriesDefaults) {
    const optionList = Array.from(select.options || []);

    const seriesGroups = new Map();
    for (const option of optionList) {
        const presetName = (option.textContent || '').trim();
        const realName = presetName || option.value;
        if (!realName || _isInvalidPresetName(realName) || excluded[realName]) continue;

        const info = getSeriesInfo(realName, overrides, excluded);
        const seriesKey = info.series || realName;
        if (!seriesGroups.has(seriesKey)) seriesGroups.set(seriesKey, []);
        seriesGroups.get(seriesKey).push({
            presetName: realName,
            version: info.version,
        });
    }

    let autoSetCount = 0;
    for (const [seriesKey, items] of seriesGroups) {
        if (items.length <= 1) continue;
        if (seriesDefaults[seriesKey]) continue;
        const latest = pickLatestVersion(items);
        if (latest && latest.presetName) {
            seriesDefaults[seriesKey] = latest.presetName;
            autoSetCount++;
        }
    }

    if (autoSetCount > 0) {
        try {
            updateSetting('seriesDefaultApply', { ...seriesDefaults });
            logger.debug(`[Takeover] auto-set default version for ${autoSetCount} series`);
        } catch (e) {
            logger.debug('[Takeover] auto-set default write failed:', e);
        }
    }
}

// =====================================================
// 拆除所有自定义 dropdown（还原原生 select）
// =====================================================
function teardownAllDropdowns() {
    for (const select of _managedSelects) {
        teardownDropdown(select);
    }
    _managedSelects.clear();
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

// escapeHtml 已统一从 compatibility.js 导入（见文件顶部）
/** 属性转义（当前实现 = escapeHtml） */
function escapeAttr(str) {
    return escapeHtml(str);
}

/** 内联版本比较 */
function _compareVersionInline(va, vb) {
    const a = String(va || '');
    const b = String(vb || '');
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    const na = (a.match(/\d+/g) || []).map(Number);
    const nb = (b.match(/\d+/g) || []).map(Number);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        const x = na[i] ?? 0;
        const y = nb[i] ?? 0;
        if (x !== y) return x - y;
    }
    return a.localeCompare(b, 'en');
}

// =====================================================
// 公开 API
// =====================================================

/**
 * 强制重做接管（外部触发）
 */
export function refreshTakeover() {
    scheduleRefresh();
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
    const excluded = settings.groupingExcluded || {};

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
            if (excluded[name]) continue;
            const info = getSeriesInfo(name, overrides, excluded);
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

                let dataToRestore = null;
                let sourceLabel = 'archive';

                try {
                    const snapshots = await getSnapshots(entry.apiId, entry.presetName);
                    if (Array.isArray(snapshots) && snapshots.length > 0) {
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
