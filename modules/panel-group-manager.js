/**
 * SillyTavern Preset Auto Save - Panel Grouping Manager
 * 分组管理弹窗——分组树渲染、拖拽嵌套、子分组CRUD
 * 从 panel-actions.js 提取，2026-05
 */

import { logger } from './logger.js';
import {
    getSettings, batchUpdate,
} from './settings.js';
import {
    confirmSafe, toast, t,
    getAllPresetNames,
    createPopupSafe,
} from './compatibility.js';
import { refreshTakeover } from './preset-takeover.js';
import {
    parsePresetName,
    groupNamesBySeries,
    normalizeSeriesKey,
    buildNestedGroupTree,
    getNodePath,
    validateSeriesAlias,
} from './preset-grouping.js';
import {
    escapeHtml, escapeAttr,
} from './panel-summary.js';
import {
    buildGroupManagerSummary,
    filterGroupingNodes,
} from './core/group-manager-view-model.js';
import { DragHoverExpander } from './core/drag-hover-expander.js';
import { createGroupAliasEditor } from './core/group-alias-editor.js';
import { OrganizationCommandHistory } from './core/organization-command-history.js';
import {
    closeGroupManagerContextMenu,
    openGroupManagerContextMenu,
} from './group-manager-context-menu.js';

// =====================================================
// 常量
// =====================================================
/** DOM 出现后绑定事件的最小等待 */
const DOM_BIND_DELAY_MS = 30;
const PENDING_GROUPS_STATE_KEY = 'pendingCustomGroups';
const ORGANIZATION_STATE_KEYS = Object.freeze([
    'groupingManualOverrides',
    'groupingSeriesAliases',
    'groupingTree',
    'seriesDefaultApply',
    PENDING_GROUPS_STATE_KEY,
]);

// =====================================================
// 弹窗状态（模块级）
// =====================================================
let _groupingManagerPopup = null;
let _groupingManagerRoot = null;

// --- 模块级状态：分组管理弹窗运行时数据 ---
let _gmOverrides = {};
let _gmAllNames = [];
let _gmPanelCtx = null;
/** @type {Set<string>} 尚未有预设的自定义空分组名（AQ-1） */
let _pendingCustomGroups = new Set();
let _gmSearchQuery = '';
let _gmExpandedKeys = new Set();
let _gmSearchTimer = null;
let _gmDragPayload = null;
const _gmHoverExpander = new DragHoverExpander({ delay: 450 });
const _gmOrganizationHistory = new OrganizationCommandHistory({ limit: 25 });

// =====================================================
// 分组管理弹窗状态 getter/setter
// （供 panel-actions.js 的 cleanupActionPopups 跨模块访问和清理）
// =====================================================

export function getGroupingManagerPopup() { return _groupingManagerPopup; }
export function setGroupingManagerPopup(v) { _groupingManagerPopup = v; }

/**
 * 释放模块级分组运行时状态（弹窗关闭时调用）
 * 防止下次打开时残留旧数据（P1-1）
 */
export function clearGroupingManagerState() {
    _gmOverrides = {};
    _pendingCustomGroups.clear();
    _gmSearchQuery = '';
    _gmExpandedKeys.clear();
    _gmDragPayload = null;
    _gmHoverExpander.cancelAll();
    _gmOrganizationHistory.clear();
    if (_gmSearchTimer) clearTimeout(_gmSearchTimer);
    _gmSearchTimer = null;
}

// =====================================================
// 分组管理弹窗（AA-3 重构：系列卡片为核心视图）
// =====================================================

/**
 * 构建分组数据结构（AI-0 重构：不再有 excluded）
 * @returns {{ groups: Array }}
 */
function buildGroupingData() {
    const settings = getSettings();
    _gmOverrides = { ...(settings.groupingManualOverrides || {}) };
    const groups = groupNamesBySeries(_gmAllNames, _gmOverrides, settings.groupingSeriesAliases || {});
    return { groups };
}

function flattenGroupingNodes(rootNodes) {
    const flattened = [];
    const visit = (node, parent = null) => {
        flattened.push({
            key: node.key,
            displayName: node.displayName,
            automaticName: node.automaticName || node.displayName,
            customized: !!node.customized,
            depth: node.depth || 0,
            parentKey: parent?.key || null,
            parentName: parent?.displayName || '',
            hasChildren: !!node.children?.length,
            items: (node.items || []).map(presetName => ({
                presetName,
                manualOverride: !!_gmOverrides[presetName],
            })),
        });
        for (const child of node.children || []) visit(child, node);
    };
    for (const node of rootNodes || []) visit(node);
    return flattened;
}

function normalizeGroupingNodes(groups) {
    return (groups || []).map(group => ({
        key: group.canonicalKey || normalizeSeriesKey(group.automaticName || group.series),
        displayName: group.displayName || group.series,
        automaticName: group.automaticName || group.series,
        customized: !!group.customized,
        depth: 0,
        items: (group.items || []).map(item => ({
            presetName: item.presetName,
            manualOverride: !!item.manualOverride,
        })),
    }));
}

function appendPendingGroups(nodes) {
    const known = new Set(nodes.map(node => node.key));
    for (const name of _pendingCustomGroups) {
        const key = normalizeSeriesKey(name);
        if (!known.has(key)) {
            nodes.push({ key, displayName: name, automaticName: name, depth: 0, items: [], pending: true });
        }
    }
    return nodes;
}

function renderModernPresetRows(node) {
    if (!node.items.length) {
        return `<div class="pas-gm-empty">${escapeHtml(t('Grouping Empty Series'))}</div>`;
    }
    return node.items.map(item => {
        const manual = item.manualOverride
            ? `<span class="pas-gm-origin pas-gm-origin-manual" title="${escapeAttr(t('Grouping Manual Override'))}"><i class="fa-solid fa-link"></i><span>${escapeHtml(t('Grouping Manual Short'))}</span></span>`
            : '';
        return `<div class="pas-gm-preset" draggable="true"
            data-preset-name="${escapeAttr(item.presetName)}"
            data-series-key="${escapeAttr(node.key)}">
            <span class="pas-gm-preset-name" title="${escapeAttr(item.presetName)}">${escapeHtml(item.presetName)}</span>
            ${manual}
            <button class="pas-gm-menu-btn" type="button" aria-label="${escapeAttr(t('Grouping Preset Actions'))}" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
        </div>`;
    }).join('');
}

