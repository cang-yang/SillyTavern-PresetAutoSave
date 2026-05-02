/**
 * SillyTavern Preset Auto Save - Panel List Render
 * 列表标签页的渲染逻辑（系列视图 + 平铺视图）
 *
 * 从 history-panel.js 中提取，包含：
 *   - renderSeriesView / renderFlatView  — 两种列表视图
 *   - renderSeriesGroup / renderVersionGroup / renderPresetGroup — 组件
 *   - renderCard / renderEmptyState — 卡片和空状态
 *   - applyFiltersAndSearch — 过滤和搜索
 *   - groupSnapshotsByPreset / parsePresetKey / presetKey — 数据工具
 *   - startOfToday / startOfWeek — 时间工具
 */

import { logger } from './logger.js';
import { getSettings } from './settings.js';
import {
    TRIGGER_LABEL_KEYS, formatBytes,
} from './history-store.js';
import {
    t, getCurrentApiId, getSelectedPresetName,
} from './compatibility.js';
import {
    parsePresetName,
    getSeriesInfo,
    groupSnapshotsBySeries,
    normalizeSeriesKey,
} from './preset-grouping.js';
import {
    listAllPresetsIncludingDetached,
} from './preset-takeover.js';
import {
    renderSummary, escapeHtml, escapeAttr, formatTime,
} from './panel-summary.js';

// =====================================================
// 工具函数
// escapeAttr 已从 panel-summary.js（→ compatibility.js）导入

export function presetKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

export function parsePresetKey(key) {
    const idx = key.indexOf('::');
    if (idx < 0) return { apiId: '', presetName: key };
    return { apiId: key.slice(0, idx), presetName: key.slice(idx + 2) };
}

function startOfToday() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function startOfWeek() {
    const d = new Date();
    const dow = d.getDay() || 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - (dow - 1) * 86400000;
}

// =====================================================
// 数据分组
// =====================================================
export function groupSnapshotsByPreset(snapshots) {
    const map = {};
    for (const s of snapshots) {
        const k = presetKey(s.apiId, s.presetName);
        if (!map[k]) map[k] = [];
        map[k].push(s);
    }
    // 每组内部按时间倒序
    for (const k of Object.keys(map)) {
        map[k].sort((a, b) => b.timestamp - a.timestamp);
    }
    return map;
}

// =====================================================
// 过滤和搜索
// =====================================================

/**
 * @param {Array} snapshots
 * @param {object} panelCtx - 面板上下文，需提供 state()
 */
export function applyFiltersAndSearch(snapshots, panelCtx) {
    const _state = panelCtx.state();
    let result = [...snapshots];

    if (_state.filter === 'current') {
        const name = getSelectedPresetName();
        const api = getCurrentApiId();
        // series 视图下的"当前预设"= 当前预设所在的整个"系列"
        // flat 视图下保持原行为：精确到 (apiId, presetName)
        if (_state.viewMode === 'series' && name) {
            const settings = getSettings();
            const overrides = settings.groupingManualOverrides;
            const curInfo = (() => {
                try {
                    return parsePresetName(name);
                } catch (_) { return { series: name }; }
            })();
            // 应用手动覆盖到当前预设
            let curSeries = curInfo.series || name;
            if (overrides && Object.hasOwn(overrides, name) && overrides[name]) {
                curSeries = overrides[name];
            }
            result = result.filter(s => {
                if (s.apiId !== api) return false;
                const ovr = (overrides && overrides[s.presetName]) || null;
                if (ovr) return ovr === curSeries;
                try {
                    const parsed = parsePresetName(s.presetName || '');
                    return (parsed.series || s.presetName) === curSeries;
                } catch (_) {
                    return s.presetName === name;
                }
            });
        } else {
            result = result.filter(s => s.presetName === name && s.apiId === api);
        }
    } else if (_state.filter === 'pinned') {
        result = result.filter(s => !!s.pinned);
    } else if (_state.filter === 'today') {
        const start = startOfToday();
        result = result.filter(s => s.timestamp >= start);
    } else if (_state.filter === 'week') {
        const start = startOfWeek();
        result = result.filter(s => s.timestamp >= start);
    }

    if (_state.search) {
        const q = _state.search.toLowerCase();
        // 用解析后的"系列名"参与搜索：用户输入"梦境"也应能命中所有梦境思客版本
        result = result.filter(s => {
            if ((s.presetName || '').toLowerCase().includes(q)) return true;
            if ((s.name || '').toLowerCase().includes(q)) return true;
            try {
                const parsed = parsePresetName(s.presetName || '');
                if ((parsed.series || '').toLowerCase().includes(q)) return true;
            } catch (_) {}
            return false;
        });
    }

    return result;
}

