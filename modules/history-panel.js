/**
 * SillyTavern Preset Auto Save - History Panel
 * 历史面板控制器
 *
 * 三个 Tab:
 *   - 列表 Tab：按"预设"分组展示快照，每个预设可折叠/展开
 *   - 日志 Tab：实时显示插件日志（级别筛选/搜索/清空/导出）
 *   - 设置 Tab：实时编辑配置
 *
 * 其他能力:
 *   - 备份导出/导入
 *   - 批量清理
 */

import { logger } from './logger.js';
import {
    getSettings, updateSetting, batchUpdate,
} from './settings.js';
import {
    getAllSnapshots,
} from './history-store.js';
import {
    confirmSafe, toast, t,
    getCurrentApiId, getSelectedPresetName,
    getAllPresetNames,
    on as onEvent, off as offEvent, getEventType,
    createPopupSafe,
} from './compatibility.js';
import {
    parsePresetName,
    getSeriesInfo,
    groupSnapshotsBySeries,
    groupNamesBySeries,
    clearParseCache,
    normalizeSeriesKey,
} from './preset-grouping.js';
import {
    refreshTakeover,
    seedSnapshotsIfNeeded,
    seedSnapshotForPreset,
} from './preset-takeover.js';
import { listArchivedPresets } from './archive-store.js';
import {
    FIELD_LABEL_KEYS, PROMPT_FIELD_LABEL_KEYS,
    fieldLabel, promptFieldLabel,
    renderSummary, renderSection,
    describePromptFieldDiffs, describeFieldChange,
    renderLegacySummary, formatSummaryValue,
    escapeHtml, escapeAttr, formatTime,
} from './panel-summary.js';
import {
    renderSettingsTab, renderLogTab,
    updateLogBadge, updateStats,
    onLogClear, onLogCopy, onLogExport,
    onCleanup, onExport, onImport,
    onPurgeCorrupt, onSnapshotNow,
} from './panel-settings-log.js';
import {
    presetKey, parsePresetKey, groupSnapshotsByPreset,
    applyFiltersAndSearch, renderSeriesView, renderFlatView,
    renderEmptyState,
} from './panel-list-render.js';
import {
    handleListClick as _handleListClick,
    updateDiffBar as _updateDiffBar,
    onClearDiff as _onClearDiff,
    onStartDiff as _onStartDiff,
    showGroupingManager as _showGroupingManager,
    showGroupingFirstScanWizard as _showGroupingFirstScanWizard,
    cleanupActionPopups,
    onBatchDeletePresets as _onBatchDeletePresets,
} from './panel-actions.js';

// =====================================================
// 状态
// =====================================================
let _initialized = false;  // 幂等守卫：防止 initHistoryPanel 重复调用
let _popup = null;
let _root = null;
let _logUnsubscribe = null;
let _logRefreshTimer = null;
let _archivedCache = [];  // 归档预设缓存（数据接管模式下显示）
let _panelEventBindings = [];  // [{ event, handler }] 用于 popup 关闭时退订

// ⚡ 当前面板正在查看的 API（影响 renderSeriesView / renderFlatView 的过滤）
//   '' 或 null 表示用 getCurrentApiId() 探测
//   一个具体的 apiId（如 'openai' / 'textgenerationwebui' / 'kobold' / 'novel' / ...）表示用户手动指定

const INITIAL_STATE = Object.freeze({
    tab: 'list',
    filter: 'all',
    search: '',
    snapshots: [],
    viewMode: 'series',       // 'series' | 'flat' - List Tab 视图模式
    expandedSeries: null,     // Set<string> - 展开的系列 key
    expandedVersions: null,   // Set<string> - 展开的版本 key（"<apiId>::<presetName>"）
    expandedPresets: null,    // Set<string> - 兼容字段：flat 模式下展开的预设 key
    diffSel: { a: null, b: null },  // 选中用于对比的两个 snapshot id
    log: {
        level: 'all',         // all | debug | info | success | warn | error
        search: '',
        autoScroll: true,
    },
});

let _state = newState();

function newState() {
    return {
        tab: 'list',
        filter: 'all',
        search: '',
        snapshots: [],
        viewMode: 'series',
        expandedSeries: new Set(),
        expandedVersions: new Set(),
        expandedPresets: new Set(),
        diffSel: { a: null, b: null },
        log: { level: 'all', search: '', autoScroll: true },
        batchMode: false,           // AR-0: 批量模式
        batchSelected: new Set(),   // AR-0: 批量选中的预设名
    };
}

function resetState() {
    _state = newState();
}

/**
 * 构建传递给 panel-settings-log.js 的上下文对象
 */
function _panelCtx() {
    return {
        root: () => _root,
        state: () => _state,
        refreshData: () => refreshData(),
        renderListTab: () => renderListTab(),
        archivedCache: () => _archivedCache,
    };
}

// =====================================================
// 初始化
// =====================================================
export async function initHistoryPanel() {
    if (_initialized) {
        logger.debug('History panel already initialized, skip');
        return;
    }
    _initialized = true;
    logger.debug('History panel ready');
    // 启动导入识别（事件驱动，无轮询）
    startImportWatcher();
}

/**
 * 卸载（onDelete/onDisable 时调用）
 */
export function teardownHistoryPanel() {
    stopImportWatcher();
    cleanupActionPopups({ includeWizard: true });
    _initialized = false;
}