function renderModernGroupingHTML(nodes) {
    const allNodes = appendPendingGroups([...nodes]);
    const summary = buildGroupManagerSummary(allNodes);
    const visibleNodes = filterGroupingNodes(allNodes, _gmSearchQuery);
    const searching = !!_gmSearchQuery.trim();
    const groupingSettings = getSettings();
    const nestingEnabled = !!groupingSettings.nestingEnabled;
    const nestingMaxDepth = groupingSettings.nestingMaxDepth || 3;

    const cards = visibleNodes.map(node => {
        const expanded = searching || _gmExpandedKeys.has(node.key);
        const isCustom = node.pending || (node.items.length > 0 && node.items.every(item => item.manualOverride));
        const depth = Number(node.depth) || 0;
        const indent = Math.min(depth, 3);
        const depthExceeded = depth >= nestingMaxDepth - 1;
        const relationship = indent
            ? `<span class="pas-gm-tree-relation"><i class="fa-solid fa-turn-up"></i><span>${escapeHtml(node.parentName || '')}</span></span>`
            : '';
        const automaticName = node.automaticName || node.displayName;
        const nameTitle = node.customized
            ? `${node.displayName} · ${t('Grouping Automatic Name Hint', { name: automaticName })}`
            : node.displayName;
        const mobileActions = [
            nestingEnabled && !depthExceeded
                ? `<button type="button" data-action="subgroup"><i class="fa-solid fa-plus"></i><span>${escapeHtml(t('Grouping Series Menu New Subgroup'))}</span></button>`
                : '',
            node.customized
                ? `<button type="button" data-action="restore-name"><i class="fa-solid fa-arrow-rotate-left"></i><span>${escapeHtml(t('Grouping Restore Automatic Name', { name: automaticName }))}</span></button>`
                : '',
            `<button type="button" class="pas-gm-mobile-delete" data-action="delete"><i class="fa-solid fa-trash"></i><span>${escapeHtml(t('Grouping Series Menu Delete'))}</span></button>`,
        ].filter(Boolean).join('');
        return `<section class="pas-gm-series${expanded ? '' : ' collapsed'}${indent ? ' pas-gm-nested' : ''}"
            data-series-key="${escapeAttr(node.key)}" data-automatic-name="${escapeAttr(automaticName)}" data-customized="${node.customized ? '1' : '0'}" data-depth="${indent}" data-depth-exceeded="${depthExceeded ? '1' : '0'}" data-drop-label="${escapeAttr(t('Grouping Drag Hint'))}" style="--pas-gm-depth:${indent}"${isCustom ? ' data-custom-group="1"' : ''}>
            <div class="pas-gm-series-header">
                ${relationship}
                ${nestingEnabled ? `<span class="pas-gm-drag-handle" draggable="true" title="${escapeAttr(t('Grouping Drag Handle Title'))}"><i class="fa-solid fa-grip-vertical"></i></span>` : ''}
                <button class="pas-gm-series-toggle" type="button" aria-expanded="${expanded}">
                    <span class="pas-gm-series-icon"><i class="fa-regular fa-folder${expanded ? '-open' : ''}"></i></span>
                    <span class="pas-gm-series-name" title="${escapeAttr(nameTitle)}">${escapeHtml(node.displayName)}</span>
                    <i class="fa-solid fa-chevron-down pas-gm-chevron"></i>
                </button>
                <button class="pas-gm-rename-btn" type="button" aria-label="${escapeAttr(t('Grouping Rename Inline', { name: node.displayName }))}" title="${escapeAttr(t('Grouping Series Menu Rename'))}"><i class="fa-solid fa-pen"></i></button>
                ${isCustom ? `<span class="pas-gm-origin" title="${escapeAttr(t('Grouping Custom Badge'))}"><i class="fa-solid fa-wand-magic-sparkles"></i></span>` : ''}
                <span class="pas-gm-series-count">${node.items.length}</span>
                <button class="pas-gm-series-menu-btn" type="button" aria-label="${escapeAttr(t('Grouping Group Actions'))}" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
            </div>
            <div class="pas-gm-series-body">${renderModernPresetRows(node)}</div>
            <div class="pas-gm-mobile-actions">${mobileActions}</div>
        </section>`;
    }).join('');

    const empty = `<div class="pas-gm-no-results"><i class="fa-solid fa-magnifying-glass"></i><span>${escapeHtml(t('Grouping No Results'))}</span></div>`;
    return `<div class="pas-gm-popup">
        <div class="pas-gm-header">
            <div class="pas-gm-header-left"><span class="pas-gm-title-icon"><i class="fa-solid fa-layer-group"></i></span><div><h3>${escapeHtml(t('Grouping Manage Title'))}</h3><p>${escapeHtml(t('Grouping Manage Desc'))}</p></div></div>
            <div class="pas-gm-header-actions">
                <button class="pas-gm-new-group-btn" type="button" aria-label="${escapeAttr(t('Grouping New Group Btn'))}"><i class="fa-solid fa-plus"></i><span class="pas-gm-label-long">${escapeHtml(t('Grouping New Group Btn'))}</span><span class="pas-gm-label-short">${escapeHtml(t('Grouping New Group Short'))}</span></button>
                <button class="pas-gm-undo-btn" type="button" title="${escapeAttr(t('Grouping Undo'))}" aria-label="${escapeAttr(t('Grouping Undo'))}" disabled><i class="fa-solid fa-rotate-left"></i><span>${escapeHtml(t('Grouping Undo'))}</span></button>
                <button class="pas-gm-redo-btn" type="button" title="${escapeAttr(t('Grouping Redo'))}" aria-label="${escapeAttr(t('Grouping Redo'))}" disabled><i class="fa-solid fa-rotate-right"></i><span>${escapeHtml(t('Grouping Redo'))}</span></button>
                <button class="pas-gm-reset-all-btn" type="button" title="${escapeAttr(t('Grouping Reset All'))}" aria-label="${escapeAttr(t('Grouping Reset All'))}"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="pas-gm-label-long">${escapeHtml(t('Grouping Reset All'))}</span><span class="pas-gm-label-short">${escapeHtml(t('Grouping Reset All Short'))}</span></button>
            </div>
        </div>
        <div class="pas-gm-history-status" role="status" aria-live="polite" hidden></div>
        <div class="pas-gm-toolbar">
            <label class="pas-gm-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" value="${escapeAttr(_gmSearchQuery)}" placeholder="${escapeAttr(t('Grouping Search Placeholder'))}" aria-label="${escapeAttr(t('Grouping Search Placeholder'))}" autocomplete="off"></label>
        </div>
        <div class="pas-gm-body">
            <div class="pas-gm-summary">
                <span><strong>${summary.groups}</strong>${escapeHtml(t('Grouping Summary Groups'))}</span>
                <span><strong>${summary.presets}</strong>${escapeHtml(t('Grouping Summary Presets'))}</span>
                <span><strong>${summary.manual}</strong>${escapeHtml(t('Grouping Summary Manual'))}</span>
            </div>
            <div class="pas-gm-list">${cards || empty}</div>
        </div>
        <div class="pas-gm-auto-zone" data-series="__auto__"><i class="fa-solid fa-wand-magic-sparkles"></i><div><strong>${escapeHtml(t('Grouping Auto Zone Title'))}</strong><span>${escapeHtml(t('Grouping Auto Zone Hint'))}</span></div></div>
    </div>`;
}

/**
 * 保存分组设置到 extensionSettings（AI-0 极简化：只保存 overrides；嵌套模式下同步 groupingTree）
 * @param {object} overrides - groupingManualOverrides 映射
 * @param {object|null} [groupingTree=null] - 嵌套分组树映射；传 null 表示不修改 groupingTree
 */
function saveGroupingSettings(overrides, groupingTree = null) {
    const update = { groupingManualOverrides: { ...overrides } };
    if (groupingTree !== null) {
        update.groupingTree = { ...groupingTree };
    }
    batchUpdate(update);
    logger.debug('[saveGroupingSettings] saved, calling refreshTakeover');
    try {
        // Bug B: 直接传参强制刷新，绕过 getSettings() 时序问题
        refreshTakeover({ force: true, _overrides: { ...overrides }, _tree: groupingTree !== null ? { ...groupingTree } : null });
    } catch (e) {
        logger.error('[saveGroupingSettings] refreshTakeover failed:', e);
    }
    if (_gmPanelCtx?.refreshData) {
        Promise.resolve().then(async () => {
            try { await _gmPanelCtx.refreshData(); } catch (e) {
                logger.error('[saveGroupingSettings] refreshData failed:', e);
            }
        }).catch(() => {});
        logger.debug('[saveGroupingSettings] refreshData called');
    }
}

function captureOrganizationState(keys = ORGANIZATION_STATE_KEYS) {
    const settings = getSettings();
    const snapshot = {};
    for (const key of keys) {
        snapshot[key] = key === PENDING_GROUPS_STATE_KEY
            ? [..._pendingCustomGroups]
            : structuredClone(settings[key] ?? {});
    }
    return snapshot;
}

function updateOrganizationHistoryUI(container, message = null) {
    if (!container) return;
    const status = _gmOrganizationHistory.getStatus();
    const undo = container.querySelector('.pas-gm-undo-btn');
    const redo = container.querySelector('.pas-gm-redo-btn');
    const live = container.querySelector('.pas-gm-history-status');
    const configure = (button, enabled, baseLabelKey, actionLabelKey, actionKey) => {
        if (!button) return;
        button.disabled = !enabled;
        const label = enabled && actionKey
            ? t(actionLabelKey, { action: t(actionKey) })
            : t(baseLabelKey);
        button.setAttribute('aria-label', label.trim());
        button.setAttribute('title', label.trim());
    };
    configure(undo, status.canUndo, 'Grouping Undo', 'Grouping Undo Action', status.undoLabel);
    configure(redo, status.canRedo, 'Grouping Redo', 'Grouping Redo Action', status.redoLabel);
    if (live && message !== null) {
        live.textContent = message;
        live.hidden = !message;
    }
}

function recordOrganizationChange(label, keys, before, container) {
    const recorded = _gmOrganizationHistory.record({
        label,
        before,
        after: captureOrganizationState(keys),
    });
    if (recorded) {
        updateOrganizationHistoryUI(container, t('Grouping Change Saved', { action: t(label) }));
    }
    return recorded;
}

