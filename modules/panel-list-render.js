/**
 * SillyTavern Preset Auto Save - Panel List Render
 * 列表标签页的渲染逻辑（系列视图 + 平铺视图）
 *
 * 从 history-panel.js 中提取，包含：
 *   - renderSeriesView / renderFlatView  — 两种列表视图
 *   - renderSeriesGroup / renderVersionGroup / renderPresetGroup — 组件
 *   - renderEmptyState — 空状态
 *   - startOfToday / startOfWeek — 时间工具
 */

import { getSettings } from './settings.js';
import { formatBytes } from './history-store.js';
import {
    t, getCurrentApiId, getSelectedPresetName,
} from './compatibility.js';
import {
    normalizeSeriesKey,
    getNodePath,
} from './preset-grouping.js';
import {
    escapeHtml, escapeAttr, formatTime,
} from './panel-summary.js';
import {
    SNAPSHOT_RENDER_INCREMENT,
    getBoundedSnapshotWindow,
} from './core/bounded-snapshot-list.js';
import {
    presetKey, parsePresetKey, groupSnapshotsByPreset, resolvePanelSeriesProjection,
} from './panel-list-model.js';
import { renderSnapshotCard } from './panel-snapshot-card.js';

// =====================================================
// 工具函数
// escapeAttr 已从 panel-summary.js（→ compatibility.js）导入

// =====================================================
// 空状态
// =====================================================

/**
 * @param {object} panelCtx - 面板上下文，需提供 state()
 */
export function renderEmptyState(panelCtx) {
    const _state = panelCtx.state();
    let icon = 'fa-folder-open';
    let title = t('No records yet');
    let hint = t('Hint: Modify a preset to create a snapshot');

    if (_state.search) {
        icon = 'fa-magnifying-glass';
        title = t('No matching results');
        hint = '';
    } else if (_state.filter !== 'all') {
        icon = 'fa-filter';
        title = t('No items in this range');
        hint = t('Try other filters');
    }

    return `
        <div class="pas-empty">
            <i class="fa-solid ${icon} pas-empty-icon"></i>
            <p class="pas-empty-text">${escapeHtml(title)}</p>
            ${hint ? `<p class="pas-empty-hint">${escapeHtml(hint)}</p>` : ''}
        </div>`;
}

// =====================================================
// 预设组渲染（平铺视图）
// =====================================================

/**
 * @param {string} key - "apiId::presetName"
 * @param {Array} snapshots
 * @param {object} panelCtx - 面板上下文
 */
function renderPresetGroup(key, snapshots, panelCtx) {
    const _state = panelCtx.state();
    const { apiId, presetName } = parsePresetKey(key);
    const isExpanded = _state.expandedPresets.has(key);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = (presetName === currentName && apiId === currentApi);
    const totalSize = snapshots.reduce((sum, s) => sum + (s.size || 0), 0);
    const latestTime = snapshots[0]?.timestamp || 0;
    const safeKey = escapeAttr(key);
    const snapshotWindow = getBoundedSnapshotWindow(snapshots, _state.snapshotRenderLimits.get(key));

    return `
<div class="pas-preset-group ${isCurrent ? 'pas-preset-current' : ''}" data-preset-key="${safeKey}">
    <div class="pas-preset-header" data-action="toggle-group" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="pas-preset-header-main">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-preset-chevron"></i>
            <i class="fa-solid fa-layer-group pas-preset-icon"></i>
            <span class="pas-preset-name" title="${escapeAttr(presetName)}">${escapeHtml(presetName)}</span>
            ${isCurrent ? `<span class="pas-tag pas-tag-current">${escapeHtml(t('Current Preset'))}</span>` : ''}
            <span class="pas-preset-api">${escapeHtml(apiId)}</span>
        </div>
        <div class="pas-preset-header-meta">
            <span class="pas-preset-count">${snapshots.length}</span>
            <span class="pas-divider">\u00b7</span>
            <span class="pas-preset-size">${formatBytes(totalSize)}</span>
            <span class="pas-divider">\u00b7</span>
            <span class="pas-preset-latest">${formatTime(latestTime)}</span>
            <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                <i class="fa-solid fa-trash"></i><span class="pas-action-label">${escapeHtml(t('Clear History Short'))}</span>
            </button>
        </div>
    </div>
    <div class="pas-preset-body"${isExpanded ? '' : ' hidden'}>
        ${isExpanded ? snapshotWindow.items.map(s => renderSnapshotCard(s, panelCtx)).join('') : ''}
        ${isExpanded ? renderShowMoreSnapshots(key, snapshotWindow.remaining, snapshotWindow.total) : ''}
    </div>
</div>`;
}

