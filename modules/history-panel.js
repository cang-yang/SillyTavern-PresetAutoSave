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
import { onHistoryChange } from './core/history-change-events.js';
import { captureFocusAnchor, restoreFocusAnchor } from './core/focus-anchor.js';
import { getSaveStatus, saveStatusLabelKey } from './core/save-status.js';
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
    findSeriesAssignment,
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
import { buildPanelHTML as buildPanelShellHTML } from './panel-shell.js';
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
import { shouldActivateDisclosureFromKeydown } from './panel-disclosure.js';
import { BULK_SNAPSHOT_RENDER_LIMIT } from './core/bounded-snapshot-list.js';

// =====================================================
// 状态
// =====================================================
let _initialized = false;  // 幂等守卫：防止 initHistoryPanel 重复调用
let _popup = null;
let _root = null;
let _logUnsubscribe = null;
let _logRefreshTimer = null;
let _panelSearchTimer = null;
let _panelLogSearchTimer = null;
let _panelPresetRefreshTimer = null;
let _renderListFrame = null;
let _historyRefreshUnsubscribe = null;
let _historyRefreshTimer = null;
let _panelDataWarmupPromise = null;
let _panelDataCache = null;
let _panelDataCacheAt = 0;
let _panelDataCacheGeneration = 0;
let _panelMountGeneration = 0;
let _activeDatasetLoader = null;
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
const PANEL_DATA_CACHE_TTL_MS = 15000;
const PANEL_WARMUP_DELAY_MS = 1200;
const PANEL_SEARCH_DEBOUNCE_MS = 30;

function scheduleIdleWork(fn, delay = 0) {
    const run = () => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fn, { timeout: 3000 });
        } else {
            setTimeout(fn, 0);
        }
    };
    setTimeout(run, delay);
}

function invalidatePanelDataCache() {
    _panelDataCacheGeneration++;
    _panelDataCache = null;
    _panelDataCacheAt = 0;
    _panelDataWarmupPromise = null;
}

function loadPanelDataset({ allowCache = true } = {}) {
    const now = Date.now();
    if (allowCache && _panelDataCache && (now - _panelDataCacheAt) < PANEL_DATA_CACHE_TTL_MS) {
        return _panelDataCache;
    }
    if (allowCache && _panelDataWarmupPromise) {
        return _panelDataWarmupPromise;
    }
    const generation = _panelDataCacheGeneration;
    const promise = Promise.all([
        getAllSnapshots(),
        listArchivedPresets(),
    ]).then(([snapshots, archives]) => {
        const dataset = { snapshots: snapshots || [], archives: archives || [] };
        if (generation === _panelDataCacheGeneration) {
            _panelDataCache = dataset;
            _panelDataCacheAt = Date.now();
        }
        return dataset;
    }).finally(() => {
        if (_panelDataWarmupPromise === promise) _panelDataWarmupPromise = null;
    });
    if (allowCache) _panelDataWarmupPromise = promise;
    return promise;
}

function warmupPanelData() {
    if (_panelDataWarmupPromise || _panelDataCache) return;
    const promise = loadPanelDataset({ allowCache: false });
    _panelDataWarmupPromise = promise;
    promise.catch((e) => {
        logger.debug('[Panel] data warmup failed:', e);
    });
}

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
        snapshotRenderLimits: new Map(),
        diffSel: { a: null, b: null },
        log: { level: 'all', search: '', autoScroll: true },
        batchMode: false,           // AR-0: 批量模式
        batchSelected: new Set(),   // AR-0: 批量选中的预设名
        _cachedSeriesMap: null,     // 性能优化：缓存 groupSnapshotsBySeries() 结果，避免 loadData→render 重复计算
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
        refreshData: (options) => refreshData(options),
        renderListTab: () => renderListTab(),
        archivedCache: () => _archivedCache,
    };
}

function renderPanelLoading(stage = 'loading') {
    const listEl = _root?.querySelector('.pas-snapshot-list');
    if (!listEl) return;
    listEl.setAttribute('aria-busy', 'true');
    listEl.innerHTML = `<div class="pas-empty pas-panel-loading" data-stage="${escapeAttr(stage)}">
        <i class="fa-solid fa-spinner fa-spin pas-empty-icon"></i>
        <p class="pas-empty-text">${escapeHtml(t('Panel Loading History'))}</p>
    </div>`;
}