function applyOrganizationState(snapshot, container) {
    const updates = {};
    for (const [key, value] of Object.entries(snapshot)) {
        if (key === PENDING_GROUPS_STATE_KEY) {
            _pendingCustomGroups = new Set(Array.isArray(value) ? value : []);
        } else {
            updates[key] = structuredClone(value);
        }
    }
    if (Object.keys(updates).length > 0) batchUpdate(updates);
    _gmOverrides = { ...(getSettings().groupingManualOverrides || {}) };
    try {
        Promise.resolve(refreshTakeover({ force: true })).catch(error => {
            logger.error('[applyOrganizationState] refreshTakeover failed:', error);
        });
    } catch (error) {
        logger.error('[applyOrganizationState] refreshTakeover failed:', error);
    }
    refreshGroupingUI(container);
    if (_gmPanelCtx?.refreshData) {
        Promise.resolve().then(() => _gmPanelCtx.refreshData()).catch(error => {
            logger.error('[applyOrganizationState] refreshData failed:', error);
        });
    }
}

function undoOrganizationChange(container) {
    const result = _gmOrganizationHistory.undo(captureOrganizationState());
    if (!result.ok) {
        if (result.reason === 'conflict') {
            const message = t('Grouping Undo Conflict');
            toast.warning(message);
            updateOrganizationHistoryUI(container, message);
        }
        return false;
    }
    applyOrganizationState(result.state, container);
    updateOrganizationHistoryUI(container, t('Grouping Undo Done', { action: t(result.label) }));
    return true;
}

function redoOrganizationChange(container) {
    const result = _gmOrganizationHistory.redo(captureOrganizationState());
    if (!result.ok) {
        if (result.reason === 'conflict') {
            const message = t('Grouping Undo Conflict');
            toast.warning(message);
            updateOrganizationHistoryUI(container, message);
        }
        return false;
    }
    applyOrganizationState(result.state, container);
    updateOrganizationHistoryUI(container, t('Grouping Redo Done', { action: t(result.label) }));
    return true;
}

// =====================================================
// 嵌套分组工具函数
// =====================================================

/**
 * 计算节点在 groupingTree 中的深度（通过共享函数 getNodePath）
 * @param {object} tree - groupingTree: { [childNormKey]: parentNormKey }
 * @param {string} normKey - 归一化系列键
 * @returns {number} 深度（根节点 = 0），不存在时返回 0
 */
function getNodeDepth(tree, normKey) {
    const path = getNodePath(tree, normKey);
    return path.length > 0 ? path.length - 1 : 0;
}

/**
 * 检查 ancestorKey 是否是 childKey 的祖先节点（用于循环检测）
 * @param {object} tree - groupingTree
 * @param {string} childKey - 归一化系列键（起点）
 * @param {string} ancestorKey - 疑似祖先的归一化系列键
 * @returns {boolean}
 */
function isAncestor(tree, childKey, ancestorKey) {
    const path = getNodePath(tree, childKey);
    // ancestorKey 必须在 childKey 的路径中，且不是 childKey 自身（即索引 < path.length - 1）
    const idx = path.indexOf(ancestorKey);
    return idx >= 0 && idx < path.length - 1;
}

/**
 * 判断两个系列是否属于同一家族树，允许 diff 比较
 * （AT0-diff-series：嵌套分组模式下，父子/兄弟/远亲均可比较）
 * @param {string} seriesKeyA - 预设A的归一化系列键
 * @param {string} seriesKeyB - 预设B的归一化系列键
 * @param {object} settings - 完整的 settings 对象
 * @returns {boolean}
 */
function arePresetsComparable(seriesKeyA, seriesKeyB, settings) {
    // 边界保护：空值不可比较
    if (!seriesKeyA || !seriesKeyB) return false;

    // 未启用嵌套 → 回退到严格同系列判断
    if (!settings.nestingEnabled) {
        return seriesKeyA === seriesKeyB;
    }

    // 同一系列，快速通过
    if (seriesKeyA === seriesKeyB) return true;

    const tree = settings.groupingTree || {};

    // groupingTree 为空等同于无嵌套
    if (Object.keys(tree).length === 0) {
        return seriesKeyA === seriesKeyB;
    }

    // 构建 A 的祖先链（包含自身）
    const ancestorsA = new Set();
    let current = seriesKeyA;
    while (current) {
        if (ancestorsA.has(current)) break; // 循环引用防护
        ancestorsA.add(current);
        current = tree[current]; // 上溯父节点
    }

    // 检查 B 的祖先链是否与 A 有交集
    const visitedB = new Set();
    current = seriesKeyB;
    while (current) {
        if (ancestorsA.has(current)) return true; // 找到共同祖先
        if (visitedB.has(current)) break; // B 链自身的循环引用防护
        visitedB.add(current);
        current = tree[current];
    }

    return false;
}

// =====================================================
// 分组操作
// =====================================================

/**
 * 执行分组移动：将 childKey 移到 newParentKey 下（嵌套模式）
 *
 * 安全防护：
 *   - 循环检测：newParentKey 不能是 childKey 的后代
 *   - 深度检测：childKey 在新位置下的深度不能超过 nestingMaxDepth
 *   - 拖到「自动分组」区域 = 提升为根节点（删除 groupingTree 中的条目）
 *
 * @param {string} childKey - 要移动的分组的归一化键
 * @param {string} newParentKey - 目标父分组的归一化键（或 '__auto__' 提升为根）
 * @param {HTMLElement} container - 弹窗容器
 */
function performMoveGroup(childKey, newParentKey, container) {
    const settings = getSettings();
    const tree = { ...(settings.groupingTree || {}) };
    const nestingMaxDepth = settings.nestingMaxDepth || 3;

    // 拖到"自动分组"区域 = 提升为根节点
    if (newParentKey === '__auto__') {
        const before = captureOrganizationState(['groupingTree', PENDING_GROUPS_STATE_KEY]);
        // 从 _pendingCustomGroups 中移除（如果它是空自定义分组）
        for (const name of _pendingCustomGroups) {
            if (normalizeSeriesKey(name) === childKey) {
                _pendingCustomGroups.delete(name);
                break;
            }
        }
        delete tree[childKey];
        saveGroupingSettings(_gmOverrides, tree);
        recordOrganizationChange('Grouping Action Move Group', ['groupingTree', PENDING_GROUPS_STATE_KEY], before, container);
        refreshGroupingUI(container);
        return;
    }

    // 不能移到自身
    if (childKey === newParentKey) return;

    // 循环检测：newParentKey 不能是 childKey 的后代
    if (isAncestor(tree, newParentKey, childKey)) {
        toast.warning(t('Grouping Move Cycle Error'));
        return;
    }

    // 深度检测：childKey 在 newParentKey 下的新深度不能超过 maxDepth
    const newDepth = getNodeDepth(tree, newParentKey) + 1;
    if (newDepth >= nestingMaxDepth) {
        toast.warning(t('Grouping Move Depth Error', { max: nestingMaxDepth }));
        return;
    }

    const before = captureOrganizationState(['groupingTree', PENDING_GROUPS_STATE_KEY]);

    // 从 _pendingCustomGroups 中移除（如果它是空自定义分组）
    for (const name of _pendingCustomGroups) {
        if (normalizeSeriesKey(name) === childKey) {
            _pendingCustomGroups.delete(name);
            break;
        }
    }

    // 写入新父子关系（如果 childKey 已有旧父节点，直接覆盖）
    tree[childKey] = newParentKey;

    saveGroupingSettings(_gmOverrides, tree);
    recordOrganizationChange('Grouping Action Move Group', ['groupingTree', PENDING_GROUPS_STATE_KEY], before, container);
    refreshGroupingUI(container);
}

/**
 * 执行移动：将预设移到目标系列（AI-0 重构 + AQ-1：移入后清理 _pendingCustomGroups）
 */