// =====================================================
// 系列组渲染（系列视图 — 一级）
// =====================================================

/**
 * 系列卡（一级）— 重构：上下双排布局，避免标题与元信息互相挤压
 *   第 1 排（标题排）：箭头 + 图标 + 系列名（占满剩余空间） + 「当前」徽章 + 版本数胶囊
 *   第 2 排（元信息排，缩进对齐）：快照数 / 大小 / 最新时间
 *
 * @param {object} info - 系列信息
 * @param {object} panelCtx - 面板上下文
 */
function renderSeriesGroup(info, panelCtx) {
    const _state = panelCtx.state();
    const seriesKey = info.canonicalKey;
    const isExpanded = _state.expandedSeries.has(seriesKey);
    const safeKey = escapeAttr(seriesKey);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = info.versions.some(v => v.apiId === currentApi && v.presetName === currentName);

    return `
<div class="pas-series-group ${isCurrent ? 'pas-series-current' : ''}" data-series-key="${safeKey}">
    <div class="pas-series-header" data-action="toggle-series" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="pas-series-header-row pas-series-header-row-title">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-series-chevron"></i>
            <i class="fa-solid fa-folder${isExpanded ? '-open' : ''} pas-series-icon"></i>
            <span class="pas-series-name" title="${escapeAttr(info.displayName)}">${escapeHtml(info.displayName)}</span>
            <span class="pas-series-version-pill" title="${escapeAttr(t('Grouping Series Header Versions', { count: info.versionCount }))}">
                <i class="fa-solid fa-code-branch"></i> ${info.versionCount}
            </span>
            ${isCurrent ? `<span class="pas-tag pas-tag-current" title="${escapeAttr(t('Current Preset'))}"><i class="fa-solid fa-circle-dot"></i></span>` : ''}
        </div>
        <div class="pas-series-header-row pas-series-header-row-meta">
            <span class="pas-series-snapshots" title="${escapeAttr(t('Grouping Series Header Snapshots', { count: info.snapshotCount }))}">
                <i class="fa-solid fa-camera"></i> ${info.snapshotCount}
            </span>
            <span class="pas-divider">\u00b7</span>
            <span class="pas-series-size">${formatBytes(info.totalSize)}</span>
            <span class="pas-divider">\u00b7</span>
            <span class="pas-series-latest">${info.latestTime ? formatTime(info.latestTime) : '\u2014'}</span>
        </div>
    </div>
    <div class="pas-series-body"${isExpanded ? '' : ' hidden'}>
        ${isExpanded ? info.versions.map(v => renderVersionGroup(v, seriesKey, info.versions, panelCtx)).join('') : ''}
    </div>
</div>`;
}

// =====================================================
// 版本组渲染（系列视图 — 二级）
// =====================================================

/**
 * 版本卡（二级）— 重构 v2：以"完整原始预设名"为主标题
 *
 * 布局（上下三排）：
 *   第 1 排（标题排）：箭头 + 图标 + **完整预设名**（占满主区） + 版本号小胶囊（如有）
 *   第 2 排（标签排）：当前 / 默认 / 手动归类 / 归档 / 重名警告 等所有标签徽章
 *   第 3 排（元信息 + 操作排）：快照数 / 大小 / 最新时间 ······· [应用] [设默认] [清空]
 *
 * 这样无论预设名多长、标签多少都不会与右侧操作按钮重叠。
 *
 * @param {object} ver - 版本信息
 * @param {string} seriesKey
 * @param {Array} allVersions
 * @param {object} panelCtx - 面板上下文
 */