function recordPanelPerf(stage, startedAt, details = {}) {
    const elapsed = Math.round(performance.now() - startedAt);
    const payload = { stage, elapsedMs: elapsed, ...details };
    if (elapsed > 250) logger.info('[PanelPerf]', payload);
    else logger.debug('[PanelPerf]', payload);
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
    scheduleIdleWork(() => warmupPanelData(), PANEL_WARMUP_DELAY_MS);
    if (!_historyRefreshUnsubscribe) {
        _historyRefreshUnsubscribe = onHistoryChange(() => {
            invalidatePanelDataCache();
            scheduleIdleWork(() => warmupPanelData(), 500);
            if (!_root || _historyRefreshTimer) return;
            _historyRefreshTimer = setTimeout(async () => {
                _historyRefreshTimer = null;
                try {
                    await refreshData({ allowCache: false });
                } catch (e) {
                    logger.debug('[Panel] history change refresh failed:', e);
                }
            }, 120);
        });
    }
}

/**
 * 卸载（onDelete/onDisable 时调用）
 */
export function teardownHistoryPanel() {
    stopImportWatcher();
    if (_root) disposeHistoryPanelMount(_root);
    cleanupActionPopups({ includeWizard: true });
    if (_historyRefreshUnsubscribe) {
        _historyRefreshUnsubscribe();
        _historyRefreshUnsubscribe = null;
    }
    if (_historyRefreshTimer) {
        clearTimeout(_historyRefreshTimer);
        _historyRefreshTimer = null;
    }
    invalidatePanelDataCache();
    _initialized = false;
}

// =====================================================
// 显示面板
// =====================================================
function buildHistoryPanelMarkup() {
    const saveStatus = getSaveStatus();
    return buildPanelShellHTML({
        t,
        escapeHtml,
        escapeAttr,
        saveStatus,
        saveStatusLabel: t(saveStatusLabelKey(saveStatus)),
    });
}

export function renderHistoryPanelShell(host) {
    if (!host || typeof host.querySelector !== 'function') {
        throw new TypeError('renderHistoryPanelShell requires a DOM host element');
    }
    host.innerHTML = buildHistoryPanelMarkup();
    const root = host.querySelector('.pas-panel');
    if (!root) throw new Error('History panel shell did not render a root element');
    return root;
}

function renderPanelError() {
    const listEl = _root?.querySelector('.pas-snapshot-list')
        || _root?.querySelector('[data-content="list"]');
    if (!listEl) return;
    listEl.removeAttribute('aria-busy');
    listEl.innerHTML = `<div class="pas-empty pas-panel-error" role="alert">
        <div class="pas-empty-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <p class="pas-empty-text">${escapeHtml(t('Panel Open Failed'))}</p>
        <p class="pas-empty-hint">${escapeHtml(t('Panel Open Recovery Hint'))}</p>
    </div>`;
}

async function loadAndRenderMountedPanel(root, generation, panelStartedAt) {
    let failedStage = null;
    try {
        failedStage = 'loadData';
        const loadStartedAt = performance.now();
        const loaded = await loadData({ mountGeneration: generation });
        if (!loaded || _root !== root || generation !== _panelMountGeneration) return false;
        recordPanelPerf('loadData', loadStartedAt, { snapshots: _state.snapshots.length, archives: _archivedCache.length });
        updateViewToggleUI();

        failedStage = 'renderActiveTab';
        const renderStartedAt = performance.now();
        renderActiveTab({ immediateList: true });
        root.querySelector('.pas-snapshot-list')?.removeAttribute('aria-busy');
        recordPanelPerf('renderActiveTab', renderStartedAt, { snapshots: _state.snapshots.length });

        failedStage = 'updateStats';
        await updateStats(_panelCtx());
        if (_root !== root || generation !== _panelMountGeneration) return false;
        failedStage = null;
        recordPanelPerf('ready', panelStartedAt, { snapshots: _state.snapshots.length, archives: _archivedCache.length });
        return true;
    } catch (error) {
        if (_root !== root || generation !== _panelMountGeneration) return false;
        logger.error(`[Panel] render failed at stage="${failedStage}":`, error);
        if (error?.stack) logger.error('[Panel] stack:', error.stack);
        renderPanelError();
        return false;
    }
}