function performMove(presetName, targetSeriesKey, container, targetSeriesName = null) {
    const keys = ['groupingManualOverrides', PENDING_GROUPS_STATE_KEY];
    const before = captureOrganizationState(keys);
    // 拖到"自动分组"区 = 恢复自动识别
    if (targetSeriesKey === '__auto__') {
        delete _gmOverrides[presetName];
        saveGroupingSettings(_gmOverrides);
        recordOrganizationChange('Grouping Action Move Preset', keys, before, container);
        refreshGroupingUI(container);
        return;
    }
    // 如果目标系列与自动检测的系列相同，删除覆盖
    const parsed = parsePresetName(presetName);
    const autoKey = normalizeSeriesKey(parsed.series);
    if (autoKey === targetSeriesKey) {
        delete _gmOverrides[presetName];
    } else {
        // 找到目标系列的显示名（从现有 groups 中查找，或从 _pendingCustomGroups 中查找）
        const { groups } = buildGroupingData();
        const targetGroup = groups.find(g => normalizeSeriesKey(g.series) === targetSeriesKey);
        if (targetGroup) {
            _gmOverrides[presetName] = targetGroup.series;
        } else {
            // AQ-1: 可能是从 _pendingCustomGroups 来的空分组
            const pendingName = [..._pendingCustomGroups].find(n => normalizeSeriesKey(n) === targetSeriesKey);
            _gmOverrides[presetName] = pendingName || targetSeriesName || targetSeriesKey;
        }
    }
    // AQ-1: 有预设移入后，该分组不再是"待建"状态
    for (const pName of _pendingCustomGroups) {
        if (normalizeSeriesKey(pName) === targetSeriesKey) {
            _pendingCustomGroups.delete(pName);
            break;
        }
    }
    saveGroupingSettings(_gmOverrides);
    recordOrganizationChange('Grouping Action Move Preset', keys, before, container);
    refreshGroupingUI(container);
}

/**
 * 重置单个预设：删除手动覆盖（AI-0：恢复自动分组）
 */
function performResetOne(presetName, container) {
    const keys = ['groupingManualOverrides'];
    const before = captureOrganizationState(keys);
    delete _gmOverrides[presetName];
    saveGroupingSettings(_gmOverrides);
    recordOrganizationChange('Grouping Action Restore Auto', keys, before, container);
    refreshGroupingUI(container);
}

/**
 * 重置全部（AI-0：清空所有覆盖）
 */
function performResetAll(container) {
    const keys = ['groupingManualOverrides', 'groupingTree'];
    const before = captureOrganizationState(keys);
    for (const key of Object.keys(_gmOverrides)) delete _gmOverrides[key];
    saveGroupingSettings(_gmOverrides, {});
    recordOrganizationChange('Grouping Action Reset All', keys, before, container);
    refreshGroupingUI(container);
}

/**
 * 刷新分组 UI
 */
function refreshGroupingUI(container) {
    if (!container) return;
    closeGroupManagerContextMenu();
    // Bug A: 保存当前展开状态，避免 innerHTML 重建后全部收起
    const settings = getSettings();
    let html;
    if (settings.nestingEnabled) {
        const tree = settings.groupingTree || {};
        const rootNodes = buildNestedGroupTree(_gmAllNames, _gmOverrides, tree, settings.nestingMaxDepth, settings.groupingSeriesAliases || {});
        html = renderModernGroupingHTML(flattenGroupingNodes(rootNodes));
    } else {
        const { groups } = buildGroupingData();
        html = renderModernGroupingHTML(normalizeGroupingNodes(groups));
    }
    // P1-5: 合并为单次 innerHTML 赋值，消除中间 tempDiv DOM 解析
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const bodyEl = container.querySelector('.pas-gm-body');
    if (!bodyEl) return;
    const newBody = tempDiv.querySelector('.pas-gm-body');
    if (newBody) {
        bodyEl.innerHTML = newBody.innerHTML;
    }
    // AW-1: auto-zone 现在在 .pas-gm-body 外部，也需要同步更新
    const oldAutoZone = container.querySelector('.pas-gm-auto-zone');
    const newAutoZone = tempDiv.querySelector('.pas-gm-auto-zone');
    if (oldAutoZone && newAutoZone) {
        oldAutoZone.replaceWith(newAutoZone);
    }
    // Bug A: 恢复展开状态
    // 重新绑定事件
    bindGroupingEvents(container);
}

function aliasErrorMessage(reason) {
    if (reason === 'empty') return t('Grouping Alias Error Empty');
    if (reason === 'too-long') return t('Grouping Alias Error Too Long');
    if (reason === 'duplicate') return t('Grouping Alias Error Duplicate');
    return t('Grouping Alias Error Save');
}

function visibleGroupingNames(container) {
    return [...container.querySelectorAll('.pas-gm-series')].map(card => ({
        canonicalKey: card.getAttribute('data-series-key') || '',
        displayName: card.querySelector('.pas-gm-series-name')?.textContent || '',
    }));
}

function normalizePresetNames(names) {
    const unique = new Map();
    for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const normalized = name.trim();
        const key = normalized.toLocaleLowerCase();
        if (!unique.has(key)) unique.set(key, normalized);
    }
    return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

function renderCurrentGroupingManager() {
    const { groups } = buildGroupingData();
    const settings = getSettings();
    if (!settings.nestingEnabled) return renderModernGroupingHTML(normalizeGroupingNodes(groups));

    const rootNodes = buildNestedGroupTree(
        _gmAllNames,
        _gmOverrides,
        settings.groupingTree || {},
        settings.nestingMaxDepth,
        settings.groupingSeriesAliases || {},
    );
    return renderModernGroupingHTML(flattenGroupingNodes(rootNodes));
}

function prepareGroupingManager(panelCtx, presetNames) {
    clearGroupingManagerState();
    _gmPanelCtx = panelCtx || null;
    _gmAllNames = normalizePresetNames(presetNames);
    return _gmAllNames.length ? renderCurrentGroupingManager() : '';
}

function restoreGroupAlias(seriesKey, container) {
    const keys = ['groupingSeriesAliases'];
    const before = captureOrganizationState(keys);
    const aliases = { ...(getSettings().groupingSeriesAliases || {}) };
    for (const key of Object.keys(aliases)) {
        if (normalizeSeriesKey(key) === normalizeSeriesKey(seriesKey)) delete aliases[key];
    }
    batchUpdate({ groupingSeriesAliases: aliases });
    recordOrganizationChange('Grouping Action Restore Name', keys, before, container);
    refreshTakeover({ force: true });
    refreshGroupingUI(container);
    container.querySelector(`[data-series-key="${CSS.escape(seriesKey)}"] .pas-gm-series-toggle`)?.focus();
}