// =====================================================
// 显示面板
// =====================================================
export async function showHistoryPanel() {
    if (_popup) return;

    // Step 1: 创建 popup（简单操作，不太可能失败）
    const html = buildPanelHTML();

    // 通过 createPopupSafe 集中防御 ctx / Popup / POPUP_TYPE 缺失
    _popup = createPopupSafe(html, 'DISPLAY', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: t('Close'),
    });

    if (!_popup) {
        // Popup API 不可用：写日志 + 兜底提示，不再继续渲染（否则会触发 _popup.show() crash）
        logger.error('[Panel] showHistoryPanel: Popup API unavailable, abort');
        try { toast.error(t('Panel Open Failed', { message: 'Popup API unavailable' })); } catch (_) {}
        return;
    }

    const promise = _popup.show();

    await waitForDOM();

    _root = document.querySelector('.pas-panel');

    // ⚡ C3 修复已移除：stopPropagation 会阻止滚动等正常交互。
    //   ST Popup 使用原生 <dialog>.showModal()，关闭是通过 cancel 事件
    //   （Escape / backdrop click）触发的，不依赖 mousedown 事件冒泡，
    //   因此 stopPropagation 既无法阻止弹窗关闭，又会破坏页面滚动。
    if (!_root) {
        logger.error('Panel root not found');
        return;
    }

    // Step 2: 数据加载和渲染（任一阶段失败都不会让面板成黑屏）
    //
    // 拆分成 4 个 stage（loadData / bindEvents / renderActiveTab / updateStats），
    // 任一阶段抛错时：
    //   1) 日志写出确切失败 stage + 完整 stack + state 快照（便于诊断同类问题）
    //   2) 把列表区域换成"打开失败"提示并标注 stage（用户也能看到出错位置）
    let _failedStage = null;
    try {
        _failedStage = 'loadData';
        await loadData();
        _failedStage = 'bindEvents';
        bindEvents();
        _failedStage = 'renderActiveTab';
        renderActiveTab();
        _failedStage = 'updateStats';
        await updateStats(_panelCtx());
        _failedStage = null;
    } catch (err) {
        logger.error(`[Panel] render failed at stage="${_failedStage}":`, err);
        if (err && err.stack) {
            logger.error('[Panel] stack:', err.stack);
        }
        try {
            logger.error('[Panel] state snapshot:', JSON.stringify({
                hasRoot: !!_root,
                hasState: !!_state,
                stateTab: _state?.tab,
                stateFilter: _state?.filter,
                stateViewMode: _state?.viewMode,
                snapshotsLen: Array.isArray(_state?.snapshots) ? _state.snapshots.length : 'N/A',
                hasExpandedSeries: _state?.expandedSeries instanceof Set,
                hasExpandedVersions: _state?.expandedVersions instanceof Set,
                hasExpandedPresets: _state?.expandedPresets instanceof Set,
                hasDiffSel: !!_state?.diffSel,
                archivedCacheLen: Array.isArray(_archivedCache) ? _archivedCache.length : 'N/A',
            }));
        } catch (_) { /* 序列化失败不重要 */ }
        // 注意：原代码用 `.pas-panel-list`（不存在的 class），fallback 到 `.pas-tab-content`
        //       会把所有三个 tab 区域全清空。改成精确选择 `.pas-snapshot-list`。
        const listEl = _root?.querySelector('.pas-snapshot-list')
            || _root?.querySelector('[data-content="list"]');
        if (listEl) {
            listEl.innerHTML = `<div class="pas-empty">
                <div class="pas-empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <p class="pas-empty-text">${t('Panel Open Failed', { message: err?.message || String(err) })}</p>
                <p class="pas-empty-hint" style="opacity:0.7;font-size:0.85em;margin-top:8px;">stage: ${escapeHtml(_failedStage || 'unknown')}</p>
            </div>`;
        }
    }

    // Step 3: 等待 popup 关闭
    try {
        await promise;
    } finally {
        // 取消日志订阅
        if (_logUnsubscribe) {
            try { _logUnsubscribe(); } catch (_) {}
            _logUnsubscribe = null;
        }
        if (_logRefreshTimer) {
            clearTimeout(_logRefreshTimer);
            _logRefreshTimer = null;
        }
        // 取消所有面板内的事件订阅（预设切换等）
        for (const { event, handler } of _panelEventBindings) {
            try { offEvent(event, handler); } catch (_) {}
        }
        _panelEventBindings = [];
        _popup = null;
        _root = null;
        // 关闭可能还开着的子弹窗（viewPopup + groupingManagerPopup）
        cleanupActionPopups();
        // 注意：_firstScanWizardPopup 是模块全局，由其自己的 finally 处理，不在此关闭
        resetState();
    }
}

function waitForDOM() {
    return new Promise(resolve => {
        let count = 0;
        const check = () => {
            if (document.querySelector('.pas-panel') || count > 30) {
                resolve();
            } else {
                count++;
                setTimeout(check, 50);
            }
        };
        check();
    });
}