export function mountHistoryPanel(root, { loadDataset = loadPanelDataset } = {}) {
    if (!root || !root.classList?.contains('pas-panel')) {
        throw new TypeError('mountHistoryPanel requires a .pas-panel root');
    }
    if (_root) throw new Error('A history panel is already mounted');
    if (typeof loadDataset !== 'function') throw new TypeError('loadDataset must be a function');

    resetState();
    _root = root;
    _activeDatasetLoader = loadDataset;
    const generation = ++_panelMountGeneration;
    const panelStartedAt = performance.now();
    renderPanelLoading('loading-history');
    bindEvents();
    const ready = loadAndRenderMountedPanel(root, generation, panelStartedAt);

    return Object.freeze({
        root,
        ready,
        dispose: () => disposeHistoryPanelMount(root),
    });
}

export function disposeHistoryPanelMount(root = _root) {
    if (!_root || (root && root !== _root)) return false;
    _panelMountGeneration++;
    if (_logUnsubscribe) {
        try { _logUnsubscribe(); } catch (_) {}
        _logUnsubscribe = null;
    }
    if (_logRefreshTimer) {
        clearTimeout(_logRefreshTimer);
        _logRefreshTimer = null;
    }
    if (_historyRefreshTimer) {
        clearTimeout(_historyRefreshTimer);
        _historyRefreshTimer = null;
    }
    if (_panelSearchTimer) {
        clearTimeout(_panelSearchTimer);
        _panelSearchTimer = null;
    }
    if (_panelLogSearchTimer) {
        clearTimeout(_panelLogSearchTimer);
        _panelLogSearchTimer = null;
    }
    if (_panelPresetRefreshTimer) {
        clearTimeout(_panelPresetRefreshTimer);
        _panelPresetRefreshTimer = null;
    }
    if (_renderListFrame !== null) {
        cancelAnimationFrame(_renderListFrame);
        _renderListFrame = null;
        _renderListScheduled = false;
    }
    for (const { event, handler } of _panelEventBindings) {
        try { offEvent(event, handler); } catch (_) {}
    }
    _panelEventBindings = [];
    cleanupActionPopups();
    _activeDatasetLoader = null;
    _root = null;
    resetState();
    return true;
}