function beginInlineRename(seriesKey, container) {
    const card = [...container.querySelectorAll('.pas-gm-series')]
        .find(item => item.getAttribute('data-series-key') === seriesKey);
    const header = card?.querySelector('.pas-gm-series-toggle');
    const nameElement = card?.querySelector('.pas-gm-series-name');
    const trigger = card?.querySelector('.pas-gm-rename-btn');
    if (!card || !header || !nameElement || !trigger || card.querySelector('.pas-gm-name-editor')) return;

    const automaticName = card.getAttribute('data-automatic-name') || nameElement.textContent || seriesKey;
    const currentName = nameElement.textContent || automaticName;
    const errorId = `pas-gm-name-error-${Math.random().toString(36).slice(2)}`;
    const editorElement = document.createElement('span');
    editorElement.className = 'pas-gm-name-editor';
    editorElement.innerHTML = `<input class="pas-gm-name-input" type="text" value="${escapeAttr(currentName)}" aria-label="${escapeAttr(t('Grouping Alias Input Label'))}" aria-describedby="${escapeAttr(errorId)}" autocomplete="off"><span class="pas-gm-name-error" id="${escapeAttr(errorId)}" role="alert"></span>`;
    nameElement.hidden = true;
    nameElement.after(editorElement);

    const input = editorElement.querySelector('.pas-gm-name-input');
    const error = editorElement.querySelector('.pas-gm-name-error');
    let composing = false;
    let closed = false;
    let confirmFromTrigger = null;
    const idleLabel = trigger.getAttribute('aria-label') || '';
    const idleTitle = trigger.getAttribute('title') || '';

    trigger.hidden = false;
    trigger.setAttribute('data-editing', 'true');
    trigger.classList.add('is-confirm');
    trigger.innerHTML = '<i class="fa-solid fa-check"></i>';
    trigger.setAttribute('aria-label', t('Grouping Confirm Rename'));
    trigger.setAttribute('title', t('Grouping Confirm Rename'));

    const closeWithoutRefresh = () => {
        if (closed) return;
        closed = true;
        if (confirmFromTrigger) trigger.removeEventListener('pas-gm-confirm-rename', confirmFromTrigger);
        editorElement.remove();
        nameElement.hidden = false;
        trigger.hidden = false;
        trigger.removeAttribute('data-editing');
        trigger.classList.remove('is-confirm');
        trigger.innerHTML = '<i class="fa-solid fa-pen"></i>';
        trigger.setAttribute('aria-label', idleLabel);
        trigger.setAttribute('title', idleTitle);
        trigger.focus();
    };
    const controller = createGroupAliasEditor({
        validate: value => validateSeriesAlias(value, visibleGroupingNames(container), seriesKey),
        invalid: reason => {
            error.textContent = aliasErrorMessage(reason);
            input.setAttribute('aria-invalid', 'true');
            input.focus();
        },
        cancel: closeWithoutRefresh,
        save: value => {
            if (value === currentName) {
                closeWithoutRefresh();
                return;
            }
            if (closed) return;
            closed = true;
            const keys = ['groupingSeriesAliases'];
            const before = captureOrganizationState(keys);
            const aliases = { ...(getSettings().groupingSeriesAliases || {}) };
            for (const key of Object.keys(aliases)) {
                if (normalizeSeriesKey(key) === normalizeSeriesKey(seriesKey)) delete aliases[key];
            }
            if (value !== automaticName) aliases[seriesKey] = value;
            batchUpdate({ groupingSeriesAliases: aliases });
            recordOrganizationChange('Grouping Action Rename Group', keys, before, container);
            refreshTakeover({ force: true });
            refreshGroupingUI(container);
            container.querySelector(`[data-series-key="${CSS.escape(seriesKey)}"] .pas-gm-series-toggle`)?.focus();
        },
    });
    confirmFromTrigger = () => controller.commit(input.value);
    trigger.addEventListener('pas-gm-confirm-rename', confirmFromTrigger);

    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('input', () => {
        error.textContent = '';
        input.removeAttribute('aria-invalid');
    });
    input.addEventListener('keydown', async event => {
        const handled = await controller.handleKeyDown({ key: event.key, isComposing: composing || event.isComposing }, input.value);
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    input.addEventListener('blur', event => {
        if (closed || event.relatedTarget === trigger || event.relatedTarget?.closest?.('.pas-gm-name-editor')) return;
        queueMicrotask(() => controller.handleBlur(input.value));
    });
    input.focus();
    input.select();
}

// =====================================================
// 分组 CRUD 操作
// =====================================================

/**
 * 显示"移动到…"对话框
 */
async function showMoveDialog(presetName, container) {
    const { groups } = buildGroupingData();
    const currentInfo = parsePresetName(presetName);
    const currentOverride = _gmOverrides[presetName];
    const currentSeries = currentOverride || currentInfo.series;
    const currentKey = normalizeSeriesKey(currentSeries);

    const optionsHtml = groups
        .filter(g => normalizeSeriesKey(g.series) !== currentKey)
        .map(g => `<div class="pas-gm-move-option" data-target-key="${escapeAttr(normalizeSeriesKey(g.series))}" data-target-name="${escapeAttr(g.series)}">
            <i class="fa-solid fa-box-open"></i> ${escapeHtml(g.series)}
            <span class="pas-gm-move-count">${g.items.length}</span>
        </div>`).join('');

    const html = `
    <div class="pas-gm-move-dialog">
        <h4>${escapeHtml(t('Grouping Move Dialog Title'))}</h4>
        <p class="pas-gm-move-desc">${escapeHtml(t('Grouping Move Dialog Desc', { name: presetName }))}</p>
        <div class="pas-gm-move-list">
            ${optionsHtml}
            <div class="pas-gm-move-option pas-gm-move-new" data-target-key="__new__">
                <i class="fa-solid fa-plus"></i> ${escapeHtml(t('Grouping Move New Series'))}
            </div>
        </div>
    </div>`;

    const popup = createPopupSafe(html, 'DISPLAY', {
        okButton: false,
        cancelButton: t('Cancel'),
        allowVerticalScrolling: true,
    });
    if (!popup) return;

    const showPromise = popup.show();

    // 事件绑定（等 DOM 出现）
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, DOM_BIND_DELAY_MS)));

    const moveDialog = document.querySelector('.pas-gm-move-dialog');
    if (moveDialog) {
        moveDialog.querySelectorAll('.pas-gm-move-option').forEach(opt => {
            opt.addEventListener('click', async () => {
                const targetKey = opt.getAttribute('data-target-key');
                if (targetKey === '__new__') {
                    const inputPopup = createPopupSafe(
                        t('Grouping Move New Prompt'),
                        'INPUT',
                        { okButton: t('Confirm'), cancelButton: t('Cancel'), rows: 1 },
                        ''
                    );
                    let newName = null;
                    if (inputPopup) {
                        try { newName = await inputPopup.show(); } catch (_) {}
                    } else {
                        newName = window.prompt(t('Grouping Move New Prompt'));
                    }
                    if (newName === null || newName === undefined || newName === false) return;
                    newName = String(newName).trim();
                    if (!newName) return;
                    performMove(presetName, normalizeSeriesKey(newName), container, newName);
                } else {
                    const targetName = opt.getAttribute('data-target-name') || targetKey;
                    performMove(presetName, targetKey, container, targetName);
                }
                try { popup.completeCancelled?.(); } catch (_) {}
            });
        });
    }

    await showPromise;
}

/**
 * AQ-1: 创建自定义空分组
 */
async function onCreateCustomGroup(container) {
    const inputPopup = createPopupSafe(
        t('Grouping New Group Prompt'),
        'INPUT',
        { okButton: t('Confirm'), cancelButton: t('Cancel'), rows: 1 },
        ''
    );
    let name = null;
    if (inputPopup) {
        try { name = await inputPopup.show(); } catch (_) {}
    } else {
        name = window.prompt(t('Grouping New Group Prompt'));
    }
    if (name === null || name === undefined || name === false) return;
    const trimmed = String(name).trim().slice(0, 120); // 限制长度防止滥用
    if (!trimmed) return;

    // 检查是否已存在同名分组
    const { groups } = buildGroupingData();
    const targetKey = normalizeSeriesKey(trimmed);
    const exists = groups.some(g => normalizeSeriesKey(g.series) === targetKey)
        || [..._pendingCustomGroups].some(n => normalizeSeriesKey(n) === targetKey);
    if (exists) {
        toast.warning(t('Grouping Group Exists', { name: trimmed }));
        return;
    }

    // 检查 groupingTree 中是否已存在同名键（Bug 3 修复）
    const settings = getSettings();
    const tree = settings.groupingTree || {};
    const treeKeys = new Set([...Object.keys(tree), ...Object.values(tree)].map(k => normalizeSeriesKey(k)));
    if (treeKeys.has(targetKey)) {
        toast.warning(t('Grouping Group Exists', { name: trimmed }));
        return;
    }

    // 添加到待建空分组集合，刷新 UI 让其显示为空卡片
    const keys = [PENDING_GROUPS_STATE_KEY];
    const before = captureOrganizationState(keys);
    _pendingCustomGroups.add(trimmed);
    recordOrganizationChange('Grouping Action Create Group', keys, before, container);
    toast.success(t('Grouping New Group Created', { name: escapeHtml(trimmed) }));
    refreshGroupingUI(container);
}

/** Enter the inline display-name editor without changing group identity. */
function onRenameSeriesGroup(oldSeriesKey, container) {
    beginInlineRename(oldSeriesKey, container);
}

/**
 * 删除分组（增强版：处理嵌套子分组上移）
 * @param {string} seriesKey - 要删除的分组的归一化键
 * @param {HTMLElement} container - 弹窗容器
 */
async function onDeleteCustomGroup(seriesKey, container) {
    const settings = getSettings();
    const tree = { ...(settings.groupingTree || {}) };
    const { groups } = buildGroupingData();
    const group = groups.find(g => normalizeSeriesKey(g.series) === seriesKey);
    const displayName = group ? group.series : seriesKey;

    // 检查是否有子分组
    const childKeys = [];
    for (const [childKey, parentVal] of Object.entries(tree)) {
        if (parentVal === seriesKey) {
            childKeys.push(childKey);
        }
    }

    let confirmHtml = t('Grouping Delete Group Confirm', { name: escapeHtml(displayName) });
    if (childKeys.length > 0) {
        confirmHtml = t('Grouping Delete Children Confirm', { count: childKeys.length });
    }

    const ok = await confirmSafe(
        t('Grouping Menu Delete Group'),
        confirmHtml
    );
    if (!ok) return;

    const keys = ['groupingManualOverrides', 'groupingTree', PENDING_GROUPS_STATE_KEY];
    const before = captureOrganizationState(keys);

    // 处理子分组：将它们提升到被删分组的父节点（或成为根节点）
    const deletedParent = tree[seriesKey];
    for (const childKey of childKeys) {
        if (deletedParent) {
            tree[childKey] = deletedParent;
        } else {
            delete tree[childKey];
        }
    }

    // 删除 groupingTree 中以 seriesKey 为 child 的条目
    delete tree[seriesKey];

    // 删除该分组内所有预设的 overrides
    if (group) {
        for (const it of group.items) {
            delete _gmOverrides[it.presetName];
        }
    }

    // 也从 _pendingCustomGroups 移除
    for (const pName of _pendingCustomGroups) {
        if (normalizeSeriesKey(pName) === seriesKey) {
            _pendingCustomGroups.delete(pName);
            break;
        }
    }

    saveGroupingSettings(_gmOverrides, tree);
    recordOrganizationChange('Grouping Action Delete Group', keys, before, container);
    refreshGroupingUI(container);
}