// =====================================================
// 数据加载
// =====================================================
async function loadData() {
    // 并行加载快照 + 归档（数据接管模式下面板要展示完整版本）
    const [snapshots, archives] = await Promise.all([
        getAllSnapshots().catch(() => []),
        listArchivedPresets().catch(() => []),
    ]);
    _state.snapshots = snapshots || [];
    _archivedCache = archives || [];

    const settings = getSettings();
    // 视图模式：从 settings 决定（启用分组 → series，否则 flat）
    _state.viewMode = settings.groupingEnabled ? 'series' : 'flat';

    // 默认展开当前预设/系列
    const curName = getSelectedPresetName();
    const curApi = getCurrentApiId();
    if (curName && curApi) {
        _state.expandedPresets.add(presetKey(curApi, curName));
        // 不自动展开版本组（二级）——用户要求展开系列后只看到版本列表（收起状态），
        // 需要手动点击版本头部才展开快照。expandedVersions 仅由用户点击或"全部展开"填充。
    }

    if (_state.viewMode === 'series') {
        const overrides = settings.groupingManualOverrides;
        // O-1: 默认全部收起（'none'），用户可在设置中改为 'current' 或 'all'
        const expandMode = settings.groupingDefaultExpand || 'none';
        const seriesMap = groupSnapshotsBySeries(_state.snapshots, { overrides });

        if (expandMode === 'all') {
            for (const k of seriesMap.keys()) _state.expandedSeries.add(k);
        } else if (expandMode === 'current') {
            // O-1: 'current' 模式仅展开当前预设所在的系列，不再展开所有多版本系列
            for (const [k, info] of seriesMap.entries()) {
                const isCurrent = curName && info.versions.some(v => v.apiId === curApi && v.presetName === curName);
                if (isCurrent) {
                    _state.expandedSeries.add(k);
                }
            }
        }
        // none → 不预展开
    }
}

async function refreshData() {
    if (!_root) return;  // 面板已关闭
    await loadData();
    renderActiveTab();
    await updateStats(_panelCtx());
}