// =====================================================
// 卡片渲染
// =====================================================

/**
 * @param {object} s - 快照对象
 * @param {object} panelCtx - 面板上下文，需提供 state()
 */
function renderCard(s, panelCtx) {
    const _state = panelCtx.state();
    const triggerLabel = t(TRIGGER_LABEL_KEYS[s.trigger] || 'Trigger Auto');
    const id = escapeAttr(s.id);
    const summaryHtml = renderSummary(s.summary);
    const isPinned = !!s.pinned;
    const isA = _state.diffSel.a === s.id;
    const isB = _state.diffSel.b === s.id;
    const customName = (s.name || '').trim();

    const cardCls = [
        'pas-card',
        `pas-card-trigger-${escapeAttr(s.trigger)}`,
        isPinned ? 'pas-card-pinned' : '',
        isA ? 'pas-card-selected-a' : '',
        isB ? 'pas-card-selected-b' : '',
    ].filter(Boolean).join(' ');

    const pinTitle = isPinned ? t('Unpin Snapshot') : t('Pin Snapshot');
    const aTitle = isA ? t('Diff Clear A') : t('Diff Set A');
    const bTitle = isB ? t('Diff Clear B') : t('Diff Set B');

    // 删除按钮：pinned 快照禁用
    const deleteAttr = isPinned
        ? `disabled title="${escapeAttr(t('Cannot Delete Pinned'))}"`
        : `title="${escapeAttr(t('Delete'))}"`;

    return `
<div class="${cardCls}" data-snapshot-id="${id}">
    <div class="pas-card-main">
        <div class="pas-card-title-row">
            ${isPinned ? `<i class="fa-solid fa-thumbtack pas-card-pin-icon" title="${escapeAttr(t('Pinned'))}"></i>` : ''}
            ${customName ? `<span class="pas-card-name-custom" title="${escapeAttr(customName)}">${escapeHtml(customName)}</span>` : ''}
            <span class="pas-card-time">${formatTime(s.timestamp)}</span>
            <span class="pas-tag pas-tag-${escapeAttr(s.trigger)}">${escapeHtml(triggerLabel)}</span>
        </div>
        ${summaryHtml}
        <div class="pas-card-meta">
            <span class="pas-card-size">${formatBytes(s.size || 0)}</span>
            <span class="pas-divider">\u00b7</span>
            <span class="pas-card-hash" title="hash">${escapeHtml(s.hash || '')}</span>
        </div>
    </div>
    <div class="pas-card-actions">
        <button class="pas-btn-action pas-btn-diff-a ${isA ? 'pas-btn-diff-active' : ''}" data-id="${id}" data-action="diff-a" title="${escapeAttr(aTitle)}" type="button" aria-label="${escapeAttr(aTitle)}">
            <span style="font-weight:700;font-size:0.85em;">A</span>
        </button>
        <button class="pas-btn-action pas-btn-diff-b ${isB ? 'pas-btn-diff-active' : ''}" data-id="${id}" data-action="diff-b" title="${escapeAttr(bTitle)}" type="button" aria-label="${escapeAttr(bTitle)}">
            <span style="font-weight:700;font-size:0.85em;">B</span>
        </button>
        <button class="pas-btn-action pas-btn-rename" data-id="${id}" data-action="rename" title="${escapeAttr(t('Rename Snapshot'))}" type="button" aria-label="${escapeAttr(t('Rename Snapshot'))}">
            <i class="fa-solid fa-pen"></i>
        </button>
        <button class="pas-btn-action pas-btn-pin ${isPinned ? 'pas-btn-pin-active' : ''}" data-id="${id}" data-action="pin" title="${escapeAttr(pinTitle)}" type="button" aria-label="${escapeAttr(pinTitle)}">
            <i class="fa-solid fa-thumbtack"></i>
        </button>
        <button class="pas-btn-action pas-btn-restore" data-id="${id}" data-action="restore" title="${escapeAttr(t('Restore'))}" type="button" aria-label="${escapeAttr(t('Restore'))}">
            <i class="fa-solid fa-rotate-left"></i>
        </button>
        <button class="pas-btn-action pas-btn-view" data-id="${id}" data-action="view" title="${escapeAttr(t('View'))}" type="button" aria-label="${escapeAttr(t('View'))}">
            <i class="fa-solid fa-eye"></i>
        </button>
        <button class="pas-btn-action pas-btn-export-preset" data-id="${id}" data-action="export" title="${escapeAttr(t('Export Preset'))}" type="button" aria-label="${escapeAttr(t('Export Preset'))}">
            <i class="fa-solid fa-file-export"></i>
        </button>
        <button class="pas-btn-action pas-btn-delete" data-id="${id}" data-action="delete" ${deleteAttr} type="button" aria-label="${escapeAttr(t('Delete'))}">
            <i class="fa-solid fa-trash"></i>
        </button>
    </div>
</div>`;
}

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

    return `
<div class="pas-preset-group ${isCurrent ? 'pas-preset-current' : ''}" data-preset-key="${safeKey}">
    <div class="pas-preset-header" data-action="toggle-group">
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
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>
    <div class="pas-preset-body"${isExpanded ? '' : ' hidden'}>
        ${snapshots.map(s => renderCard(s, panelCtx)).join('')}
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
    const seriesKey = info.series;
    const isExpanded = _state.expandedSeries.has(seriesKey);
    const safeKey = escapeAttr(seriesKey);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = info.versions.some(v => v.apiId === currentApi && v.presetName === currentName);

    return `