/**
 * 在指定父分组下创建子分组（嵌套模式）
 * @param {string} parentKey - 父分组的归一化系列键
 * @param {HTMLElement} container - 弹窗容器
 */
async function onCreateSubGroup(parentKey, container) {
    const settings = getSettings();
    const nestingMaxDepth = settings.nestingMaxDepth || 3;
    const tree = { ...(settings.groupingTree || {}) };

    // 检查父节点深度
    const parentDepth = getNodeDepth(tree, parentKey);
    if (parentDepth >= nestingMaxDepth - 1) {
        toast.warning(t('Grouping Subgroup Depth Error'));
        return;
    }

    // 弹出输入框
    const inputPopup = createPopupSafe(
        t('Grouping New Subgroup'),
        'INPUT',
        { okButton: t('Confirm'), cancelButton: t('Cancel'), rows: 1 },
        ''
    );
    let name = null;
    if (inputPopup) {
        try { name = await inputPopup.show(); } catch (_) {}
    } else {
        name = window.prompt(t('Grouping New Subgroup'));
    }
    if (name === null || name === undefined || name === false) return;
    const trimmed = String(name).trim().slice(0, 120);
    if (!trimmed) return;

    const newChildKey = normalizeSeriesKey(trimmed);

    // 检查键是否已存在于 groupingTree 的 key 或 value 集合中
    const existingKeys = new Set([
        ...Object.keys(tree),
        ...Object.values(tree),
        ...Object.keys(_gmOverrides).map(pn => normalizeSeriesKey(parsePresetName(pn).series || pn)),
    ]);
    for (const pName of _pendingCustomGroups) {
        existingKeys.add(normalizeSeriesKey(pName));
    }
    if (existingKeys.has(newChildKey)) {
        toast.warning(t('Grouping Group Exists', { name: trimmed }));
        return;
    }

    // 写入分组树
    const keys = ['groupingTree'];
    const before = captureOrganizationState(keys);
    tree[newChildKey] = parentKey;
    saveGroupingSettings(_gmOverrides, tree);
    recordOrganizationChange('Grouping Action Create Subgroup', keys, before, container);
    toast.success(t('Grouping Subgroup Created', { name: trimmed }));
    refreshGroupingUI(container);
}

// =====================================================
// 事件绑定
// =====================================================

// P1-6: bindDragEvents — 拖拽相关事件（分组拖拽 + 预设拖拽 + 拖放目标）
function bindDragEvents(container) {
    const expandCard = card => {
        const key = card?.getAttribute('data-series-key');
        if (!key || !card.classList.contains('collapsed')) return;
        _gmExpandedKeys.add(key);
        card.classList.remove('collapsed');
        card.querySelector('.pas-gm-series-toggle')?.setAttribute('aria-expanded', 'true');
        const icon = card.querySelector('.pas-gm-series-icon i');
        icon?.classList.remove('fa-folder');
        icon?.classList.add('fa-folder-open');
    };
    const finishDrag = () => {
        _gmDragPayload = null;
        _gmHoverExpander.cancelAll();
        container.classList.remove('pas-gm-drag-active');
        container.querySelectorAll('.pas-gm-drop-zone, .pas-gm-drop-target, .drag-over').forEach(el => {
            el.classList.remove('pas-gm-drop-zone', 'pas-gm-drop-target', 'drag-over');
            el.removeAttribute('data-drop-kind');
        });
    };
    // --- 分组卡片拖拽源（嵌套模式：从 ⋮⋮ 手柄发起分组移动） ---
    container.querySelectorAll('.pas-gm-drag-handle').forEach(handle => {
        handle.addEventListener('dragstart', (e) => {
            const seriesCard = handle.closest('.pas-gm-series');
            if (!seriesCard) return;
            const seriesKey = seriesCard.getAttribute('data-series-key');
            if (!seriesKey) return;
            _gmDragPayload = { type: 'group', seriesKey };
            container.classList.add('pas-gm-drag-active');
            try {
                e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'group', seriesKey }));
            } catch (_) {
                e.dataTransfer.setData('text/plain', seriesKey);
            }
            e.dataTransfer.effectAllowed = 'move';
            seriesCard.classList.add('dragging');
            container.querySelectorAll('.pas-gm-series').forEach(card => {
                card.classList.add('pas-gm-drop-zone');
            });
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.add('pas-gm-drop-zone');
            e.stopPropagation();
        });

        handle.addEventListener('dragend', () => {
            const seriesCard = handle.closest('.pas-gm-series');
            if (seriesCard) seriesCard.classList.remove('dragging');
            container.querySelectorAll('.pas-gm-series').forEach(card => {
                card.classList.remove('pas-gm-drop-zone', 'pas-gm-drop-target');
            });
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.remove('pas-gm-drop-zone', 'drag-over');
            finishDrag();
        });
    });

    // --- 分组卡片作为拖放目标（接受分组移动） ---
    container.querySelectorAll('.pas-gm-series').forEach(card => {
        card.addEventListener('dragover', (e) => {
            // Bug 修复：getData() 在 dragover 期间受浏览器安全策略限制始终返回空字符串，
            // 因此不能在此处做类型判断。必须无条件 preventDefault() 以允许 drop。
            // 实际类型校验（type === 'group'）在 drop 事件中完成。
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('pas-gm-drop-target');
            card.setAttribute('data-drop-kind', _gmDragPayload?.type || 'unknown');
            // hover 自动展开：拖拽悬浮在折叠分组上片刻后同步展开状态与内容
            if (card.classList.contains('collapsed')) {
                const key = card.getAttribute('data-series-key');
                _gmHoverExpander.schedule(key, () => expandCard(card));
            }
        });

        card.addEventListener('dragleave', (e) => {
            if (!card.contains(e.relatedTarget)) {
                card.classList.remove('pas-gm-drop-target');
                card.removeAttribute('data-drop-kind');
                _gmHoverExpander.cancel(card.getAttribute('data-series-key'));
            }
        });

        card.addEventListener('drop', (e) => {
            e.preventDefault();
            // Bug C: 阻止事件冒泡，防止嵌套子卡片 drop 触发父卡片 drop
            e.stopPropagation();
            card.classList.remove('pas-gm-drop-target');
            card.removeAttribute('data-drop-kind');
            _gmHoverExpander.cancel(card.getAttribute('data-series-key'));
            const raw = e.dataTransfer.getData('text/plain');
            let data = _gmDragPayload;
            try {
                if (raw) data = JSON.parse(raw);
            } catch (_) {}
            const targetKey = card.getAttribute('data-series-key');
            if (!targetKey || !data) return;
            if (data.type === 'item' && data.presetName) performMove(data.presetName, targetKey, container);
            if (data.type === 'group' && data.seriesKey) performMoveGroup(data.seriesKey, targetKey, container);
            finishDrag();
        });
    });

    // --- 预设项拖拽源 ---
    container.querySelectorAll('.pas-gm-preset').forEach(presetEl => {
        presetEl.addEventListener('dragstart', (e) => {
            const presetName = presetEl.getAttribute('data-preset-name');
            _gmDragPayload = { type: 'item', presetName };
            container.classList.add('pas-gm-drag-active');
            try {
                e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'item', presetName }));
            } catch (_) {
                e.dataTransfer.setData('text/plain', presetName);
            }
            e.dataTransfer.effectAllowed = 'move';
            presetEl.classList.add('dragging');
            container.querySelectorAll('.pas-gm-series-body').forEach(body => {
                body.classList.add('pas-gm-drop-zone');
            });
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.add('pas-gm-drop-zone');
        });

        presetEl.addEventListener('dragend', () => {
            presetEl.classList.remove('dragging');
            container.querySelectorAll('.pas-gm-series-body').forEach(body => {
                body.classList.remove('pas-gm-drop-zone', 'drag-over');
            });
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.remove('pas-gm-drop-zone', 'drag-over');
            finishDrag();
        });
    });

    // --- series-body 拖拽目标（仅接受预设项拖拽） ---
    container.querySelectorAll('.pas-gm-series-body').forEach(body => {
        body.addEventListener('dragover', (e) => {
            // Bug 修复：getData() 在 dragover 期间受浏览器安全策略限制始终返回空字符串，
            // 因此不能在此处做类型判断。必须无条件 preventDefault() 以允许 drop。
            // 实际类型校验（type === 'item'）在 drop 事件中完成。
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            body.classList.add('drag-over');
            // hover 自动展开父卡片
            const card = body.closest('.pas-gm-series');
            if (card && card.classList.contains('collapsed')) {
                const key = card.getAttribute('data-series-key');
                _gmHoverExpander.schedule(key, () => expandCard(card));
            }
        });
        body.addEventListener('dragleave', (e) => {
            if (!body.contains(e.relatedTarget)) {
                body.classList.remove('drag-over');
                const card = body.closest('.pas-gm-series');
                if (card) _gmHoverExpander.cancel(card.getAttribute('data-series-key'));
            }
        });
        body.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            body.classList.remove('drag-over');
            const raw = e.dataTransfer.getData('text/plain');
            if (!raw) return;
            let presetName;
            try {
                const data = JSON.parse(raw);
                if (data.type !== 'item') return;
                presetName = data.presetName;
            } catch (_) {
                presetName = raw;
            }
            if (!presetName) return;
            const targetSeries = body.closest('.pas-gm-series');
            const targetKey = targetSeries?.getAttribute('data-series-key');
            if (!targetKey) return;
            performMove(presetName, targetKey, container);
            finishDrag();
        });
    });

    // --- "自动分组"区域拖拽目标（同时接受分组和预设项拖拽） ---
    const autoZone = container.querySelector('.pas-gm-auto-zone');
    if (autoZone) {
        autoZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            autoZone.classList.add('drag-over');
        });
        autoZone.addEventListener('dragleave', (e) => {
            if (!autoZone.contains(e.relatedTarget)) {
                autoZone.classList.remove('drag-over');
            }
        });
        autoZone.addEventListener('drop', (e) => {
            e.preventDefault();
            autoZone.classList.remove('drag-over');
            const raw = e.dataTransfer.getData('text/plain');
            if (!raw) return;
            try {
                const data = JSON.parse(raw);
                if (data.type === 'group' && data.seriesKey) {
                    performMoveGroup(data.seriesKey, '__auto__', container);
                    return;
                }
                if (data.type === 'item' && data.presetName) {
                    performMove(data.presetName, '__auto__', container);
                    return;
                }
            } catch (_) {}
            if (raw) {
                performMove(raw, '__auto__', container);
            }
        });
    }
}