// =====================================================
// HTML 框架构建
// =====================================================
function buildPanelHTML() {
    return `
<div class="pas-panel">
    <div class="pas-panel-header">
        <div class="pas-panel-title">
            <i class="fa-solid fa-clock-rotate-left"></i>
            <h3>${escapeHtml(t('Preset history records'))}</h3>
            <div class="pas-panel-stats" id="pas-panel-stats"></div>
        </div>
    </div>

    <div class="pas-panel-tabs">
        <button class="pas-tab pas-tab-active" data-tab="list" type="button">
            <i class="fa-solid fa-list"></i>
            <span>${escapeHtml(t('Records'))}</span>
            <span class="pas-tab-badge" id="pas-list-badge">0</span>
        </button>
        <button class="pas-tab" data-tab="logs" type="button">
            <i class="fa-solid fa-bug"></i>
            <span>${escapeHtml(t('Logs'))}</span>
            <span class="pas-tab-badge" id="pas-log-badge">0</span>
        </button>
        <button class="pas-tab" data-tab="settings" type="button">
            <i class="fa-solid fa-gear"></i>
            <span>${escapeHtml(t('Settings'))}</span>
        </button>
    </div>

    <div class="pas-panel-body">
        <div class="pas-tab-content pas-tab-content-active" data-content="list">
            <div class="pas-toolbar">
                <div class="pas-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pas-search-icon"></i>
                    <input type="text" class="pas-search text_pole" placeholder="${escapeAttr(t('Search preset...'))}" />
                </div>
                <div class="pas-filters">
                    <button class="pas-filter pas-filter-active" data-filter="all" type="button">
                        <i class="fa-solid fa-asterisk"></i><span>${escapeHtml(t('All'))}</span>
                    </button>
                    <button class="pas-filter" data-filter="current" type="button">
                        <i class="fa-solid fa-bullseye"></i><span>${escapeHtml(t('Current Preset'))}</span>
                    </button>
                    <button class="pas-filter" data-filter="pinned" type="button">
                        <i class="fa-solid fa-thumbtack"></i><span>${escapeHtml(t('Filter Pinned'))}</span>
                    </button>
                    <button class="pas-filter" data-filter="today" type="button">
                        <i class="fa-solid fa-calendar-day"></i><span>${escapeHtml(t('Today'))}</span>
                    </button>
                    <button class="pas-filter" data-filter="week" type="button">
                        <i class="fa-solid fa-calendar-week"></i><span>${escapeHtml(t('This Week'))}</span>
                    </button>
                </div>
                <div class="pas-diff-bar" id="pas-diff-bar">
                    <span class="pas-diff-bar-label">
                        <i class="fa-solid fa-code-compare"></i>
                        ${escapeHtml(t('Diff Bar Label'))}
                    </span>
                    <span class="pas-diff-bar-slot pas-diff-slot-a" id="pas-diff-slot-a">
                        <span class="pas-diff-bar-slot-tag">A</span>
                        <span class="pas-diff-bar-slot-text">${escapeHtml(t('Diff Slot Empty'))}</span>
                    </span>
                    <span class="pas-diff-bar-slot pas-diff-slot-b" id="pas-diff-slot-b">
                        <span class="pas-diff-bar-slot-tag">B</span>
                        <span class="pas-diff-bar-slot-text">${escapeHtml(t('Diff Slot Empty'))}</span>
                    </span>
                    <span class="pas-diff-bar-actions">
                        <button class="pas-mini-btn pas-mini-btn-primary pas-btn-start-diff" type="button" disabled>
                            <i class="fa-solid fa-play"></i>
                            <span>${escapeHtml(t('Diff Start'))}</span>
                        </button>
                        <button class="pas-mini-btn pas-btn-clear-diff" type="button" disabled title="${escapeAttr(t('Diff Clear'))}">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </span>
                </div>
                <div class="pas-list-actions">
                    <div class="pas-view-toggle" role="group" aria-label="${escapeAttr(t('Grouping View Series'))}">
                        <button class="pas-view-btn pas-view-btn-series pas-view-btn-active" data-view="series" type="button" title="${escapeAttr(t('Grouping View Series Title'))}">
                            <i class="fa-solid fa-layer-group"></i>
                            <span>${escapeHtml(t('Grouping View Series'))}</span>
                        </button>
                        <button class="pas-view-btn pas-view-btn-flat" data-view="flat" type="button" title="${escapeAttr(t('Grouping View Flat Title'))}">
                            <i class="fa-solid fa-list-ul"></i>
                            <span>${escapeHtml(t('Grouping View Flat'))}</span>
                        </button>
                    </div>
                    <button class="pas-mini-btn pas-btn-batch-toggle" type="button" title="${escapeAttr(t('Batch Manage Btn'))}">
                        <i class="fa-solid fa-check-double"></i>
                        <span>${escapeHtml(t('Batch Manage Btn'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-manage-grouping" type="button" title="${escapeAttr(t('Grouping Manage Title'))}">
                        <i class="fa-solid fa-folder-tree"></i>
                        <span>${escapeHtml(t('Grouping Manage'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-rescan-grouping" type="button" title="${escapeAttr(t('Grouping Rescan Title'))}">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>${escapeHtml(t('Grouping Rescan'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-expand-all" type="button" title="${escapeAttr(t('Expand All'))}">
                        <i class="fa-solid fa-angles-down"></i>
                        <span>${escapeHtml(t('Expand All'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-collapse-all" type="button" title="${escapeAttr(t('Collapse All'))}">
                        <i class="fa-solid fa-angles-up"></i>
                        <span>${escapeHtml(t('Collapse All'))}</span>
                    </button>
                </div>
            </div>
            <div class="pas-snapshot-list"></div>
            <div class="pas-batch-toolbar" id="pas-batch-toolbar" hidden>
                <button class="pas-mini-btn pas-btn-batch-select-all" type="button">
                    <i class="fa-solid fa-check-double"></i>
                    <span>${escapeHtml(t('Batch Select All'))}</span>
                </button>
                <button class="pas-mini-btn pas-btn-batch-deselect-all" type="button">
                    <i class="fa-solid fa-xmark"></i>
                    <span>${escapeHtml(t('Batch Deselect All'))}</span>
                </button>
                <span class="pas-batch-spacer"></span>
                <button class="pas-batch-delete-btn" id="pas-batch-delete-btn" type="button" disabled>
                    <i class="fa-solid fa-trash-can"></i>
                    <span>${escapeHtml(t('Batch Delete Btn', { count: 0 }))}</span>
                </button>
            </div>
        </div>

        <div class="pas-tab-content" data-content="logs">
            <div class="pas-log-toolbar">
                <div class="pas-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pas-search-icon"></i>
                    <input type="text" class="pas-log-search text_pole" placeholder="${escapeAttr(t('Search logs...'))}" />
                </div>
                <div class="pas-filters">
                    <button class="pas-log-filter pas-filter-active" data-level="all" type="button">
                        <span>${escapeHtml(t('All'))}</span>
                    </button>
                    <button class="pas-log-filter pas-log-filter-debug" data-level="debug" type="button">
                        <span>DEBUG</span>
                    </button>
                    <button class="pas-log-filter pas-log-filter-info" data-level="info" type="button">
                        <span>INFO</span>
                    </button>
                    <button class="pas-log-filter pas-log-filter-warn" data-level="warn" type="button">
                        <span>WARN</span>
                    </button>
                    <button class="pas-log-filter pas-log-filter-error" data-level="error" type="button">
                        <span>ERROR</span>
                    </button>
                </div>
                <div class="pas-log-actions">
                    <label class="pas-log-autoscroll" title="${escapeAttr(t('Auto Scroll Desc'))}">
                        <input type="checkbox" class="pas-log-autoscroll-input" checked>
                        <span>${escapeHtml(t('Auto Scroll'))}</span>
                    </label>
                    <button class="pas-mini-btn pas-btn-log-clear" type="button" title="${escapeAttr(t('Clear Logs'))}">
                        <i class="fa-solid fa-broom"></i><span>${escapeHtml(t('Clear Logs'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-log-copy" type="button" title="${escapeAttr(t('Copy Logs'))}">
                        <i class="fa-solid fa-copy"></i><span>${escapeHtml(t('Copy'))}</span>
                    </button>
                    <button class="pas-mini-btn pas-btn-log-export" type="button" title="${escapeAttr(t('Export Logs'))}">
                        <i class="fa-solid fa-download"></i><span>${escapeHtml(t('Export'))}</span>
                    </button>
                </div>
            </div>
            <div class="pas-log-view" id="pas-log-view"></div>
        </div>

        <div class="pas-tab-content" data-content="settings"></div>
    </div>

    <div class="pas-panel-footer">
        <span class="pas-stats" id="pas-footer-stats">…</span>
        <div class="pas-footer-actions">
            <button class="pas-btn-snap menu_button" type="button" title="${escapeAttr(t('Snapshot Now Title'))}">
                <i class="fa-solid fa-camera"></i><span>${escapeHtml(t('Snapshot Now'))}</span>
            </button>
            <button class="pas-btn-purge menu_button" type="button" title="${escapeAttr(t('Purge Corrupt Title'))}">
                <i class="fa-solid fa-shield-halved"></i><span>${escapeHtml(t('Purge Corrupt'))}</span>
            </button>
            <button class="pas-btn-export menu_button" type="button" title="${escapeAttr(t('Export Backup'))}">
                <i class="fa-solid fa-download"></i><span>${escapeHtml(t('Export'))}</span>
            </button>
            <button class="pas-btn-import menu_button" type="button" title="${escapeAttr(t('Import Backup'))}">
                <i class="fa-solid fa-upload"></i><span>${escapeHtml(t('Import'))}</span>
            </button>
            <button class="pas-btn-cleanup menu_button" type="button" title="${escapeAttr(t('Cleanup'))}">
                <i class="fa-solid fa-broom"></i><span>${escapeHtml(t('Cleanup'))}</span>
            </button>
        </div>
    </div>
</div>`;
}