function renderVersionGroup(ver, seriesKey, allVersions, panelCtx) {
    const _state = panelCtx.state();
    const versionKey = presetKey(ver.apiId, ver.presetName);
    const isExpanded = _state.expandedVersions.has(versionKey);
    const safeKey = escapeAttr(versionKey);
    const safeSeries = escapeAttr(seriesKey);
    const safePresetName = escapeAttr(ver.presetName);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = (ver.presetName === currentName && ver.apiId === currentApi);
    const isEmpty = (ver.snapshotCount || 0) === 0;
    const snapshotWindow = getBoundedSnapshotWindow(ver.snapshots, _state.snapshotRenderLimits.get(versionKey));


    // 版本号胶囊：仅在解析出版本号时才显示（去掉了"未识别版本"占位）
    const versionPillHtml = ver.version
        ? `<span class="pas-version-pill" title="${escapeAttr(t('Version Label Title', { version: ver.version }))}">${escapeHtml(ver.version)}</span>`
        : '';
    // ⚡ D3+P4 修复：副本标记仅在系列中确实存在"同版本号"的其他预设时才显示。
    //   原来的 allVersions.length > 1 判断过于宽松——只要系列有多版本就显示。
    //   实际上 "(1)" 表示导入副本，只有存在同 version 的另一个预设时才算真正的"副本"。
    //   例："梦境思客V2-0426 (1)" 只在系列中还有 "梦境思客V2-0426" 时才显示副本标记。
    //   例："Deepseek 官方提示词指南预设 (5)" 如果系列只有它一个版本也不显示。
    const showDuplicate = ver.duplicate && Array.isArray(allVersions) && allVersions.some(
        v => v !== ver && v.version === ver.version
    );
    const dupHtml = showDuplicate
        ? `<span class="pas-version-pill pas-version-pill-dup" title="${escapeAttr(t('Duplicate Version Title'))}"><i class="fa-solid fa-copy"></i> ${escapeHtml(ver.duplicate)}</span>`
        : '';

    // 标签徽章
    const tagsHtml = [
        isCurrent ? `<span class="pas-tag pas-tag-current">${escapeHtml(t('Current Preset'))}</span>` : '',
        ver.manualOverride ? `<span class="pas-tag pas-tag-manual-override" title="${escapeAttr(t('Grouping Manual Tag Title'))}">${escapeHtml(t('Grouping Manual Tag'))}</span>` : '',
        ver.archived ? `<span class="pas-tag pas-tag-archived" title="${escapeAttr(t('Archived Version Title'))}"><i class="fa-solid fa-box-archive"></i> ${escapeHtml(t('Archived Version'))}</span>` : '',
        ver.available === false && !ver.archived ? `<span class="pas-tag pas-tag-unavailable" title="${escapeAttr(t('Preset Unavailable Hint'))}">${escapeHtml(t('Preset Unavailable'))}</span>` : '',
        isEmpty ? `<span class="pas-tag pas-tag-empty" title="${escapeAttr(t('No Snapshots Yet Title'))}">${escapeHtml(t('No Snapshots Yet'))}</span>` : '',
    ].filter(Boolean).join('');


    // 应用版本按钮（已归档版本不可应用）
    const applyBtn = ver.archived || ver.available === false
        ? ''
        : `<button class="pas-btn-action pas-btn-apply-version" data-action="apply-version" data-preset-name="${safePresetName}" title="${escapeAttr(t('Apply This Version'))}" type="button" aria-label="${escapeAttr(t('Apply This Version'))}">
            <span class="pas-control-face"><i class="fa-solid fa-circle-check"></i><span class="pas-action-label">${escapeHtml(t('Apply Version Short'))}</span></span>
        </button>`;

    // AR-0: 删除预设按钮（当前预设 disabled）
    const deletePresetBtn = ver.available === false ? '' : `<button class="pas-version-delete-btn" data-action="delete-preset" data-preset-name="${safePresetName}" data-api-id="${escapeAttr(ver.apiId)}" title="${escapeAttr(t('Delete Preset Btn'))}" type="button" aria-label="${escapeAttr(t('Delete Preset Btn'))}" ${isCurrent ? 'disabled' : ''}>
            <span class="pas-control-face"><i class="fa-solid fa-trash-can"></i><span class="pas-action-label">${escapeHtml(t('Delete'))}</span></span>
        </button>`;
    const versionActionsHtml = `<div class="pas-version-actions" role="group" aria-label="${escapeAttr(t('Grouping Preset Actions'))}">
            ${applyBtn}
            <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                <span class="pas-control-face"><i class="fa-solid fa-trash"></i><span class="pas-action-label">${escapeHtml(t('Clear Short'))}</span></span>
            </button>
            ${deletePresetBtn}
        </div>`;

    return `
<div class="pas-version-group ${isCurrent ? 'pas-version-current' : ''} ${isEmpty ? 'pas-version-empty' : ''} ${ver.archived ? 'pas-version-archived' : ''}" data-version-key="${safeKey}" data-series-key="${safeSeries}" data-preset-name="${safePresetName}">
    <div class="pas-version-header" data-action="toggle-version" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="pas-version-header-row pas-version-header-row-title">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-version-chevron"></i>
            <i class="fa-solid fa-code-branch pas-version-icon"></i>
            <span class="pas-version-rawname" title="${escapeAttr(ver.presetName)}">${escapeHtml(ver.presetName)}</span>
            ${versionPillHtml}
            ${dupHtml}
            <span class="pas-version-api">${escapeHtml(ver.apiId)}</span>
        </div>
        <div class="pas-version-header-row pas-version-header-row-meta">
            ${tagsHtml ? `<span class="pas-version-header-tags">${tagsHtml}</span>` : ''}
            <span class="pas-version-meta-stats">
                <span class="pas-version-count" title="${escapeAttr(t('Snapshots Count'))}"><i class="fa-solid fa-camera"></i> ${ver.snapshotCount}</span>
                <span class="pas-divider">\u00b7</span>
                <span class="pas-version-size" title="${escapeAttr(t('Total Size'))}">${formatBytes(ver.totalSize)}</span>
                <span class="pas-divider">\u00b7</span>
                <span class="pas-version-latest" title="${escapeAttr(t('Latest Time'))}">${ver.latestTime ? formatTime(ver.latestTime) : '\u2014'}</span>
            </span>
        </div>
    </div>
    <div class="pas-version-body"${isExpanded ? '' : ' hidden'}>
        ${isExpanded ? versionActionsHtml : ''}
        ${isExpanded
            ? (ver.snapshots.length > 0
                ? snapshotWindow.items.map(s => renderSnapshotCard(s, panelCtx)).join('')
                : `<div class="pas-version-empty-hint">${escapeHtml(t('No Snapshots Yet Hint'))}</div>`)
            : ''}
        ${isExpanded ? renderShowMoreSnapshots(versionKey, snapshotWindow.remaining, snapshotWindow.total) : ''}
    </div>
</div>`;
}