// P1-6: bindMenuEvents — 菜单相关事件（系列 ⋯ 菜单 + 预设 ⋯ 菜单）
function bindMenuEvents(container) {
    // --- 系列级 ⋯ 菜单（嵌套模式：新建子分组、重命名、删除） ---
    container.querySelectorAll('.pas-gm-series-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();

            const seriesCard = btn.closest('.pas-gm-series');
            const seriesKey = seriesCard?.getAttribute('data-series-key');
            if (!seriesKey) return;

            const depthExceeded = seriesCard?.getAttribute('data-depth-exceeded') === '1';
            const nestingEnabled = getSettings().nestingEnabled;
            const customized = seriesCard?.getAttribute('data-customized') === '1';
            const automaticName = seriesCard?.getAttribute('data-automatic-name') || seriesKey;

            const items = [];
            if (nestingEnabled) {
                items.push({
                    action: 'subgroup',
                    iconClass: 'fa-solid fa-plus',
                    label: t('Grouping Series Menu New Subgroup'),
                    disabled: depthExceeded,
                    title: depthExceeded ? t('Grouping Nesting Max Depth Hint') : '',
                });
            }
            items.push({ action: 'rename', iconClass: 'fa-solid fa-pen-to-square', label: t('Grouping Series Menu Rename') });
            if (customized) {
                items.push({
                    action: 'restore-name',
                    iconClass: 'fa-solid fa-arrow-rotate-left',
                    label: t('Grouping Restore Automatic Name', { name: automaticName }),
                });
            }
            items.push({ action: 'delete', iconClass: 'fa-solid fa-trash', label: t('Grouping Series Menu Delete'), danger: true });

            openGroupManagerContextMenu({
                trigger: btn,
                items,
                onSelect: async action => {
                    if (action === 'subgroup') await onCreateSubGroup(seriesKey, container);
                    else if (action === 'rename') await onRenameSeriesGroup(seriesKey, container);
                    else if (action === 'restore-name') restoreGroupAlias(seriesKey, container);
                    else if (action === 'delete') await onDeleteCustomGroup(seriesKey, container);
                },
                onError: error => logger.error('[grouping] series menu action failed:', error),
            });
        });
    });

    // --- 预设 ⋯ 菜单（移动、重置、复制预设名） ---
    container.querySelectorAll('.pas-gm-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();

            const presetEl = btn.closest('.pas-gm-preset');
            const presetName = presetEl?.getAttribute('data-preset-name');
            if (!presetName) return;

            const isManual = !!_gmOverrides[presetName];

            const items = [
                { action: 'move', iconClass: 'fa-solid fa-arrow-right-arrow-left', label: t('Grouping Menu Move To') },
                ...(isManual ? [{ action: 'reset', iconClass: 'fa-solid fa-wand-magic-sparkles', label: t('Grouping Menu Reset Auto') }] : []),
                { action: 'copy-name', iconClass: 'fa-solid fa-copy', label: t('Grouping Menu Copy Name'), separatorBefore: true },
            ];
            openGroupManagerContextMenu({
                trigger: btn,
                items,
                onSelect: async action => {
                    if (action === 'move') {
                        await showMoveDialog(presetName, container);
                    } else if (action === 'reset') {
                        const ok = await confirmSafe(
                            t('Grouping Menu Reset Auto'),
                            t('Grouping Reset Confirm', { name: presetName })
                        );
                        if (ok) performResetOne(presetName, container);
                    } else if (action === 'copy-name') {
                        navigator.clipboard.writeText(presetName)
                            .then(() => toast.success(t('Grouping Copied')))
                            .catch(() => toast.error(t('Copy Failed')));
                    }
                },
                onError: error => logger.error('[grouping] preset menu action failed:', error),
            });
        });
    });
}

// P1-6: bindClickEvents — 常规点击事件（新建分组 + 折叠/展开 + 右键菜单）
function bindClickEvents(container) {
    // --- "+ 新建分组"按钮 ---
    // Bug 修复：该按钮在 .pas-gm-header 中，不在 .pas-gm-body 内，
    // refreshGroupingUI 不会重建 header，导致每次 bindGroupingEvents 调用时
    // addEventListener 不断累积。改用 onclick 赋值避免监听器叠加。
    const newGroupBtn = container.querySelector('.pas-gm-new-group-btn');
    if (newGroupBtn) {
        newGroupBtn.onclick = () => onCreateCustomGroup(container);
    }

    const undoBtn = container.querySelector('.pas-gm-undo-btn');
    if (undoBtn) undoBtn.onclick = () => undoOrganizationChange(container);
    const redoBtn = container.querySelector('.pas-gm-redo-btn');
    if (redoBtn) redoBtn.onclick = () => redoOrganizationChange(container);
    container.onkeydown = event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        const wantsUndo = key === 'z' && !event.shiftKey;
        const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
        if (!wantsUndo && !wantsRedo) return;
        event.preventDefault();
        if (wantsRedo) redoOrganizationChange(container);
        else undoOrganizationChange(container);
    };
    const resetAllBtn = container.querySelector('.pas-gm-reset-all-btn');
    if (resetAllBtn) {
        resetAllBtn.onclick = async () => {
            const ok = await confirmSafe(t('Grouping Reset All'), t('Grouping Reset All Confirm'));
            if (ok) performResetAll(container);
        };
    }
    updateOrganizationHistoryUI(container);

    const searchInput = container.querySelector('.pas-gm-search input');
    if (searchInput) {
        searchInput.oninput = () => {
            _gmSearchQuery = searchInput.value;
            if (_gmSearchTimer) clearTimeout(_gmSearchTimer);
            _gmSearchTimer = setTimeout(() => {
                _gmSearchTimer = null;
                refreshGroupingUI(container);
            }, 100);
        };
    }

    container.querySelectorAll('.pas-gm-rename-btn').forEach(button => {
        button.onclick = event => {
            event.stopPropagation();
            if (button.dataset.editing === 'true') {
                button.dispatchEvent(new Event('pas-gm-confirm-rename'));
                return;
            }
            const key = button.closest('.pas-gm-series')?.getAttribute('data-series-key');
            if (key) beginInlineRename(key, container);
        };
    });

    // --- 折叠/展开系列卡片 ---
    container.querySelectorAll('.pas-gm-series-toggle').forEach(toggleButton => {
        toggleButton.onclick = () => {
            const series = toggleButton.closest('.pas-gm-series');
            const key = series?.getAttribute('data-series-key');
            if (!key) return;
            if (_gmExpandedKeys.has(key)) _gmExpandedKeys.delete(key);
            else _gmExpandedKeys.add(key);
            refreshGroupingUI(container);
        };
    });
    // --- 右键菜单（同预设级 ⋯ 菜单） ---
    container.querySelectorAll('.pas-gm-preset').forEach(presetEl => {
        presetEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const menuBtn = presetEl.querySelector('.pas-gm-menu-btn');
            if (menuBtn) menuBtn.click();
        });
    });
}