// =====================================================
// 事件绑定
// =====================================================
function bindEvents() {
    if (!_root) return;
    const $ = (s) => _root.querySelector(s);
    const $$ = (s) => _root.querySelectorAll(s);

    // Tab 切换
    $$('.pas-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
    });

    // 搜索（列表）
    const search = $('.pas-search');
    if (search) {
        let timer = null;
        search.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                _state.search = e.target.value.trim();
                renderListTab();
            }, 200);
        });
    }

    // 筛选按钮（列表）
    $$('.pas-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.pas-filter').forEach(b => b.classList.remove('pas-filter-active'));
            btn.classList.add('pas-filter-active');
            _state.filter = btn.getAttribute('data-filter');
            renderListTab();
        });
    });

    // 视图切换（series ↔ flat）
    $$('.pas-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-view');
            if (!v || v === _state.viewMode) return;
            _state.viewMode = v;
            // 同步到 settings：groupingEnabled
            updateSetting('groupingEnabled', v === 'series');
            updateViewToggleUI();
            renderListTab();
        });
    });
    updateViewToggleUI();

    // 管理分组
    $('.pas-btn-manage-grouping')?.addEventListener('click', () => {
        _showGroupingManager(_panelCtx());
    });

    // 重新扫描分组（重置 firstScanDone 后再次弹向导）
    $('.pas-btn-rescan-grouping')?.addEventListener('click', async () => {
        try {
            // AJ-1: 清除所有手动分组覆盖，真正"从零开始"重新识别
            batchUpdate({
                groupingManualOverrides: {},
                groupingFirstScanDone: false,
            });
            // 清空分组解析缓存（万一用户改了正则等）
            clearParseCache();
            await showGroupingFirstScanWizard();
            // Q-1 fix: 向导完成后强制重新种子——
            // 如果用户清空了所有快照后再点"重新扫描分组"，
            // 需要为每个预设重新建立初始快照才能在面板中显示
            await seedSnapshotsIfNeeded({ force: true, silent: false });
            await refreshData();
        } catch (e) {
            logger.error('Rescan grouping failed:', e);
            toast.error(String(e?.message || e));
        }
    });

    // 展开/收起全部
    $('.pas-btn-expand-all')?.addEventListener('click', () => {
        const filtered = applyFiltersAndSearch(_state.snapshots, _panelCtx());
        if (_state.viewMode === 'series') {
            const settings = getSettings();
                const seriesMap = groupSnapshotsBySeries(filtered, {
                    overrides: settings.groupingManualOverrides,
                });
            for (const [seriesKey, info] of seriesMap.entries()) {
                _state.expandedSeries.add(seriesKey);
                for (const ver of info.versions) {
                    _state.expandedVersions.add(presetKey(ver.apiId, ver.presetName));
                }
            }
        } else {
            const presets = groupSnapshotsByPreset(filtered);
            for (const k of Object.keys(presets)) _state.expandedPresets.add(k);
        }
        renderListTab();
    });
    $('.pas-btn-collapse-all')?.addEventListener('click', () => {
        _state.expandedSeries.clear();
        _state.expandedVersions.clear();
        _state.expandedPresets.clear();
        renderListTab();
    });

    // AR-0: 批量模式切换
    $('.pas-btn-batch-toggle')?.addEventListener('click', () => {
        _state.batchMode = !_state.batchMode;
        _state.batchSelected.clear();
        updateBatchUI();
        renderListTab();
    });
    // AR-0: 批量全选
    $('.pas-btn-batch-select-all')?.addEventListener('click', () => {
        if (!_root) return;
        _root.querySelectorAll('.pas-batch-checkbox').forEach(cb => {
            const name = cb.getAttribute('data-preset-name');
            if (name && !cb.disabled) {
                _state.batchSelected.add(name);
                cb.checked = true;
            }
        });
        updateBatchUI();
    });
    // AR-0: 批量取消全选
    $('.pas-btn-batch-deselect-all')?.addEventListener('click', () => {
        _state.batchSelected.clear();
        if (_root) {
            _root.querySelectorAll('.pas-batch-checkbox').forEach(cb => { cb.checked = false; });
        }
        updateBatchUI();
    });
    // AR-0: 批量删除
    $('#pas-batch-delete-btn')?.addEventListener('click', async () => {
        const apiId = getCurrentApiId();
        const names = Array.from(_state.batchSelected);
        if (!names.length) return;
        const count = await _onBatchDeletePresets(names, apiId);
        if (count > 0) {
            _state.batchMode = false;
            _state.batchSelected.clear();
            updateBatchUI();
            await refreshData();
        }
    });

    // 列表事件委托
    const list = $('.pas-snapshot-list');
    if (list) {
        list.addEventListener('click', e => {
            // AR-0: 批量模式下拦截 checkbox 点击
            const cb = e.target.closest('.pas-batch-checkbox');
            if (cb && _state.batchMode) {
                const name = cb.getAttribute('data-preset-name');
                if (name) {
                    if (cb.checked) _state.batchSelected.add(name);
                    else _state.batchSelected.delete(name);
                    updateBatchUI();
                }
                return;
            }
            _handleListClick(e, _panelCtx());
        });
    }

    // diff 选择条
    $('.pas-btn-start-diff')?.addEventListener('click', () => _onStartDiff(_panelCtx()));
    $('.pas-btn-clear-diff')?.addEventListener('click', () => _onClearDiff(_panelCtx()));
    _updateDiffBar(_panelCtx());

    // ----- 日志 Tab 事件 -----
    const logSearch = $('.pas-log-search');
    if (logSearch) {
        let timer = null;
        logSearch.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                _state.log.search = e.target.value.trim();
                renderLogTab(_panelCtx());
            }, 200);
        });
    }
    $$('.pas-log-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.pas-log-filter').forEach(b => b.classList.remove('pas-filter-active'));
            btn.classList.add('pas-filter-active');
            _state.log.level = btn.getAttribute('data-level');
            renderLogTab(_panelCtx());
        });
    });
    $('.pas-log-autoscroll-input')?.addEventListener('change', (e) => {
        _state.log.autoScroll = !!e.target.checked;
    });
    $('.pas-btn-log-clear')?.addEventListener('click', () => onLogClear(_panelCtx()));
    $('.pas-btn-log-copy')?.addEventListener('click', () => onLogCopy(_panelCtx()));
    $('.pas-btn-log-export')?.addEventListener('click', () => onLogExport(_panelCtx()));

    // 底部按钮
    $('.pas-btn-cleanup')?.addEventListener('click', () => onCleanup(_panelCtx()));
    $('.pas-btn-export')?.addEventListener('click', () => onExport());
    $('.pas-btn-import')?.addEventListener('click', () => onImport(_panelCtx()));
    $('.pas-btn-snap')?.addEventListener('click', () => onSnapshotNow(_panelCtx()));
    $('.pas-btn-purge')?.addEventListener('click', () => onPurgeCorrupt(_panelCtx()));

    // 订阅日志（增量更新，节流）
    _logUnsubscribe = logger.subscribe(() => {
        if (_state.tab !== 'logs') {
            updateLogBadge(_panelCtx());
            return;
        }
        if (_logRefreshTimer) return;
        _logRefreshTimer = setTimeout(() => {
            _logRefreshTimer = null;
            renderLogTab(_panelCtx());
        }, 200);
    });

    // ⚡ 订阅预设切换事件 → 实时更新"当前预设"金色高亮
    //   不重新加载所有快照（避免性能问题），只重新渲染列表
    let _panelRefreshTimer = null;
    const onPresetChanged = () => {
        if (_panelRefreshTimer) return;
        _panelRefreshTimer = setTimeout(() => {
            _panelRefreshTimer = null;
            try {
                if (_state.tab === 'list') renderListTab();
                updateStats(_panelCtx());
            } catch (e) {
                logger.debug('[Panel] preset-changed re-render failed:', e);
            }
        }, 80);
    };

    const presetChangeEvents = [
        getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after'),
        getEventType('PRESET_CHANGED', 'preset_changed'),
        getEventType('CHATCOMPLETION_SOURCE_CHANGED', 'chatcompletion_source_changed'),
        getEventType('MAIN_API_CHANGED', 'main_api_changed'),
    ].filter(Boolean);
    for (const ev of presetChangeEvents) {
        try {
            onEvent(ev, onPresetChanged);
            _panelEventBindings.push({ event: ev, handler: onPresetChanged });
        } catch (e) {
            logger.debug(`[Panel] subscribe ${ev} failed:`, e);
        }
    }
}