function renderShowMoreSnapshots(key, remaining, total) {
    if (remaining <= 0) return '';
    const count = Math.min(remaining, SNAPSHOT_RENDER_INCREMENT);
    const label = t('Show More Snapshots', { count });
    return `<button class="pas-btn-show-more-snapshots" data-action="show-more-snapshots" data-preset-key="${escapeAttr(key)}" data-total-snapshots="${total}" type="button">
        <i class="fa-solid fa-chevron-down"></i>
        <span>${escapeHtml(label)}</span>
    </button>`;
}

// =====================================================
// 系列视图（三级：系列 → 版本 → 快照）
// =====================================================

/**
 * 系列三级视图：系列 → 版本 → 快照
 *
 * ⚠️ 关键设计：严格按"当前 mainApi"过滤所有数据源
 *   ST 在 DOM 中存在多个 select[data-preset-manager-for]：
 *     openai / kobold / novel / textgenerationwebui / context / instruct / sysprompt / reasoning ...
 *   如果不过滤会出现：
 *     1. 一级列表混入 KoboldAI / Llama / Lightning 等其他 API 的官方预设（"乱七八糟数百个"）
 *     2. 同名 Default 在 OPENAI/TEXTGENERATIONWEBUI/CONTEXT 三个 API 都存在 → 被合并显示3次
 *
 *   面板始终只显示用户当前 mainApi 对应的预设。这与 ST 主下拉的语义保持一致。
 *
 * @param {Array} filtered - 已过滤的快照数组
 * @param {object} panelCtx - 面板上下文，需提供 state(), archivedCache()
 */