export async function showHistoryPanel() {
    if (_popup) return;

    // Step 1: create the host popup, then delegate all workspace behavior to
    // the same production mount lifecycle used by browser verification.
    const html = buildHistoryPanelMarkup();

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

    const root = document.querySelector('.pas-panel');

    // ⚡ C3 修复已移除：stopPropagation 会阻止滚动等正常交互。
    //   ST Popup 使用原生 <dialog>.showModal()，关闭是通过 cancel 事件
    //   （Escape / backdrop click）触发的，不依赖 mousedown 事件冒泡，
    //   因此 stopPropagation 既无法阻止弹窗关闭，又会破坏页面滚动。
    if (!root) {
        logger.error('Panel root not found');
        _popup = null;
        return;
    }
    const mount = mountHistoryPanel(root);

    try {
        await promise;
    } finally {
        mount.dispose();
        _popup = null;
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
async function loadData({ allowCache = true, mountGeneration = _panelMountGeneration } = {}) {
    // 并行加载快照 + 归档（数据接管模式下面板要展示完整版本）
    const loader = _activeDatasetLoader || loadPanelDataset;
    const { snapshots, archives } = await loader({ allowCache });
    if (!_root || mountGeneration !== _panelMountGeneration) return false;
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

    const overrides = settings.groupingManualOverrides;
    const seriesMap = groupSnapshotsBySeries(_state.snapshots, {
        overrides,
        aliases: settings.groupingSeriesAliases,
    });

    // 两种初始视图都预先建立投影，首次从平铺切到系列时无需在交互路径重复分组。
    _state._cachedSeriesMap = seriesMap;

    if (_state.viewMode === 'series') {
        // O-1: 默认全部收起（'none'），用户可在设置中改为 'current' 或 'all'
        const expandMode = settings.groupingDefaultExpand || 'none';

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
    return true;
}

async function refreshData(options = { allowCache: false }) {
    if (!_root) return;  // 面板已关闭
    if (_historyRefreshTimer) {
        clearTimeout(_historyRefreshTimer);
        _historyRefreshTimer = null;
    }
    const loaded = await loadData(options);
    if (!loaded) return;
    renderActiveTab();
    await updateStats(_panelCtx());
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
        tab.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = Array.from($$('.pas-tab'));
            const current = tabs.indexOf(tab);
            const next = event.key === 'Home' ? 0
                : event.key === 'End' ? tabs.length - 1
                    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
        });
    });

    // 低频工具集中在一个可关闭的菜单中，避免主界面长期被操作按钮占满。
    const toolsTrigger = $('.pas-tools-trigger');
    const toolsMenu = $('.pas-tools-menu');
    const closeTools = ({ restoreFocus = false } = {}) => {
        if (!toolsTrigger || !toolsMenu || toolsMenu.hidden) return;
        toolsMenu.hidden = true;
        toolsTrigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) toolsTrigger.focus();
    };
    toolsTrigger?.addEventListener('click', () => {
        const willOpen = toolsMenu.hidden;
        toolsMenu.hidden = !willOpen;
        toolsTrigger.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) toolsMenu.querySelector('[role="menuitem"]')?.focus();
    });
    toolsMenu?.addEventListener('click', (event) => {
        if (event.target.closest('[role="menuitem"]')) closeTools();
    });
    toolsMenu?.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(toolsMenu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
    });
    _root.addEventListener('click', (event) => {
        if (!event.target.closest('.pas-tools')) closeTools();
    });
    _root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !toolsMenu?.hidden) {
            event.preventDefault();
            closeTools({ restoreFocus: true });
        }
    });

    // 搜索（列表）
    const search = $('.pas-search');
    if (search) {
        search.addEventListener('input', (e) => {
            clearTimeout(_panelSearchTimer);
            _panelSearchTimer = setTimeout(() => {
                _panelSearchTimer = null;
                _state.search = e.target.value.trim();
                renderListTabImmediately();
            }, PANEL_SEARCH_DEBOUNCE_MS);
        });
    }

    // 筛选按钮（列表）
    $$('.pas-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.pas-filter').forEach(b => b.classList.remove('pas-filter-active'));
            $$('.pas-filter').forEach(b => b.setAttribute('aria-pressed', 'false'));
            btn.classList.add('pas-filter-active');
            btn.setAttribute('aria-pressed', 'true');
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
            $$('.pas-view-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
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
    // AT0: 不再在弹向导前清空 groupingManualOverrides，
    //      改为仅在用户确认"建立分组"后才清空（showGroupingFirstScanWizard 返回 true 时）
    $('.pas-btn-rescan-grouping')?.addEventListener('click', async () => {
        try {
            // AT0: 先备份当前手动覆盖，以便用户取消时恢复
            const prevSettings = getSettings();
            const prevOverrides = { ...(prevSettings.groupingManualOverrides || {}) };
            const prevFirstScanDone = prevSettings.groupingFirstScanDone;

            // 清空分组解析缓存
            clearParseCache();

            // AT0: 调用向导并通过返回值可靠判断用户选择
            const confirmed = await showGroupingFirstScanWizard({ isRescan: true });

            if (confirmed) {
                // 用户点了"建立分组" — 清空手动覆盖，重新自动识别
                batchUpdate({ groupingManualOverrides: {} });
                // Q-1 fix: 向导完成后强制重新种子
                await seedSnapshotsIfNeeded({ force: true, silent: false });
            } else {
                // 用户点了"返回" — 恢复之前的状态，确保不丢数据
                batchUpdate({
                    groupingManualOverrides: prevOverrides,
                    groupingFirstScanDone: prevFirstScanDone,
                });
            }
            await refreshData();
            refreshTakeover({ force: true });
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
                    aliases: settings.groupingSeriesAliases,
                });
            for (const [seriesKey, info] of seriesMap.entries()) {
                _state.expandedSeries.add(seriesKey);
                for (const ver of info.versions) {
                    const key = presetKey(ver.apiId, ver.presetName);
                    _state.expandedVersions.add(key);
                    _state.snapshotRenderLimits.set(key, BULK_SNAPSHOT_RENDER_LIMIT);
                }
            }
        } else {
            const presets = groupSnapshotsByPreset(filtered);
            for (const k of Object.keys(presets)) {
                _state.expandedPresets.add(k);
                _state.snapshotRenderLimits.set(k, BULK_SNAPSHOT_RENDER_LIMIT);
            }
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
        list.addEventListener('keydown', e => {
            const toggle = e.target.closest('[data-action="toggle-group"], [data-action="toggle-series"], [data-action="toggle-version"]');
            if (!shouldActivateDisclosureFromKeydown(e, toggle)) return;
            e.preventDefault();
            toggle.click();
        });
    }

    // diff 选择条
    $('.pas-btn-start-diff')?.addEventListener('click', () => _onStartDiff(_panelCtx()));
    $('.pas-btn-clear-diff')?.addEventListener('click', () => _onClearDiff(_panelCtx()));
    _updateDiffBar(_panelCtx());

    // ----- 日志 Tab 事件 -----
    const logSearch = $('.pas-log-search');
    if (logSearch) {
        logSearch.addEventListener('input', (e) => {
            clearTimeout(_panelLogSearchTimer);
            _panelLogSearchTimer = setTimeout(() => {
                _panelLogSearchTimer = null;
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
    const onPresetChanged = () => {
        if (_panelPresetRefreshTimer) return;
        _panelPresetRefreshTimer = setTimeout(() => {
            _panelPresetRefreshTimer = null;
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
        const active = t.getAttribute('data-tab') === tabName;
        t.classList.toggle('pas-tab-active', active);
        t.setAttribute('aria-selected', String(active));
        t.tabIndex = active ? 0 : -1;
    });

    $$('.pas-tab-content').forEach(c => {
        const active = c.getAttribute('data-content') === tabName;
        c.classList.toggle('pas-tab-content-active', active);
        c.hidden = !active;
    });

    renderActiveTab();
}

function renderActiveTab({ immediateList = false } = {}) {
    if (!_root) return;
    const ctx = _panelCtx();
    if (_state.tab === 'list') {
        if (immediateList) _renderListTabImpl();
        else renderListTab();
    }
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
    _renderListFrame = requestAnimationFrame(() => {
        _renderListFrame = null;
        _renderListScheduled = false;
        _renderListTabImpl();
    });
}

function renderListTabImmediately() {
    if (_renderListFrame !== null) {
        cancelAnimationFrame(_renderListFrame);
        _renderListFrame = null;
        _renderListScheduled = false;
    }
    _renderListTabImpl();
}

function _renderListTabImpl() {
    const list = _root?.querySelector('.pas-snapshot-list');
    if (!list) return;

    const focusAnchor = captureFocusAnchor(list);
    const scrollTop = list.scrollTop;
    const restoreInteractionPosition = () => {
        restoreFocusAnchor(list, focusAnchor, _root?.querySelector('.pas-search'));
        list.scrollTop = scrollTop;
    };

    const filtered = applyFiltersAndSearch(_state.snapshots, _panelCtx());
    if (filtered.length === 0) {
        list.innerHTML = renderEmptyState(_panelCtx());
        updateBadge(0);
        restoreInteractionPosition();
        return;
    }

    // ⚡ 性能优化：将 loadData() 中缓存的 seriesMap 传递给 renderSeriesView，
    //    避免 groupSnapshotsBySeries() 重复计算（每个面板打开周期计算2次→1次）
    const html = (_state.viewMode === 'series')
        ? renderSeriesView(filtered, _panelCtx(), _state._cachedSeriesMap)
        : renderFlatView(filtered, _panelCtx());
    list.innerHTML = html;
    updateBadge(filtered.length);

    // AR-0: 批量模式下注入复选框
    if (_state.batchMode) {
        updateBatchUI();
    }
    restoreInteractionPosition();
}

/**
 * 视图切换按钮的 active 同步
 */
function updateViewToggleUI() {
    if (!_root) return;
    _root.querySelectorAll('.pas-view-btn').forEach(b => {
        const active = b.getAttribute('data-view') === _state.viewMode;
        b.classList.toggle('pas-view-btn-active', active);
        b.setAttribute('aria-pressed', String(active));
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
    const existingGroups = groupNamesBySeries(existingNames, overrides, getSettings().groupingSeriesAliases);

    // ⚡ P3 修复：过滤掉与已存在预设同属一个系列的候选
    //   版本切换（takeover）时，被隐藏的 option 可能被临时恢复到 select 中，
    //   导致同系列版本被误判为"新导入"。通过 normalizeSeriesKey 比较排除。
    const existingNormKeys = new Set(existingGroups.map(group => group.canonicalKey));
    const trulyNewCandidates = candidates.filter(n => {
        const info = getSeriesInfo(n, overrides);
        const normKey = normalizeSeriesKey(info.series || n);
        return !existingNormKeys.has(normKey);
    });
    if (trulyNewCandidates.length === 0) return;

    // 一次只处理一个，避免连环弹窗
    for (const newName of trulyNewCandidates) {
        const ok = await maybePromptForImportAssignment(newName, existingGroups);
        if (!ok) break; // 用户取消则停止
    }
}

/**
 * 弹窗：建议把新预设归到某系列
 * @returns {Promise<boolean>} 是否继续处理后续候选
 */
async function maybePromptForImportAssignment(newName, existingGroups) {
    const parsed = parsePresetName(newName);
    const candidate = parsed.series;
    const assignment = findSeriesAssignment(candidate, existingGroups);

    // 自动识别后系列名 == 原名（无版本）→ 没有歧义，新建系列即可，不打扰
    if (!parsed.version && !assignment) {
        return true;
    }

    // 自动归到现有系列时，弹窗确认（用户最常见的诉求）
    // 没有匹配的现有系列 → 新建系列，不打扰
    if (!assignment) return true;

    _importPromptInflight = true;
    try {
        const ok = await confirmSafe(
            t('Grouping Import Detected Title'),
            `<div>${t('Grouping Import Detected Hint', {
                name: `<b>${escapeHtml(newName)}</b>`,
                series: `<b>${escapeHtml(assignment.displayName)}</b>`,
            })}</div>
            <div style="margin-top: 6px; font-size: 0.86em; opacity: 0.7;">
              ${escapeHtml(t('Grouping Manage Auto'))}: ${escapeHtml(parsed.series)}
              ${parsed.version ? ` · ${escapeHtml(parsed.version)}` : ''}
            </div>`
        );
        if (ok) {
            // 展示别名，但持久化稳定的自动分组名。
            const newOverrides = { ...(getSettings().groupingManualOverrides || {}) };
            newOverrides[newName] = assignment.canonicalName;
            updateSetting('groupingManualOverrides', newOverrides);
            toast.success(t('Grouping Override Set', { name: newName, series: assignment.displayName }));
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
            // AT-1 fix: stopPropagation 会阻止事件到达 list 的委托处理器，
            //   所以必须在此处直接更新批量选中状态和删除按钮
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                const pName = cb.getAttribute('data-preset-name');
                if (pName) {
                    if (cb.checked) _state.batchSelected.add(pName);
                    else _state.batchSelected.delete(pName);
                }
                // 更新删除按钮文本和可用性（不调用完整的 updateBatchUI 避免重建复选框）
                const delBtn = _root?.querySelector('#pas-batch-delete-btn');
                if (delBtn) {
                    const cnt = _state.batchSelected.size;
                    const sp = delBtn.querySelector('span');
                    if (sp) sp.textContent = t('Batch Delete Btn', { count: cnt });
                    if (cnt > 0) delBtn.removeAttribute('disabled');
                    else delBtn.setAttribute('disabled', 'disabled');
                }
            });
            header.insertBefore(cb, header.firstChild);
        }
    });
}

// =====================================================
// 工具函数
// =====================================================
// escapeAttr 已从 panel-summary.js（→ compatibility.js）导入