// =====================================================
// Tab 切换
// =====================================================
function switchTab(tabName) {
    if (!tabName || _state.tab === tabName) return;
    _state.tab = tabName;
    if (!_root) return;
    const $$ = (s) => _root.querySelectorAll(s);

    $$('.pas-tab').forEach(t => {
        t.classList.toggle('pas-tab-active', t.getAttribute('data-tab') === tabName);
    });
    $$('.pas-tab-content').forEach(c => {
        c.classList.toggle('pas-tab-content-active', c.getAttribute('data-content') === tabName);
    });

    renderActiveTab();
}

function renderActiveTab() {
    if (!_root) return;
    const ctx = _panelCtx();
    if (_state.tab === 'list') renderListTab();
    else if (_state.tab === 'logs') renderLogTab(ctx);
    else if (_state.tab === 'settings') renderSettingsTab(ctx);
    updateStats(ctx);
    updateLogBadge(ctx);
}

// =====================================================
// 列表 Tab 渲染（series 三级 / flat 两级）
// =====================================================
/**
 * ⚡ 性能优化：渲染时序保护——避免重复渲染
 * 用 rAF 把同步连续触发（filter / 搜索 / view-toggle）合并为一次绘制
 */
let _renderListScheduled = false;
function renderListTab() {
    if (_renderListScheduled) return;
    _renderListScheduled = true;
    requestAnimationFrame(() => {
        _renderListScheduled = false;
        _renderListTabImpl();
    });
}

function _renderListTabImpl() {
    const list = _root?.querySelector('.pas-snapshot-list');
    if (!list) return;

    const filtered = applyFiltersAndSearch(_state.snapshots, _panelCtx());
    if (filtered.length === 0) {
        list.innerHTML = renderEmptyState(_panelCtx());
        updateBadge(0);
        return;
    }

    // ⚡ 大数据量优化：>5000 条时分批 render，避免主线程长任务
    const html = (_state.viewMode === 'series')
        ? renderSeriesView(filtered, _panelCtx())
        : renderFlatView(filtered, _panelCtx());
    list.innerHTML = html;
    updateBadge(filtered.length);

    // AR-0: 批量模式下注入复选框
    if (_state.batchMode) {
        updateBatchUI();
    }
}

/**
 * 视图切换按钮的 active 同步
 */