export function renderSeriesView(filtered, panelCtx, cachedSeriesMap) {
    const settings = getSettings();
    const _state = panelCtx.state();
    const { groups: seriesMap, tree: rootNodes } = resolvePanelSeriesProjection(filtered, panelCtx, cachedSeriesMap);

    if (seriesMap.size === 0) {
        return renderEmptyState(panelCtx);
    }

    // 嵌套模式：使用 buildNestedGroupTree 构建树并递归渲染
    if (rootNodes) {
        // 构建 normKey → seriesInfo（从 seriesMap 查找版本数据）
        const normKeyToSeries = new Map();
        for (const series of seriesMap.values()) {
            normKeyToSeries.set(series.canonicalKey || normalizeSeriesKey(series.automaticName || series.series), series);
        }

        // 构建 presetName → versionData 快速查找（跨所有系列）
        const presetToVersion = new Map();
        for (const series of seriesMap.values()) {
            for (const v of series.versions) {
                presetToVersion.set(v.presetName, { ver: v, seriesKey: series.canonicalKey, allVersions: series.versions });
            }
        }

        // 构建当前预设所在的祖先节点集合（用于嵌套模式下金色高亮）
        const currentName = getSelectedPresetName();
        const currentApi = getCurrentApiId();
        const currentPresetAncestors = new Set();

        if (currentName && currentApi) {
            const tree = settings.groupingTree || {};

            function collectCurrentNodes(nodes) {
                for (const node of nodes) {
                    let hasCurrent = false;

                    // 通过 node.items（预设名列表）检查
                    if (node.items && node.items.length > 0) {
                        hasCurrent = node.items.some(name => {
                            const found = presetToVersion.get(name);
                            return found && found.ver.apiId === currentApi && found.ver.presetName === currentName;
                        });
                    }

                    // 通过 seriesData.versions 检查（直接归属于该节点的快照数据）
                    if (!hasCurrent) {
                        const normKey = normalizeSeriesKey(node.key);
                        const seriesData = normKeyToSeries.get(normKey);
                        if (seriesData && seriesData.versions && seriesData.versions.length > 0) {
                            hasCurrent = seriesData.versions.some(
                                v => v.apiId === currentApi && v.presetName === currentName
                            );
                        }
                    }

                    if (hasCurrent) {
                        // 添加该节点及其所有祖先节点 key 到高亮集合
                        const path = getNodePath(tree, node.key);
                        for (const k of path) {
                            currentPresetAncestors.add(k);
                        }
                    }

                    // 递归检查子节点（即使当前节点未命中，子孙可能命中）
                    if (node.children && node.children.length > 0) {
                        collectCurrentNodes(node.children);
                    }
                }
            }
            collectCurrentNodes(rootNodes);
        }

        // 递归渲染函数（复用 panelCtx.state() 中的 expandedSeries 管理展开/折叠状态）
        function renderNode(node) {
            const normKey = normalizeSeriesKey(node.key);
            const seriesData = normKeyToSeries.get(normKey);
            const isExpanded = _state.expandedSeries.has(node.key);
            const isCurrent = currentPresetAncestors.has(node.key);

            const indentPx = Math.min(node.depth * 16, 48);
            const hasChildren = node.children && node.children.length > 0;
            const hasItems = node.items && node.items.length > 0;

            // 过滤空壳节点：无预设、无快照、无子组数据 → 跳过
            // 递归子节点（先递归，获取子节点 HTML）
            let childrenHtml = '';
            if (isExpanded && hasChildren) {
                childrenHtml = node.children.map(child => renderNode(child)).join('');
            }

            if (!hasItems && !hasChildren && !seriesData) return '';

            // Depth-limited trees can flatten child versions into a populated
            // parent. Resolve every item while retaining its original group key.
            const nodeVersions = (node.items || []).map(name => presetToVersion.get(name)).filter(Boolean);
            const versionCount = nodeVersions.length;
            const snapshotCount = nodeVersions.reduce((sum, item) => sum + item.ver.snapshotCount, 0);
            const totalSize = nodeVersions.reduce((sum, item) => sum + item.ver.totalSize, 0);
            const latestTime = Math.max(0, ...nodeVersions.map(item => item.ver.latestTime));
            const versionsHtml = isExpanded ? nodeVersions.map(item => renderVersionGroup(
                item.ver, item.seriesKey, item.allVersions, panelCtx,
            )).join('') : '';


            const displayName = node.displayName || node.key;
            const itemCount = node.items ? node.items.length : 0;
            const childCount = node.children ? node.children.length : 0;

            // 子组计数标签
            let childCountHtml = '';
            if (childCount > 0) {
                childCountHtml = `<span class="pas-tag pas-tag-subgroup">${childCount} ${escapeHtml(t('子组'))}</span>`;
            }

            // 嵌套模式：使用 inline style 精确控制金色高亮，避免 CSS 后代选择器 .pas-series-current .pas-series-icon
            // 泄漏到平级兄弟节点。不使用 pas-series-current CSS 类。
            const borderLeft = node.depth > 0
                ? `1px solid ${isCurrent ? 'var(--pas-c-pin)' : 'var(--SmartThemeBorderColor)'}`
                : 'none';
            const iconStyle = isCurrent ? ' style="color: var(--pas-c-pin)"' : '';
            const pillBgStyle = isCurrent ? ' style="background: rgba(245, 158, 11, 0.16)"' : '';

            return `<div class="pas-series-group pas-series-nested${isCurrent ? ' pas-series-current-node' : ''}" data-series-key="${escapeAttr(node.key)}" style="margin-left:${indentPx}px; border-left:${borderLeft}; padding-left:${node.depth > 0 ? '8px' : '0'};">
                <div class="pas-series-header" data-action="toggle-series" role="button" tabindex="0" aria-expanded="${isExpanded}">
                    <div class="pas-series-header-row pas-series-header-row-title">
                        <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-series-chevron"></i>
                        <i class="fa-solid fa-folder${isExpanded ? '-open' : ''} pas-series-icon"${iconStyle}></i>
                        <span class="pas-series-name" title="${escapeAttr(displayName)}">${escapeHtml(displayName)}</span>
                        ${versionCount > 0 ? `<span class="pas-series-version-pill"${pillBgStyle} title="${escapeAttr(t('Grouping Series Header Versions', { count: versionCount }))}"><i class="fa-solid fa-code-branch"></i> ${versionCount}</span>` : ''}
                        ${childCountHtml}
                        ${isCurrent ? `<span class="pas-tag pas-tag-current" title="${escapeAttr(t('Current Preset'))}"><i class="fa-solid fa-circle-dot"></i></span>` : ''}
                    </div>
                    <div class="pas-series-header-row pas-series-header-row-meta">
                        <span class="pas-series-snapshots" title="${escapeAttr(t('Grouping Series Header Snapshots', { count: snapshotCount }))}"><i class="fa-solid fa-camera"></i> ${snapshotCount}</span>
                        <span class="pas-divider">\u00b7</span>
                        <span class="pas-series-size">${formatBytes(totalSize)}</span>
                        <span class="pas-divider">\u00b7</span>
                        <span class="pas-series-latest">${latestTime ? formatTime(latestTime) : '\u2014'}</span>
                    </div>
                </div>
                <div class="pas-series-body"${isExpanded ? '' : ' hidden'}>
                    ${versionsHtml}
                    ${childrenHtml}
                </div>
            </div>`;
        }

        return rootNodes.map(root => renderNode(root)).join('');
    }

    // 扁平模式（nestingEnabled=false 或无 groupingTree）：保持原有逻辑
    const seriesList = Array.from(seriesMap.values()).sort((a, b) => {
        if (a.latestTime !== b.latestTime) return b.latestTime - a.latestTime;
        return a.series.localeCompare(b.series);
    });
    return seriesList.map(info => renderSeriesGroup(info, panelCtx)).join('');
}

// =====================================================
// 平铺视图
// =====================================================

/**
 * 扁平视图：保留旧的"按预设分组"行为（兼容、调试用）
 *
 * @param {Array} filtered - 已过滤的快照数组
 * @param {object} panelCtx - 面板上下文
 */
export function renderFlatView(filtered, panelCtx) {
    // ⚡ 严格按当前 mainApi 过滤，避免显示 KoboldAI / Llama 等其他 API 预设
    const currentApi = getCurrentApiId() || 'openai';
    const filteredByApi = (filtered || []).filter(s => s && s.apiId === currentApi);
    const grouped = groupSnapshotsByPreset(filteredByApi);
    const presetKeys = Object.keys(grouped).sort((a, b) => {
        const at = grouped[a][0]?.timestamp || 0;
        const bt = grouped[b][0]?.timestamp || 0;
        return bt - at;
    });
    return presetKeys.map(k => renderPresetGroup(k, grouped[k], panelCtx)).join('');
}