<div class="pas-series-group ${isCurrent ? 'pas-series-current' : ''}" data-series-key="${safeKey}">
    <div class="pas-series-header" data-action="toggle-series">
        <div class="pas-series-header-row pas-series-header-row-title">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-series-chevron"></i>
            <i class="fa-solid fa-folder${isExpanded ? '-open' : ''} pas-series-icon"></i>
            <span class="pas-series-name" title="${escapeAttr(seriesKey)}">${escapeHtml(seriesKey)}</span>
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
        ${info.versions.map(v => renderVersionGroup(v, seriesKey, info.versions, panelCtx)).join('')}
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
        isEmpty ? `<span class="pas-tag pas-tag-empty" title="${escapeAttr(t('No Snapshots Yet Title'))}">${escapeHtml(t('No Snapshots Yet'))}</span>` : '',
    ].filter(Boolean).join('');
    const tagsRowHtml = tagsHtml
        ? `<div class="pas-version-header-row pas-version-header-row-tags">${tagsHtml}</div>`
        : '';


    // 应用版本按钮（已归档版本不可应用）
    const applyBtn = ver.archived
        ? ''
        : `<button class="pas-btn-action pas-btn-apply-version" data-action="apply-version" data-preset-name="${safePresetName}" title="${escapeAttr(t('Apply This Version'))}" type="button" aria-label="${escapeAttr(t('Apply This Version'))}">
            <i class="fa-solid fa-circle-check"></i>
        </button>`;

    // AR-0: 删除预设按钮（当前预设 disabled）
    const deletePresetBtn = `<button class="pas-version-delete-btn" data-action="delete-preset" data-preset-name="${safePresetName}" data-api-id="${escapeAttr(ver.apiId)}" title="${escapeAttr(t('Delete Preset Btn'))}" type="button" aria-label="${escapeAttr(t('Delete Preset Btn'))}" ${isCurrent ? 'disabled' : ''}>
            <i class="fa-solid fa-trash-can"></i>
        </button>`;

    return `
<div class="pas-version-group ${isCurrent ? 'pas-version-current' : ''} ${isEmpty ? 'pas-version-empty' : ''} ${ver.archived ? 'pas-version-archived' : ''}" data-version-key="${safeKey}" data-series-key="${safeSeries}" data-preset-name="${safePresetName}">
    <div class="pas-version-header" data-action="toggle-version">
        <div class="pas-version-header-row pas-version-header-row-title">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-version-chevron"></i>
            <i class="fa-solid fa-code-branch pas-version-icon"></i>
            <span class="pas-version-rawname" title="${escapeAttr(ver.presetName)}">${escapeHtml(ver.presetName)}</span>
            ${versionPillHtml}
            ${dupHtml}
            <span class="pas-version-api">${escapeHtml(ver.apiId)}</span>
        </div>
        ${tagsRowHtml}
        <div class="pas-version-header-row pas-version-header-row-meta">
            <span class="pas-version-meta-stats">
                <span class="pas-version-count" title="${escapeAttr(t('Snapshots Count'))}"><i class="fa-solid fa-camera"></i> ${ver.snapshotCount}</span>
                <span class="pas-divider">\u00b7</span>
                <span class="pas-version-size" title="${escapeAttr(t('Total Size'))}">${formatBytes(ver.totalSize)}</span>
                <span class="pas-divider">\u00b7</span>
                <span class="pas-version-latest" title="${escapeAttr(t('Latest Time'))}">${ver.latestTime ? formatTime(ver.latestTime) : '\u2014'}</span>
            </span>
            <span class="pas-version-meta-actions">
                ${applyBtn}
                <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                    <i class="fa-solid fa-trash"></i>
                </button>
                ${deletePresetBtn}
            </span>
        </div>
    </div>
    <div class="pas-version-body"${isExpanded ? '' : ' hidden'}>
        ${ver.snapshots.length > 0 ? ver.snapshots.map(s => renderCard(s, panelCtx)).join('') : `<div class="pas-version-empty-hint">${escapeHtml(t('No Snapshots Yet Hint'))}</div>`}
    </div>
</div>`;
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
export function renderSeriesView(filtered, panelCtx) {
    const settings = getSettings();
    const currentApi = getCurrentApiId() || 'openai';

    // 1) 历史快照：按当前 API 过滤（snapshot.apiId 必须 === currentApi）
    const filteredByApi = (filtered || []).filter(s => s && s.apiId === currentApi);

    const seriesMap = groupSnapshotsBySeries(filteredByApi, {
        overrides: settings.groupingManualOverrides,
    });

    // ⚡ 关键修复 B3：用 normKey 做"二次归并"
    //   seriesMap 的 key 是首次出现的"显示名"形式（如"mur 鹿鹿 API"），
    //   后续 native list / archives 来的数据如果是另一种大小写/空格形式
    //   （如"Mur 鹿鹿 API"或"mur鹿鹿 API"），必须归到已存在的系列里，
    //   否则面板里会显示成多个独立的一级条目（用户报告的"一级里只有一个版本"假象）。
    const _normKeyToDisplay = new Map();  // normKey → 显示名（已经在 seriesMap 中）
    for (const k of seriesMap.keys()) {
        _normKeyToDisplay.set(normalizeSeriesKey(k), k);
    }
    const _resolveSeriesKey = (rawKey) => {
        const norm = normalizeSeriesKey(rawKey);
        const existing = _normKeyToDisplay.get(norm);
        if (existing) return existing;
        // 第一次出现 → 注册显示名
        _normKeyToDisplay.set(norm, rawKey);
        return rawKey;
    };

    // ⭐ 唯一可信数据源：DOM 上的 select.options（用户实际看到的下拉）
    //
    // ⚠️ 不再使用 getAllPresetNames() —— 它返回的是 ST 内部 oai_settings.preset_settings_openai
    //    在某些 ST 版本下，这个数组可能包含损坏对象（{name: 数字, ...}）或纯索引。
    //    那些"数字垃圾"会被当成预设名出现在面板里（用户看到的"15/17/18/19..."）。
    //
    //    DOM 上的 select 是 ST 渲染给用户看的下拉，里面只有真实的预设名，
    //    所以是绝对干净、可信的唯一数据源。
    // ⚡ C1 修复：将 allEntries 提升到函数作用域，使后续的"幽灵版本清理"代码块也能访问
    let allEntries = new Map();

    try {
        const overrides = settings.groupingManualOverrides || {};

        // 唯一来源：DOM select.options（含被接管摘除的）—— 严格按 currentApi 过滤
        let fromDOM = [];
        try { fromDOM = listAllPresetsIncludingDetached(currentApi) || []; } catch (_) {}

        // 进一步过滤：丢弃任何"看起来像数字 ID"的预设名（防御 ST 把数字 ID 误塞进 select）
        const isPureNumberLike = (n) => {
            if (typeof n !== 'string') return true;
            const s = n.trim();
            if (!s) return true;
            // 纯数字（"15"、"17"）或带空格/标点（"  15  "）
            if (/^[\s\-_.]*\d+[\s\-_.]*$/.test(s)) return true;
            return false;
        };

        // 合并去重：以 apiId::presetName 为 key
        allEntries = new Map();
        for (const e of fromDOM) {
            if (e.apiId && e.apiId !== currentApi) continue;
            if (!e.presetName || isPureNumberLike(e.presetName)) continue;
            const k = `${currentApi}::${e.presetName}`;
            if (!allEntries.has(k)) allEntries.set(k, { apiId: currentApi, presetName: e.presetName });
        }

        for (const { apiId, presetName } of allEntries.values()) {
            const info = getSeriesInfo(presetName, overrides);
            const seriesKey = _resolveSeriesKey(info.series || presetName);

            let series = seriesMap.get(seriesKey);
            if (!series) {
                series = {
                    series: seriesKey,
                    versions: [],
                    latestTime: 0,
                    totalSize: 0,
                    snapshotCount: 0,
                    versionCount: 0,
                };
                seriesMap.set(seriesKey, series);
            }

            // 用归一化键判断"该系列中是否已有这个版本"，避免大小写差异重复加
            const existsKey = (n) => normalizeSeriesKey(n);
            const exists = series.versions.some(v => v.apiId === apiId && existsKey(v.presetName) === existsKey(presetName));
            if (!exists) {
                series.versions.push({
                    apiId,
                    presetName,
                    version: info.version,
                    duplicate: info.duplicate,
                    kind: info.kind,
                    manualOverride: info.manualOverride,
                    snapshots: [],
                    latestTime: 0,
                    totalSize: 0,
                    snapshotCount: 0,
                    archived: false,
                });
                series.versionCount = series.versions.length;
            }
        }
    } catch (e) {
        logger.debug('renderSeriesView merge native list failed:', e);
    }

    // ⭐ 把"已归档预设"也合并进来（数据接管模式下）—— 同样按当前 API 过滤
    const _archivedCache = panelCtx.archivedCache();
    if (_archivedCache && _archivedCache.length > 0) {
        try {
            const overrides = settings.groupingManualOverrides || {};
            for (const arch of _archivedCache) {
                if (arch.apiId && arch.apiId !== currentApi) continue;
                const presetName = arch.presetName;
                if (!presetName) continue;
                const info = getSeriesInfo(presetName, overrides);
                const seriesKey = _resolveSeriesKey(info.series || presetName);

                let series = seriesMap.get(seriesKey);
                if (!series) {
                    series = {
                        series: seriesKey,
                        versions: [],
                        latestTime: 0,
                        totalSize: 0,
                        snapshotCount: 0,
                        versionCount: 0,
                    };
                    seriesMap.set(seriesKey, series);
                }

                const exists = series.versions.some(v => v.apiId === arch.apiId && v.presetName === presetName);
                if (!exists) {
                    series.versions.push({
                        apiId: arch.apiId,
                        presetName,
                        version: info.version,
                        duplicate: info.duplicate,
                        kind: info.kind,
                        manualOverride: info.manualOverride,
                        snapshots: [],
                        latestTime: arch.archivedAt || 0,
                        totalSize: 0,
                        snapshotCount: 0,
                        archived: true,
                    });
                    series.versionCount = series.versions.length;
                }
            }
        } catch (e) {
            logger.debug('renderSeriesView merge archives failed:', e);
        }
    }

    // ⚡ B29 修复：过滤掉旧的"系列名快照"——
    //   旧版本的 seedSnapshotsIfNeeded 曾把代表 option 的系列名（如"梦境思客"）
    //   当成预设名存入快照。这些快照会在面板中显示为"二级条目中混入一级名称"。
    //   判断条件：版本的 presetName 精确等于其所在系列的 seriesKey，
    //             且该 presetName 不是真正的原生预设（不在 allEntries 中）
    try {
        for (const [seriesKey, series] of seriesMap) {
            if (!series.versions || series.versions.length <= 1) continue;
            series.versions = series.versions.filter(ver => {
                if (ver.presetName !== seriesKey) return true; // 名字不同于系列名 → 保留
                // presetName === seriesKey 时，检查是否真的是原生预设
                const nativeKey = `${currentApi}::${ver.presetName}`;
                if (allEntries && allEntries.has(nativeKey)) return true; // 原生存在 → 保留
                // 不在原生列表中 → 是旧的系列名幽灵条目，但保留其快照（合并到同系列其他版本）
                if (ver.snapshots && ver.snapshots.length > 0) {
                    // 把幽灵版本的快照分配到系列中的第一个真实版本
                    const realVer = series.versions.find(v => v.presetName !== seriesKey);
                    if (realVer) {
                        realVer.snapshots.push(...ver.snapshots);
                        realVer.snapshotCount = (realVer.snapshotCount || 0) + ver.snapshots.length;
                        realVer.totalSize = (realVer.totalSize || 0) + (ver.totalSize || 0);
                        if (ver.latestTime > realVer.latestTime) realVer.latestTime = ver.latestTime;
                    }
                }
                return false; // 过滤掉幽灵版本
            });
            series.versionCount = series.versions.length;
        }
    } catch (e) {
        logger.debug('renderSeriesView ghost version cleanup failed:', e);
    }

    // 防御性清理：删除 versions 为空的系列（理论不应该有）
    for (const [k, s] of seriesMap) {
        if (!s.versions || s.versions.length === 0) {
            seriesMap.delete(k);
        }
    }

    // O-2: 筛选/搜索激活时，隐藏无匹配快照的版本组和空系列组
    //   当 filter !== 'all' 或搜索词非空时，面板只展示有实际匹配快照的版本，
    //   不再显示 "无快照 · 0 · 0 B" 空壳条目。
    const _state = panelCtx.state();
    const hasActiveFilter = (_state.filter && _state.filter !== 'all') || !!_state.search;
    if (hasActiveFilter) {
        for (const [k, series] of seriesMap) {
            // 移除没有快照的版本组
            series.versions = series.versions.filter(v => (v.snapshotCount || 0) > 0);
            series.versionCount = series.versions.length;
            // 如果该系列下所有版本都被过滤掉了，移除整个系列
            if (series.versions.length === 0) {
                seriesMap.delete(k);
            }
        }
    }

    if (seriesMap.size === 0) {
        return `<div class="pas-empty-state pas-empty-state-grouping">
            <i class="fa-solid fa-folder-tree"></i>
            <div class="pas-empty-state-text">${escapeHtml(t('Grouping Empty Series'))}</div>
        </div>`;
    }

    // 系列按"最新时间"倒序，无快照的系列按系列名 A→Z 排在最后
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