function updateViewToggleUI() {
    if (!_root) return;
    _root.querySelectorAll('.pas-view-btn').forEach(b => {
        b.classList.toggle('pas-view-btn-active', b.getAttribute('data-view') === _state.viewMode);
    });
    // 系列视图下显示"管理分组"按钮，flat 隐藏
    const manageBtn = _root.querySelector('.pas-btn-manage-grouping');
    if (manageBtn) {
        manageBtn.style.display = (_state.viewMode === 'series') ? '' : 'none';
    }
}

// =====================================================
// Re-export showGroupingFirstScanWizard（保持 index.js 的导入不变）
// =====================================================
/**
 * 弹出"首次整理预设分组"向导（委托给 panel-actions.js）
 */
export async function showGroupingFirstScanWizard(opts) {
    return _showGroupingFirstScanWizard(opts);
}

// =====================================================
// 导入识别：监听预设列表变化
// =====================================================
/**
 * 启动"导入识别"机制：
 *   - 第一次启动时记录当前预设名快照（基线）
 *   - 监听 SETTINGS_UPDATED / OAI_PRESET_CHANGED_AFTER 事件，
 *     在事件触发后做一次轻量 diff（事件驱动，无轮询）
 *   - 发现新增预设时弹出"建议归属"提示
 *
 * 设计要点：
 *   - 完全事件驱动，无 setInterval —— 与 P10 优化一致
 *   - 仅在 settings.groupingEnabled && settings.groupingPromptOnImport 时弹窗
 *   - 弹窗串行（_importPromptInflight 防并发）
 *   - 如果用户为该预设手动设置过归属（出现在 overrides），不再提示
 *   - 检查节流：最快每 1500ms 处理一次事件
 */
let _importWatchPrev = null;          // Set<string> 上次已知的预设名
let _importPromptInflight = false;    // 防多次弹窗叠加
let _importWatchUnsubs = [];          // 事件取消订阅函数
let _importWatchThrottleTs = 0;
let _importWatchThrottleTimer = null;
const IMPORT_WATCH_THROTTLE_MS = 1500;

function startImportWatcher() {
    stopImportWatcher();
    // 首次记录基线（不弹窗）
    _importWatchPrev = collectKnownPresetNames();

    try {
        const events = [
            getEventType('SETTINGS_UPDATED', 'settings_updated'),
            getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after'),
            getEventType('PRESET_CHANGED', 'preset_changed'),
        ];
        for (const ev of events) {
            const off = onEvent(ev, scheduleImportWatchTick);
            _importWatchUnsubs.push(off);
        }
        logger.debug('Import watcher armed');
    } catch (e) {
        logger.warn('Import watcher failed to start:', e);
    }
}

function stopImportWatcher() {
    for (const off of _importWatchUnsubs) {
        try { off(); } catch (_) {}
    }
    _importWatchUnsubs.length = 0;
    if (_importWatchThrottleTimer) {
        clearTimeout(_importWatchThrottleTimer);
        _importWatchThrottleTimer = null;
    }
}

/**
 * 节流：事件触发后，最多 1500ms 后跑一次 importWatchTick
 */
function scheduleImportWatchTick() {
    const now = Date.now();
    if (now - _importWatchThrottleTs < IMPORT_WATCH_THROTTLE_MS) {
        if (_importWatchThrottleTimer) return;
        _importWatchThrottleTimer = setTimeout(() => {
            _importWatchThrottleTimer = null;
            _importWatchThrottleTs = Date.now();
            importWatchTick().catch(e => logger.warn('import-watch tick failed:', e));
        }, IMPORT_WATCH_THROTTLE_MS - (now - _importWatchThrottleTs));
        return;
    }
    _importWatchThrottleTs = now;
    importWatchTick().catch(e => logger.warn('import-watch tick failed:', e));
}

/**
 * 收集"已知预设名"：getAllPresetNames() 的结果
 * P-2: 过滤无效名称（空字符串、纯空格、纯数字占位符等）
 */
function collectKnownPresetNames() {
    const set = new Set();
    try {
        const arr = getAllPresetNames();
        if (Array.isArray(arr)) {
            for (const n of arr) {
                if (!n || typeof n !== 'string') continue;
                const s = n.trim();
                if (!s) continue;
                // 过滤纯数字占位符（如 "1", "  2 ", "_.3._"）
                if (/^[\s\-_.]*\d+[\s\-_.]*$/.test(s)) continue;
                set.add(n);
            }
        }
    } catch (_) {}
    return set;
}

async function importWatchTick() {
    const settings = getSettings();
    if (_importPromptInflight) return;

    const cur = collectKnownPresetNames();
    if (!_importWatchPrev || _importWatchPrev.size === 0) {
        _importWatchPrev = cur;
        return;
    }

    // 找出新增预设名
    const added = [];
    for (const n of cur) if (!_importWatchPrev.has(n)) added.push(n);

    // 同步基线
    _importWatchPrev = cur;
    if (added.length === 0) return;

    // V-1: 为新导入的预设创建初始快照（不受 grouping 开关限制）
    if (settings.enabled) {
        for (const name of added) {
            try {
                await seedSnapshotForPreset(name);
            } catch (e) {
                logger.debug(`[ImportWatch] seed failed for "${name}":`, e);
            }
        }
    }

    // 分组弹窗仅在 grouping 相关设置启用时触发
    if (!settings.groupingEnabled || !settings.groupingPromptOnImport) return;

    // 已被用户标记的不再提示
    const overrides = settings.groupingManualOverrides || {};
    const candidates = added.filter(n =>
        !Object.hasOwn(overrides, n)
    );
    if (candidates.length === 0) return;

    // 收集现有系列（不含 added 自己）
    const existingNames = Array.from(cur).filter(n => !candidates.includes(n));
    const existingGroups = groupNamesBySeries(existingNames, overrides);
    const existingSeries = existingGroups.map(g => g.series);

    // ⚡ P3 修复：过滤掉与已存在预设同属一个系列的候选
    //   版本切换（takeover）时，被隐藏的 option 可能被临时恢复到 select 中，
    //   导致同系列版本被误判为"新导入"。通过 normalizeSeriesKey 比较排除。
    const existingNormKeys = new Set(existingSeries.map(s => normalizeSeriesKey(s)));
    const trulyNewCandidates = candidates.filter(n => {
        const info = getSeriesInfo(n, overrides);
        const normKey = normalizeSeriesKey(info.series || n);
        return !existingNormKeys.has(normKey);
    });
    if (trulyNewCandidates.length === 0) return;

    // 一次只处理一个，避免连环弹窗
    for (const newName of trulyNewCandidates) {
        const ok = await maybePromptForImportAssignment(newName, existingSeries);
        if (!ok) break; // 用户取消则停止
    }
}