function bindMobileGroupActions(container) {
    container.querySelectorAll('.pas-gm-mobile-actions button').forEach(button => {
        button.onclick = async event => {
            event.stopPropagation();
            const seriesKey = button.closest('.pas-gm-series')?.getAttribute('data-series-key');
            const action = button.getAttribute('data-action');
            if (!seriesKey) return;
            if (action === 'subgroup') await onCreateSubGroup(seriesKey, container);
            else if (action === 'restore-name') restoreGroupAlias(seriesKey, container);
            else if (action === 'delete') await onDeleteCustomGroup(seriesKey, container);
        };
    });
}

/**
 * 绑定分组管理弹窗的所有事件（主入口）
 * P1-6: 拆分为 bindDragEvents / bindMenuEvents / bindClickEvents 三个子函数
 */
function bindGroupingEvents(container) {
    if (!container) return;
    // P1-7: refreshGroupingUI 已通过 innerHTML 重建 DOM，元素均为新鲜节点，
    // 无需 cloneNode+replaceChild 来清除旧监听器
    bindClickEvents(container);
    bindMobileGroupActions(container);
    bindDragEvents(container);
    bindMenuEvents(container);
}

/** Mount the production grouping controller into a caller-owned host. */
export function mountGroupingManager(host, {
    panelCtx = null,
    presetNames = null,
    render = true,
} = {}) {
    if (!host || typeof host.querySelector !== 'function') {
        throw new TypeError('mountGroupingManager requires a DOM host element');
    }
    if (_groupingManagerRoot) throw new Error('A grouping manager is already mounted');

    if (render) {
        const names = presetNames ?? getAllPresetNames();
        host.innerHTML = prepareGroupingManager(panelCtx, names);
    }
    const root = host.matches?.('.pas-gm-popup') ? host : host.querySelector('.pas-gm-popup');
    if (!root) throw new Error('Grouping manager markup did not render a root element');

    _groupingManagerRoot = root;
    bindGroupingEvents(root);
    let disposed = false;
    return Object.freeze({
        root,
        dispose() {
            if (disposed) return false;
            disposed = true;
            return disposeGroupingManagerMount(root);
        },
    });
}

export function disposeGroupingManagerMount(root = _groupingManagerRoot) {
    if (!_groupingManagerRoot || (root && root !== _groupingManagerRoot)) return false;
    const mountedRoot = _groupingManagerRoot;
    _groupingManagerRoot = null;
    closeGroupManagerContextMenu();
    mountedRoot.onkeydown = null;
    mountedRoot.replaceChildren();
    _gmAllNames = [];
    _gmPanelCtx = null;
    clearGroupingManagerState();
    return true;
}

// =====================================================
// 分组管理弹窗主入口
// =====================================================

/**
 * 打开"管理分组"弹窗 — AI-0 重构版
 * 以系列卡片为核心视图，支持拖拽、⋯ 菜单、右键等操作。
 * 删除"未分组"概念，新增"自动分组"目标区域。
 *
 * @param {object} panelCtx
 */
export async function showGroupingManager(panelCtx) {
    if (_groupingManagerPopup) return;
    let presetNames = [];
    _pendingCustomGroups.clear(); // AQ-1: 每次打开弹窗清空临时空分组
    _gmOrganizationHistory.clear();

    // AK-1 重构：只使用 getAllPresetNames() 作为唯一数据源
    // 不再从快照补充——旧逻辑因为 getAllPresetNames() 返回数字索引导致
    // 快照中的真实预设名全被当作"额外"名字加入，造成重复和混乱。
    // 分组管理器只管理当前存在的预设，已删除预设不在此显示。
    try {
        presetNames = getAllPresetNames();
    } catch (e) {
        logger.warn('[showGroupingManager] getAllPresetNames failed:', e);
    }

    const html = prepareGroupingManager(panelCtx, presetNames);
    logger.debug(`[showGroupingManager] ${_gmAllNames.length} presets from getAllPresetNames()`);

    if (_gmAllNames.length === 0) {
        toast.info(t('Grouping Empty Series'));
        return;
    }

    _groupingManagerPopup = createPopupSafe(html, 'DISPLAY', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: t('Close'),
    });

    if (!_groupingManagerPopup) {
        logger.error('[showGroupingManager] createPopupSafe returned null');
        toast.error(t('Grouping Empty Series'));
        return;
    }

    const promise = _groupingManagerPopup.show();

    // 等待 DOM 出现后绑定事件
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, DOM_BIND_DELAY_MS)));

    const container = document.querySelector('.pas-gm-popup');
    const managerMount = container ? mountGroupingManager(container, { render: false }) : null;

    await promise;
    _groupingManagerPopup = null;
    if (container && _groupingManagerRoot !== container) {
        _gmPanelCtx = null;
        return;
    }
    _gmOrganizationHistory.clear();

    // 弹窗关闭后清理 groupingTree 中的空壳节点
    // 策略：自底向上，反复扫描。节点同时满足（无预设 + 自身不作为父组 + 无 override 指向）→ 删除
    const s = getSettings();
    const tree = { ...(s.groupingTree || {}) };
    let treeChanged = true;
    while (treeChanged) {
        treeChanged = false;
        for (const [childKey, parentKey] of Object.entries(tree)) {
            const hasManualPresets = Object.values(_gmOverrides || {}).some(v => normalizeSeriesKey(v) === normalizeSeriesKey(childKey));
            const hasAutoPresets = (_gmAllNames || []).some(name => {
                const parsed = parsePresetName(name);
                return normalizeSeriesKey(parsed.series || name) === normalizeSeriesKey(childKey);
            });
            const hasPresets = hasManualPresets || hasAutoPresets;
            if (hasPresets) continue;
            // 检查该节点是否作为父组存在
            const isParent = Object.values(tree).some(v => normalizeSeriesKey(v) === normalizeSeriesKey(childKey));
            if (isParent) continue;
            // 无预设 + 非父组 → 删除
            delete tree[childKey];
            treeChanged = true;
        }
    }
    _pendingCustomGroups.clear();
    if (Object.keys(tree).length !== Object.keys(s.groupingTree || {}).length) {
        saveGroupingSettings(_gmOverrides, tree);
    }

    // 弹窗关闭后刷新面板数据
    if (_gmPanelCtx) {
        try { await _gmPanelCtx.refreshData(); } catch (_) {}
    }
    managerMount?.dispose();
    _gmPanelCtx = null;
}

// =====================================================
// 导出
// =====================================================

export {
    renderModernGroupingHTML,
    bindGroupingEvents,
    bindDragEvents,
    bindMenuEvents,
    bindClickEvents,
    performMoveGroup,
    performResetAll,
    refreshGroupingUI,
    onCreateSubGroup,
    onCreateCustomGroup,
    onDeleteCustomGroup,
    onRenameSeriesGroup,
    saveGroupingSettings,
    arePresetsComparable,
    getNodeDepth,
    isAncestor,
};