/**
 * 弹窗：建议把新预设归到某系列
 * @returns {Promise<boolean>} 是否继续处理后续候选
 */
async function maybePromptForImportAssignment(newName, existingSeries) {
    const parsed = parsePresetName(newName);
    const candidate = parsed.series;

    // 自动识别后系列名 == 原名（无版本）→ 没有歧义，新建系列即可，不打扰
    if (!parsed.version && existingSeries.includes(candidate) === false) {
        return true;
    }

    // 自动归到现有系列时，弹窗确认（用户最常见的诉求）
    let suggested = '';
    if (existingSeries.includes(candidate)) {
        suggested = candidate;
    } else {
        // 大小写不敏感匹配
        const lower = candidate.toLowerCase();
        const hit = existingSeries.find(s => s.toLowerCase() === lower);
        if (hit) suggested = hit;
    }

    // 没有匹配的现有系列 → 新建系列，不打扰
    if (!suggested) return true;

    _importPromptInflight = true;
    try {
        const ctx = SillyTavern.getContext();
        const ok = await confirmSafe(
            t('Grouping Import Detected Title'),
            `<div>${t('Grouping Import Detected Hint', {
                name: `<b>${escapeHtml(newName)}</b>`,
                series: `<b>${escapeHtml(suggested)}</b>`,
            })}</div>
            <div style="margin-top: 6px; font-size: 0.86em; opacity: 0.7;">
              ${escapeHtml(t('Grouping Manage Auto'))}: ${escapeHtml(parsed.series)}
              ${parsed.version ? ` · ${escapeHtml(parsed.version)}` : ''}
            </div>`
        );
        if (ok) {
            // 写入手动覆盖：精确归到 suggested
            const newOverrides = { ...(getSettings().groupingManualOverrides || {}) };
            newOverrides[newName] = suggested;
            updateSetting('groupingManualOverrides', newOverrides);
            toast.success(t('Grouping Override Set', { name: newName, series: suggested }));
        }
        return true;
    } catch (e) {
        logger.warn('Import prompt failed:', e);
        return false;
    } finally {
        _importPromptInflight = false;
    }
}

function updateBadge(count) {
    if (!_root || !_root.isConnected) return;
    const badge = _root.querySelector('#pas-list-badge');
    if (badge) badge.textContent = String(count);
}

/**
 * AR-0: 更新批量模式 UI 状态
 *   - 切换批量工具栏可见性
 *   - 切换"批量"按钮高亮
 *   - 更新"删除选中 (N)"按钮文本和可用性
 *   - 在版本卡上注入/移除复选框
 */
function updateBatchUI() {
    if (!_root) return;
    const toolbar = _root.querySelector('#pas-batch-toolbar');
    const toggleBtn = _root.querySelector('.pas-btn-batch-toggle');
    const deleteBtn = _root.querySelector('#pas-batch-delete-btn');

    if (toolbar) toolbar.hidden = !_state.batchMode;
    if (toggleBtn) {
        toggleBtn.classList.toggle('pas-mini-btn-primary', _state.batchMode);
    }

    // 更新删除按钮文本和状态
    if (deleteBtn) {
        const count = _state.batchSelected.size;
        const span = deleteBtn.querySelector('span');
        if (span) span.textContent = t('Batch Delete Btn', { count });
        if (count > 0) deleteBtn.removeAttribute('disabled');
        else deleteBtn.setAttribute('disabled', 'disabled');
    }

    // 注入/移除复选框
    _root.querySelectorAll('.pas-version-group').forEach(vg => {
        const presetName = vg.getAttribute('data-preset-name');
        if (!presetName) return;
        const header = vg.querySelector('.pas-version-header-row-title');
        if (!header) return;

        // 移除旧的
        header.querySelectorAll('.pas-batch-checkbox').forEach(el => el.remove());

        if (_state.batchMode) {
            const currentPreset = getSelectedPresetName();
            const isCurrent = presetName === currentPreset;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'pas-batch-checkbox';
            cb.setAttribute('data-preset-name', presetName);
            cb.checked = _state.batchSelected.has(presetName);
            if (isCurrent) {
                cb.disabled = true;
                cb.title = t('Delete Preset Current Warning');
            }
            // 阻止 checkbox 点击触发折叠
            cb.addEventListener('click', (e) => e.stopPropagation());
            header.insertBefore(cb, header.firstChild);
        }
    });
}

// =====================================================
// 工具函数
// =====================================================
// escapeAttr 已从 panel-summary.js（→ compatibility.js）导入
