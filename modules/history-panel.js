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
    getSettings, updateSetting, resetSettings, batchUpdate,
} from './settings.js';
import {
    getAllSnapshots, deleteSnapshot, getSnapshotById,
    getStats, clearAll, trimOldSnapshots, cleanCorruptSnapshots,
    clearPresetHistory,
    exportAll, importAll,
    renameSnapshot, togglePinSnapshot,
    TRIGGER_LABEL_KEYS, formatBytes,
} from './history-store.js';
import {
    confirmSafe, toast, t,
    getCurrentApiId, getSelectedPresetName,
    savePresetSafe, selectPresetSafe,
    getAllPresetNames,
    deletePresetSafe,
    on as onEvent, off as offEvent, getEventType,
} from './compatibility.js';
import { saveNow, getCurrentTracking, resetLastSavedHash } from './auto-save.js';
import { showDiffPopup } from './diff-viewer.js';
import {
    parsePresetName,
    getSeriesInfo,
    groupSnapshotsBySeries,
    groupNamesBySeries,
    clearParseCache,
    pickRepresentativeVersion,
    normalizeSeriesKey,
} from './preset-grouping.js';
import {
    refreshTakeover,
    seedSnapshotsIfNeeded,
    forceReseedSnapshots,
    restoreAllFromArchive,
    listAllPresetsIncludingDetached,
} from './preset-takeover.js';
import { listArchivedPresets } from './archive-store.js';

// =====================================================
// 状态
// =====================================================
let _popup = null;
let _root = null;
let _viewPopup = null;
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
    };
}

function resetState() {
    _state = newState();
}

// =====================================================
// 初始化
// =====================================================
export async function initHistoryPanel() {
    logger.debug('History panel ready');
    // 启动导入识别（事件驱动，无轮询）
    startImportWatcher();
}

/**
 * 卸载（onDelete/onDisable 时调用）
 */
export function teardownHistoryPanel() {
    stopImportWatcher();
    if (_groupingManagerPopup) {
        try { _groupingManagerPopup.completeCancelled?.(); } catch (_) {}
        _groupingManagerPopup = null;
    }
    if (_firstScanWizardPopup) {
        try { _firstScanWizardPopup.completeCancelled?.(); } catch (_) {}
        _firstScanWizardPopup = null;
    }
}

// =====================================================
// 显示面板
// =====================================================
export async function showHistoryPanel() {
    if (_popup) return;

    try {
        const html = buildPanelHTML();
        const ctx = SillyTavern.getContext();

        _popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: false,
            cancelButton: t('Close'),
        });

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

        await loadData();
        bindEvents();
        renderActiveTab();

        await promise;
    } catch (e) {
        logger.error('Failed to show panel:', e);
        toast.error(t('Restore Failed', { message: e?.message || String(e) }));
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
        // 关闭可能还开着的子弹窗
        if (_viewPopup) {
            try { _viewPopup.completeCancelled?.(); } catch (_) {}
            _viewPopup = null;
        }
        if (_groupingManagerPopup) {
            try { _groupingManagerPopup.completeCancelled?.(); } catch (_) {}
            _groupingManagerPopup = null;
        }
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
        _state.expandedVersions.add(presetKey(curApi, curName));
    }

    if (_state.viewMode === 'series') {
        const overrides = settings.groupingManualOverrides;
        const excluded = settings.groupingExcluded;
        const expandMode = settings.groupingDefaultExpand || 'current';
        const seriesMap = groupSnapshotsBySeries(_state.snapshots, { overrides, excluded });

        if (expandMode === 'all') {
            for (const k of seriesMap.keys()) _state.expandedSeries.add(k);
        } else if (expandMode === 'current') {
            // ⭐ 改进：current 模式不只展开当前系列，
            //   还展开所有"多版本系列"（让用户能立刻看到分组结果，而不是空荡荡的列表）
            for (const [k, info] of seriesMap.entries()) {
                const isCurrent = curName && info.versions.some(v => v.apiId === curApi && v.presetName === curName);
                if (isCurrent || (info.versions && info.versions.length > 1)) {
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
    await updateStats();
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
        showGroupingManager();
    });

    // 重新扫描分组（重置 firstScanDone 后再次弹向导）
    $('.pas-btn-rescan-grouping')?.addEventListener('click', async () => {
        try {
            // 清空分组解析缓存（万一用户改了正则等）
            clearParseCache();
            // 重置 firstScanDone 让向导能再次弹出
            updateSetting('groupingFirstScanDone', false);
            await showGroupingFirstScanWizard();
            await refreshData();
        } catch (e) {
            logger.error('Rescan grouping failed:', e);
            toast.error(String(e?.message || e));
        }
    });

    // 展开/收起全部
    $('.pas-btn-expand-all')?.addEventListener('click', () => {
        const filtered = applyFiltersAndSearch(_state.snapshots);
        if (_state.viewMode === 'series') {
            const settings = getSettings();
            const seriesMap = groupSnapshotsBySeries(filtered, {
                overrides: settings.groupingManualOverrides,
                excluded: settings.groupingExcluded,
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

    // 列表事件委托
    const list = $('.pas-snapshot-list');
    if (list) list.addEventListener('click', handleListClick);

    // diff 选择条
    $('.pas-btn-start-diff')?.addEventListener('click', onStartDiff);
    $('.pas-btn-clear-diff')?.addEventListener('click', () => onClearDiff());
    updateDiffBar();

    // ----- 日志 Tab 事件 -----
    const logSearch = $('.pas-log-search');
    if (logSearch) {
        let timer = null;
        logSearch.addEventListener('input', (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                _state.log.search = e.target.value.trim();
                renderLogTab();
            }, 200);
        });
    }
    $$('.pas-log-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.pas-log-filter').forEach(b => b.classList.remove('pas-filter-active'));
            btn.classList.add('pas-filter-active');
            _state.log.level = btn.getAttribute('data-level');
            renderLogTab();
        });
    });
    $('.pas-log-autoscroll-input')?.addEventListener('change', (e) => {
        _state.log.autoScroll = !!e.target.checked;
    });
    $('.pas-btn-log-clear')?.addEventListener('click', onLogClear);
    $('.pas-btn-log-copy')?.addEventListener('click', onLogCopy);
    $('.pas-btn-log-export')?.addEventListener('click', onLogExport);

    // 底部按钮
    $('.pas-btn-cleanup')?.addEventListener('click', onCleanup);
    $('.pas-btn-export')?.addEventListener('click', onExport);
    $('.pas-btn-import')?.addEventListener('click', onImport);
    $('.pas-btn-snap')?.addEventListener('click', onSnapshotNow);
    $('.pas-btn-purge')?.addEventListener('click', onPurgeCorrupt);

    // 订阅日志（增量更新，节流）
    _logUnsubscribe = logger.subscribe(() => {
        if (_state.tab !== 'logs') {
            updateLogBadge();
            return;
        }
        if (_logRefreshTimer) return;
        _logRefreshTimer = setTimeout(() => {
            _logRefreshTimer = null;
            renderLogTab();
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
                updateStats();
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
    if (_state.tab === 'list') renderListTab();
    else if (_state.tab === 'logs') renderLogTab();
    else if (_state.tab === 'settings') renderSettingsTab();
    updateStats();
    updateLogBadge();
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

    const filtered = applyFiltersAndSearch(_state.snapshots);
    if (filtered.length === 0) {
        list.innerHTML = renderEmptyState();
        updateBadge(0);
        return;
    }

    // ⚡ 大数据量优化：>5000 条时分批 render，避免主线程长任务
    const html = (_state.viewMode === 'series')
        ? renderSeriesView(filtered)
        : renderFlatView(filtered);
    list.innerHTML = html;
    updateBadge(filtered.length);
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
 */
function renderSeriesView(filtered) {
    const settings = getSettings();
    const currentApi = getCurrentApiId() || 'openai';

    // 1) 历史快照：按当前 API 过滤（snapshot.apiId 必须 === currentApi）
    const filteredByApi = (filtered || []).filter(s => s && s.apiId === currentApi);

    const seriesMap = groupSnapshotsBySeries(filteredByApi, {
        overrides: settings.groupingManualOverrides,
        excluded: settings.groupingExcluded,
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
        const excluded = settings.groupingExcluded || {};

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
            if (excluded[presetName]) continue;
            const info = getSeriesInfo(presetName, overrides, excluded);
            if (info.excluded) continue;
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
    if (_archivedCache && _archivedCache.length > 0) {
        try {
            const overrides = settings.groupingManualOverrides || {};
            const excluded = settings.groupingExcluded || {};
            for (const arch of _archivedCache) {
                if (arch.apiId && arch.apiId !== currentApi) continue;
                const presetName = arch.presetName;
                if (!presetName || excluded[presetName]) continue;
                const info = getSeriesInfo(presetName, overrides, excluded);
                if (info.excluded) continue;
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
    return seriesList.map(renderSeriesGroup).join('');
}

/**
 * 扁平视图：保留旧的"按预设分组"行为（兼容、调试用）
 */
function renderFlatView(filtered) {
    // ⚡ 严格按当前 mainApi 过滤，避免显示 KoboldAI / Llama 等其他 API 预设
    const currentApi = getCurrentApiId() || 'openai';
    const filteredByApi = (filtered || []).filter(s => s && s.apiId === currentApi);
    const grouped = groupSnapshotsByPreset(filteredByApi);
    const presetKeys = Object.keys(grouped).sort((a, b) => {
        const at = grouped[a][0]?.timestamp || 0;
        const bt = grouped[b][0]?.timestamp || 0;
        return bt - at;
    });
    return presetKeys.map(k => renderPresetGroup(k, grouped[k])).join('');
}

function presetKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

function parsePresetKey(key) {
    const idx = key.indexOf('::');
    if (idx < 0) return { apiId: '', presetName: key };
    return { apiId: key.slice(0, idx), presetName: key.slice(idx + 2) };
}

function groupSnapshotsByPreset(snapshots) {
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

function renderPresetGroup(key, snapshots) {
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
            <span class="pas-divider">·</span>
            <span class="pas-preset-size">${formatBytes(totalSize)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-preset-latest">${formatTime(latestTime)}</span>
            <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>
    <div class="pas-preset-body"${isExpanded ? '' : ' hidden'}>
        ${snapshots.map(renderCard).join('')}
    </div>
</div>`;
}

/**
 * 系列卡（一级）—— 重构：上下双排布局，避免标题与元信息互相挤压
 *   第 1 排（标题排）：箭头 + 图标 + 系列名（占满剩余空间） + 「当前」徽章 + 版本数胶囊
 *   第 2 排（元信息排，缩进对齐）：快照数 / 大小 / 最新时间
 */
function renderSeriesGroup(info) {
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
            ${isCurrent ? `<span class="pas-tag pas-tag-current-series" title="${escapeAttr(t('Current Preset'))}"><i class="fa-solid fa-circle-dot"></i></span>` : ''}
        </div>
        <div class="pas-series-header-row pas-series-header-row-meta">
            <span class="pas-series-snapshots" title="${escapeAttr(t('Grouping Series Header Snapshots', { count: info.snapshotCount }))}">
                <i class="fa-solid fa-camera"></i> ${info.snapshotCount}
            </span>
            <span class="pas-divider">·</span>
            <span class="pas-series-size">${formatBytes(info.totalSize)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-series-latest">${info.latestTime ? formatTime(info.latestTime) : '—'}</span>
        </div>
    </div>
    <div class="pas-series-body"${isExpanded ? '' : ' hidden'}>
        ${info.versions.map(v => renderVersionGroup(v, seriesKey, info.versions)).join('')}
    </div>
</div>`;
}

/**
 * 版本卡（二级）—— 重构 v2：以"完整原始预设名"为主标题
 *
 * 布局（上下三排）：
 *   第 1 排（标题排）：箭头 + 图标 + **完整预设名**（占满主区） + 版本号小胶囊（如有）
 *   第 2 排（标签排）：当前 / 默认 / 手动归类 / 归档 / 重名警告 等所有标签徽章
 *   第 3 排（元信息 + 操作排）：快照数 / 大小 / 最新时间 ······· [应用] [设默认] [清空]
 *
 * 这样无论预设名多长、标签多少都不会与右侧操作按钮重叠。
 */
function renderVersionGroup(ver, seriesKey, allVersions) {
    const versionKey = presetKey(ver.apiId, ver.presetName);
    const isExpanded = _state.expandedVersions.has(versionKey);
    const safeKey = escapeAttr(versionKey);
    const safeSeries = escapeAttr(seriesKey);
    const safePresetName = escapeAttr(ver.presetName);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = (ver.presetName === currentName && ver.apiId === currentApi);
    const isEmpty = (ver.snapshotCount || 0) === 0;

    const settings = getSettings();
    const seriesDefaults = settings.seriesDefaultApply || {};
    const isDefaultApply = seriesDefaults[seriesKey] === ver.presetName;

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
        isDefaultApply ? `<span class="pas-tag pas-tag-default-apply" title="${escapeAttr(t('Default Apply Tag Title'))}"><i class="fa-solid fa-thumbtack"></i> ${escapeHtml(t('Default Apply Tag'))}</span>` : '',
        ver.manualOverride ? `<span class="pas-tag pas-tag-manual-override" title="${escapeAttr(t('Grouping Manual Tag Title'))}">${escapeHtml(t('Grouping Manual Tag'))}</span>` : '',
        ver.archived ? `<span class="pas-tag pas-tag-archived" title="${escapeAttr(t('Archived Version Title'))}"><i class="fa-solid fa-box-archive"></i> ${escapeHtml(t('Archived Version'))}</span>` : '',
        isEmpty ? `<span class="pas-tag pas-tag-empty" title="${escapeAttr(t('No Snapshots Yet Title'))}">${escapeHtml(t('No Snapshots Yet'))}</span>` : '',
    ].filter(Boolean).join('');
    const tagsRowHtml = tagsHtml
        ? `<div class="pas-version-header-row pas-version-header-row-tags">${tagsHtml}</div>`
        : '';

    // 设为默认按钮
    const defaultBtnTitle = isDefaultApply ? t('Unset Default Version') : t('Set As Default Version');
    const defaultBtnCls = isDefaultApply ? 'pas-btn-default-on' : 'pas-btn-default-off';
    const defaultBtn = `<button class="pas-btn-action pas-btn-set-default ${defaultBtnCls}" data-action="set-default" data-preset-name="${safePresetName}" data-series-key="${safeSeries}" title="${escapeAttr(defaultBtnTitle)}" type="button" aria-label="${escapeAttr(defaultBtnTitle)}">
        <i class="fa-solid fa-thumbtack"></i>
    </button>`;

    // 应用版本按钮（已归档版本不可应用）
    const applyBtn = ver.archived
        ? ''
        : `<button class="pas-btn-action pas-btn-apply-version" data-action="apply-version" data-preset-name="${safePresetName}" title="${escapeAttr(t('Apply This Version'))}" type="button" aria-label="${escapeAttr(t('Apply This Version'))}">
            <i class="fa-solid fa-circle-check"></i>
        </button>`;

    return `
<div class="pas-version-group ${isCurrent ? 'pas-version-current' : ''} ${isDefaultApply ? 'pas-version-default-apply' : ''} ${isEmpty ? 'pas-version-empty' : ''} ${ver.archived ? 'pas-version-archived' : ''}" data-version-key="${safeKey}" data-series-key="${safeSeries}" data-preset-name="${safePresetName}">
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
                <span class="pas-divider">·</span>
                <span class="pas-version-size" title="${escapeAttr(t('Total Size'))}">${formatBytes(ver.totalSize)}</span>
                <span class="pas-divider">·</span>
                <span class="pas-version-latest" title="${escapeAttr(t('Latest Time'))}">${ver.latestTime ? formatTime(ver.latestTime) : '—'}</span>
            </span>
            <span class="pas-version-meta-actions">
                ${applyBtn}
                ${defaultBtn}
                <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </span>
        </div>
    </div>
    <div class="pas-version-body"${isExpanded ? '' : ' hidden'}>
        ${ver.snapshots.length > 0 ? ver.snapshots.map(renderCard).join('') : `<div class="pas-version-empty-hint">${escapeHtml(t('No Snapshots Yet Hint'))}</div>`}
    </div>
</div>`;
}

function applyFiltersAndSearch(snapshots) {
    let result = [...snapshots];

    if (_state.filter === 'current') {
        const name = getSelectedPresetName();
        const api = getCurrentApiId();
        // series 视图下的"当前预设"= 当前预设所在的整个"系列"
        // flat 视图下保持原行为：精确到 (apiId, presetName)
        if (_state.viewMode === 'series' && name) {
            const settings = getSettings();
            const overrides = settings.groupingManualOverrides;
            const excluded = settings.groupingExcluded;
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

function startOfToday() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function startOfWeek() {
    const d = new Date();
    const dow = d.getDay() || 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - (dow - 1) * 86400000;
}

function renderCard(s) {
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
            <span class="pas-divider">·</span>
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
        <button class="pas-btn-action pas-btn-delete" data-id="${id}" data-action="delete" ${deleteAttr} type="button" aria-label="${escapeAttr(t('Delete'))}">
            <i class="fa-solid fa-trash"></i>
        </button>
    </div>
</div>`;
}

/**
 * 字段名词典：把内部 key 翻译成人话
 * 没在词典里的会回落到 key 原文（小写蛇形）
 */
const FIELD_LABEL_KEYS = Object.freeze({
    temperature: 'Field temperature',
    top_p: 'Field top_p',
    top_k: 'Field top_k',
    min_p: 'Field min_p',
    top_a: 'Field top_a',
    tfs: 'Field tfs',
    typical_p: 'Field typical_p',
    frequency_penalty: 'Field frequency_penalty',
    presence_penalty: 'Field presence_penalty',
    repetition_penalty: 'Field repetition_penalty',
    reasoning_effort: 'Field reasoning_effort',
    show_thoughts: 'Field show_thoughts',
    max_context_unlocked: 'Field max_context_unlocked',
    openai_max_tokens: 'Field openai_max_tokens',
    openai_max_context: 'Field openai_max_context',
    openai_model: 'Field openai_model',
    stream_response: 'Field stream_response',
    streaming: 'Field streaming',
    function_calling: 'Field function_calling',
    request_images: 'Field request_images',
    continue_prefill: 'Field continue_prefill',
    continue_postfix: 'Field continue_postfix',
    squash_system_messages: 'Field squash_system_messages',
    wrap_in_quotes: 'Field wrap_in_quotes',
    names_behavior: 'Field names_behavior',
    impersonation_prompt: 'Field impersonation_prompt',
    new_chat_prompt: 'Field new_chat_prompt',
    new_group_chat_prompt: 'Field new_group_chat_prompt',
    new_example_chat_prompt: 'Field new_example_chat_prompt',
    continue_nudge_prompt: 'Field continue_nudge_prompt',
    bias_preset_selected: 'Field bias_preset_selected',
    wi_format: 'Field wi_format',
    scenario_format: 'Field scenario_format',
    personality_format: 'Field personality_format',
    group_nudge_prompt: 'Field group_nudge_prompt',
    seed: 'Field seed',
    n: 'Field n',
    chat_completion_source: 'Field chat_completion_source',
    proxy_password: 'Field proxy_password',
    custom_url: 'Field custom_url',
    custom_model: 'Field custom_model',
    assistant_prefill: 'Field assistant_prefill',
    assistant_impersonation: 'Field assistant_impersonation',
    user_name_prefix: 'Field user_name_prefix',
    char_name_prefix: 'Field char_name_prefix',
    image_inlining: 'Field image_inlining',
    inline_image_quality: 'Field inline_image_quality',
    enable_web_search: 'Field enable_web_search',
    send_if_empty: 'Field send_if_empty',
    show_external_models: 'Field show_external_models',
    use_system_prompt: 'Field use_system_prompt',
    stream_fade_in: 'Field stream_fade_in',
    smooth_streaming: 'Field smooth_streaming',
    streaming_fps: 'Field streaming_fps',
    reasoning_max_additions: 'Field reasoning_max_additions',
    reasoning_auto_parse: 'Field reasoning_auto_parse',
    reasoning_auto_expand: 'Field reasoning_auto_expand',
    reasoning_show_hidden: 'Field reasoning_show_hidden',
    reasoning_add_to_prompts: 'Field reasoning_add_to_prompts',
    bypass_status_check: 'Field bypass_status_check',
});

/**
 * 提示词字段名词典（diff 内部用）
 */
const PROMPT_FIELD_LABEL_KEYS = Object.freeze({
    name: 'Prompt Field name',
    content: 'Prompt Field content',
    role: 'Prompt Field role',
    system_prompt: 'Prompt Field system_prompt',
    marker: 'Prompt Field marker',
    injection_position: 'Prompt Field injection_position',
    injection_depth: 'Prompt Field injection_depth',
    forbid_overrides: 'Prompt Field forbid_overrides',
});

/**
 * 字段标签翻译缓存（模块级，跨多次 renderSummary 复用）
 * 渲染 100 张卡片时可减少 500+ 次 t() 调用
 */
const _fieldLabelCache = new Map();
const _promptFieldLabelCache = new Map();

/**
 * 把字段 key 翻成显示名（i18n 优先，回落到原 key）
 */
function fieldLabel(key) {
    if (_fieldLabelCache.has(key)) return _fieldLabelCache.get(key);
    const i18nKey = FIELD_LABEL_KEYS[key];
    let label = key;
    if (i18nKey) {
        const tr = t(i18nKey);
        if (tr && tr !== i18nKey) label = tr;
    }
    _fieldLabelCache.set(key, label);
    return label;
}

function promptFieldLabel(key) {
    if (_promptFieldLabelCache.has(key)) return _promptFieldLabelCache.get(key);
    const i18nKey = PROMPT_FIELD_LABEL_KEYS[key];
    let label = key;
    if (i18nKey) {
        const tr = t(i18nKey);
        if (tr && tr !== i18nKey) label = tr;
    }
    _promptFieldLabelCache.set(key, label);
    return label;
}

/**
 * 渲染修改摘要——按"每条改动一行"的方式展开
 *
 * compact: 卡片紧凑模式（限制行数 + 折叠）
 * 完整模式（false）用在查看 JSON 弹窗里。
 */
function renderSummary(summary, opts = {}) {
    const compact = opts.compact !== false; // 默认紧凑
    if (!summary || typeof summary !== 'object') {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-info"></i>
            <span>${escapeHtml(t('Summary Unknown'))}</span>
        </div>`;
    }
    if (summary.isFirst) {
        return `<div class="pas-card-summary pas-summary-first">
            <i class="fa-solid fa-flag"></i>
            <span>${escapeHtml(t('Summary Initial'))}</span>
        </div>`;
    }

    // 旧格式（带 tags 的）兼容性处理
    if (Array.isArray(summary.tags) && !Array.isArray(summary.sections)) {
        return renderLegacySummary(summary);
    }

    const sections = Array.isArray(summary.sections) ? summary.sections : [];
    if (sections.length === 0) {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-dot"></i>
            <span>${escapeHtml(t('Summary Minor'))}</span>
        </div>`;
    }

    // 把所有 sections 拍平成"行"
    const lines = [];
    for (const sec of sections) {
        const segs = renderSection(sec);
        for (const s of segs) lines.push(s);
    }

    if (lines.length === 0) {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-dot"></i>
            <span>${escapeHtml(t('Summary Minor'))}</span>
        </div>`;
    }

    // 紧凑模式：默认显示前 4 行 + "more"
    const COMPACT_LIMIT = 4;
    const visible = compact ? lines.slice(0, COMPACT_LIMIT) : lines;
    const hidden = compact ? lines.length - visible.length : 0;

    const linesHtml = visible.map(l => `<div class="pas-summary-line pas-summary-line-${escapeAttr(l.cls)}">
        <i class="fa-solid ${escapeAttr(l.icon)} pas-summary-line-icon"></i>
        <span class="pas-summary-line-text">${l.html}</span>
    </div>`).join('');

    const moreHtml = hidden > 0
        ? `<div class="pas-summary-more-line">${escapeHtml(t('Summary More', { count: hidden }))}</div>`
        : '';

    return `<div class="pas-card-summary">${linesHtml}${moreHtml}</div>`;
}

/**
 * 把一个 section 渲染成一组行
 * 每行 = { cls, icon, html }
 */
function renderSection(sec) {
    const out = [];
    if (!sec || !sec.kind) return out;

    switch (sec.kind) {
        case 'prompt-add': {
            // 单条："新增『XXX』"；多条聚合："新增 N 个条目（XXX, YYY...）"
            for (const item of sec.items) {
                out.push({
                    cls: 'add',
                    icon: 'fa-circle-plus',
                    html: t('Summary Line PromptAdd', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-del': {
            for (const item of sec.items) {
                out.push({
                    cls: 'del',
                    icon: 'fa-circle-minus',
                    html: t('Summary Line PromptDel', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-edit': {
            for (const item of sec.items) {
                const fieldsDesc = describePromptFieldDiffs(item.fields || []);
                out.push({
                    cls: 'edit',
                    icon: 'fa-pen-to-square',
                    html: t('Summary Line PromptEdit', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                        fields: fieldsDesc,
                    }),
                });
            }
            break;
        }
        case 'prompt-toggle-on': {
            for (const item of sec.items) {
                out.push({
                    cls: 'toggle-on',
                    icon: 'fa-toggle-on',
                    html: t('Summary Line PromptOn', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-toggle-off': {
            for (const item of sec.items) {
                out.push({
                    cls: 'toggle-off',
                    icon: 'fa-toggle-off',
                    html: t('Summary Line PromptOff', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-reorder': {
            const cnt = sec.items?.[0]?.count || 0;
            out.push({
                cls: 'reorder',
                icon: 'fa-arrows-up-down',
                html: t('Summary Line Reorder', { count: cnt }),
            });
            break;
        }
        case 'field': {
            for (const item of sec.items) {
                out.push({
                    cls: 'field',
                    icon: 'fa-sliders',
                    html: describeFieldChange(item),
                });
            }
            break;
        }
    }
    return out;
}

/**
 * 把 prompt 内部 fields diff 转成短句
 * 例：name: 旧 → 新 / content: 1024→1100 字符 / role: user→system
 */
function describePromptFieldDiffs(fields) {
    if (!fields || fields.length === 0) return '';
    const parts = fields.slice(0, 3).map(f => {
        const label = promptFieldLabel(f.key);
        if (f.isContent) {
            return t('Prompt Field Content Change', {
                label,
                from: f.fromLen,
                to: f.toLen,
            });
        }
        return `<span class="pas-summary-fkey">${escapeHtml(label)}</span>: <code>${escapeHtml(formatSummaryValue(f.from))}</code> → <code>${escapeHtml(formatSummaryValue(f.to))}</code>`;
    });
    if (fields.length > 3) {
        parts.push(`<span class="pas-summary-fmore">+${fields.length - 3}</span>`);
    }
    return parts.join('<span class="pas-summary-sep">,</span> ');
}

/**
 * 描述一个标量字段变更
 * - scalar: 字段名: 旧 → 新
 * - array-length: 字段名: 长度 N → M
 * - object: 字段名: (对象更新)
 */
function describeFieldChange(item) {
    const label = fieldLabel(item.key);
    if (item.kind === 'array-length') {
        return t('Summary Line ArrayLen', {
            label: `<span class="pas-summary-fkey">${escapeHtml(label)}</span>`,
            from: item.from,
            to: item.to,
        });
    }
    if (item.kind === 'object') {
        return t('Summary Line ObjectChange', {
            label: `<span class="pas-summary-fkey">${escapeHtml(label)}</span>`,
        });
    }
    // scalar
    const fromStr = formatSummaryValue(item.from);
    const toStr = formatSummaryValue(item.to);
    return `<span class="pas-summary-fkey">${escapeHtml(label)}</span>: <code class="pas-summary-from">${escapeHtml(fromStr)}</code> <span class="pas-summary-arrow">→</span> <code class="pas-summary-to">${escapeHtml(toStr)}</code>`;
}

/**
 * 旧格式（带 tags / details）的兼容渲染——保留向下兼容，避免历史快照打不开
 */
function renderLegacySummary(summary) {
    const tagHtml = (summary.tags || []).map(tag => {
        const labelKey = `Summary Tag ${tag.label}`;
        const text = t(labelKey, { count: tag.count ?? '' });
        return `<span class="pas-summary-tag pas-summary-tag-${escapeAttr(tag.type)}" title="${escapeAttr(text)}">${escapeHtml(text)}${tag.count != null && tag.count > 0 ? ` <b>${tag.count}</b>` : ''}</span>`;
    }).join('');

    let detailsHtml = '';
    if (summary.details && summary.details.length > 0) {
        const items = summary.details.slice(0, 4).map(d => {
            const fromStr = formatSummaryValue(d.from);
            const toStr = formatSummaryValue(d.to);
            return `<span class="pas-summary-detail"><span class="pas-summary-key">${escapeHtml(d.key)}</span> <span class="pas-summary-arrow">${escapeHtml(fromStr)} → ${escapeHtml(toStr)}</span></span>`;
        }).join('');
        const more = summary.details.length > 4
            ? `<span class="pas-summary-more">+${summary.details.length - 4}</span>`
            : '';
        detailsHtml = `<div class="pas-summary-details">${items}${more}</div>`;
    }

    if (!tagHtml && !detailsHtml) {
        return `<div class="pas-card-summary pas-summary-empty">${escapeHtml(t('Summary Minor'))}</div>`;
    }
    return `<div class="pas-card-summary">
        ${tagHtml ? `<div class="pas-summary-tags">${tagHtml}</div>` : ''}
        ${detailsHtml}
    </div>`;
}

function formatSummaryValue(v) {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '∞';
        return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }
    if (typeof v === 'string') {
        if (v === '') return '∅';
        return v.length > 24 ? v.slice(0, 22) + '…' : v;
    }
    return String(v);
}

function renderEmptyState() {
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
// 卡片操作 / 分组操作
// =====================================================
async function handleListClick(e) {
    const clearBtn = e.target.closest('.pas-btn-clear-preset');
    const setDefaultBtn = e.target.closest('.pas-btn-set-default');
    const applyVersionBtn = e.target.closest('.pas-btn-apply-version');
    const seriesHeader = e.target.closest('.pas-series-header');
    const versionHeader = e.target.closest('.pas-version-header');
    const presetHeader = e.target.closest('.pas-preset-header');

    // 1) 清除某预设/版本的全部历史按钮
    if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = clearBtn.getAttribute('data-preset-key');
        await onClearPreset(key);
        return;
    }

    // 1.1) "设为默认应用版本"按钮（图钉）
    if (setDefaultBtn) {
        e.preventDefault();
        e.stopPropagation();
        const presetName = setDefaultBtn.getAttribute('data-preset-name');
        const seriesKey = setDefaultBtn.getAttribute('data-series-key');
        if (presetName && seriesKey) {
            await onToggleSeriesDefault(seriesKey, presetName);
        }
        return;
    }

    // 1.2) "应用此版本"按钮（圆勾）
    if (applyVersionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const presetName = applyVersionBtn.getAttribute('data-preset-name');
        if (presetName) {
            await onApplyVersionDirect(presetName);
        }
        return;
    }

    // ⚡ 性能优化：折叠/展开操作改成原地切换 DOM class，
    // 避免每次点击都重建整个面板的 innerHTML（数千个 DOM 节点）
    // 仅在确实需要"惰性渲染"内容时（首次展开 + body 还没生成）才走 renderListTab()

    // 2) 系列折叠（series 模式）
    if (seriesHeader) {
        const group = seriesHeader.closest('.pas-series-group');
        const key = group?.getAttribute('data-series-key');
        if (!key) return;
        const wasExpanded = _state.expandedSeries.has(key);
        if (wasExpanded) _state.expandedSeries.delete(key);
        else _state.expandedSeries.add(key);
        // 优先做原地切换：body 已渲染过则直接切类即可
        const body = group.querySelector(':scope > .pas-series-body');
        if (body) {
            toggleGroupVisualState(group, body, !wasExpanded, '.pas-series-chevron', '.pas-series-icon');
            return;
        }
        renderListTab();
        return;
    }

    // 3) 版本折叠（series 模式下的二级）
    if (versionHeader) {
        const group = versionHeader.closest('.pas-version-group');
        const key = group?.getAttribute('data-version-key');
        if (!key) return;
        const wasExpanded = _state.expandedVersions.has(key);
        if (wasExpanded) _state.expandedVersions.delete(key);
        else _state.expandedVersions.add(key);
        const body = group.querySelector(':scope > .pas-version-body');
        if (body) {
            toggleGroupVisualState(group, body, !wasExpanded, '.pas-version-chevron');
            return;
        }
        renderListTab();
        return;
    }

    // 4) 预设折叠（flat 模式下的旧逻辑）
    if (presetHeader) {
        const group = presetHeader.closest('.pas-preset-group');
        const key = group?.getAttribute('data-preset-key');
        if (!key) return;
        const wasExpanded = _state.expandedPresets.has(key);
        if (wasExpanded) _state.expandedPresets.delete(key);
        else _state.expandedPresets.add(key);
        const body = group.querySelector(':scope > .pas-preset-body');
        if (body) {
            toggleGroupVisualState(group, body, !wasExpanded, '.pas-preset-chevron');
            return;
        }
        renderListTab();
        return;
    }

    // 5) 卡片操作按钮（按 data-action 分发）
    const btn = e.target.closest('.pas-btn-action');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    if (!id) return;

    switch (action) {
        case 'restore': await onRestore(id); break;
        case 'view':    await onView(id);    break;
        case 'delete':  await onDelete(id);  break;
        case 'rename':  await onRename(id);  break;
        case 'pin':     await onTogglePin(id); break;
        case 'diff-a':  onSetDiff(id, 'a');  break;
        case 'diff-b':  onSetDiff(id, 'b');  break;
        default:
            // 兼容旧 class 路由
            if (btn.classList.contains('pas-btn-restore')) await onRestore(id);
            else if (btn.classList.contains('pas-btn-view')) await onView(id);
            else if (btn.classList.contains('pas-btn-delete')) await onDelete(id);
    }
}

/**
 * ⚡ 性能优化：原地切换分组的展开状态（不重建 innerHTML）
 *
 * 仅切换：
 *   - body 的 hidden（CSS [hidden] 已支持）
 *   - chevron 的图标 class（fa-chevron-right ↔ fa-chevron-down）
 *   - 可选 folder 图标（fa-folder ↔ fa-folder-open）
 *
 * 大幅降低 DOM 重建成本：
 *   - 一个有 50 个系列 / 200 个版本的面板，原本每次点击会重建数千 DOM 节点
 *   - 改成原地切换后，开销 ≈ 0
 */
function toggleGroupVisualState(group, body, expanded, chevronSel, iconSel = null) {
    if (body) body.hidden = !expanded;
    if (chevronSel) {
        const chev = group.querySelector(chevronSel);
        if (chev) {
            chev.classList.toggle('fa-chevron-down', expanded);
            chev.classList.toggle('fa-chevron-right', !expanded);
        }
    }
    if (iconSel) {
        const ic = group.querySelector(iconSel);
        if (ic) {
            ic.classList.toggle('fa-folder-open', expanded);
            ic.classList.toggle('fa-folder', !expanded);
        }
    }
}

// =====================================================
// 重命名 / 锁定 / Diff 选择
// =====================================================
async function onRename(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    const ctx = SillyTavern.getContext();
    const current = (snapshot.name || '').trim();

    let result;
    try {
        if (ctx.POPUP_TYPE && typeof ctx.POPUP_TYPE.INPUT !== 'undefined') {
            const popup = new ctx.Popup(
                `<div class="pas-rename-popup">
                    <div><strong>${escapeHtml(t('Rename Snapshot'))}</strong></div>
                    <div class="pas-rename-popup-hint">${escapeHtml(t('Rename Hint'))}</div>
                </div>`,
                ctx.POPUP_TYPE.INPUT,
                current,
                {
                    okButton: t('Confirm'),
                    cancelButton: t('Cancel'),
                    rows: 1,
                }
            );
            result = await popup.show();
        } else {
            result = window.prompt(t('Rename Snapshot'), current);
        }
    } catch (e) {
        logger.warn('Rename input failed:', e);
        return;
    }

    if (result === null || result === undefined || result === false) return; // 用户取消

    const newName = String(result).trim().slice(0, 80);
    const ok = await renameSnapshot(snapshotId, newName);
    if (ok) {
        toast.success(newName ? t('Rename Done') : t('Rename Cleared'));
        await refreshData();
    } else {
        toast.error(t('Snapshot Not Found'));
    }
}

async function onTogglePin(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));
    const next = !snapshot.pinned;
    const result = await togglePinSnapshot(snapshotId, next);
    if (result === null) return toast.error(t('Snapshot Not Found'));
    toast.success(result ? t('Pinned Done') : t('Unpinned Done'));
    await refreshData();
}

/**
 * 设置 / 取消 diff 对比的 A 或 B 槽
 * 同一 snapshot 重复点同一槽 = 取消
 * 同一 snapshot 已被另一槽选中时 = 交换槽
 */
function onSetDiff(snapshotId, slot /* 'a' | 'b' */) {
    if (slot !== 'a' && slot !== 'b') return;
    const sel = _state.diffSel;

    if (sel[slot] === snapshotId) {
        sel[slot] = null;
    } else if (sel.a === snapshotId && slot === 'b') {
        sel.a = null;
        sel.b = snapshotId;
    } else if (sel.b === snapshotId && slot === 'a') {
        sel.b = null;
        sel.a = snapshotId;
    } else {
        sel[slot] = snapshotId;
    }

    updateDiffBar();
    renderListTab();
}

function onClearDiff() {
    _state.diffSel.a = null;
    _state.diffSel.b = null;
    updateDiffBar();
    renderListTab();
}

async function onStartDiff() {
    const { a, b } = _state.diffSel;
    if (!a || !b) {
        toast.warning(t('Diff Need Two'));
        return;
    }
    const [snapA, snapB] = await Promise.all([
        getSnapshotById(a),
        getSnapshotById(b),
    ]);
    if (!snapA || !snapB) {
        toast.error(t('Snapshot Not Found'));
        return;
    }
    await showDiffPopup(snapA, snapB);
}

/**
 * 同步顶部 diff 选择条的显示文本与按钮可用性
 */
function updateDiffBar() {
    if (!_root) return;
    const slotA = _root.querySelector('#pas-diff-slot-a');
    const slotB = _root.querySelector('#pas-diff-slot-b');
    const startBtn = _root.querySelector('.pas-btn-start-diff');
    const clearBtn = _root.querySelector('.pas-btn-clear-diff');

    const formatSlot = (slot, slotEl) => {
        if (!slotEl) return;
        const id = _state.diffSel[slot];
        const text = slotEl.querySelector('.pas-diff-bar-slot-text');
        if (!id) {
            slotEl.classList.remove('pas-diff-slot-set');
            if (text) text.textContent = t('Diff Slot Empty');
            return;
        }
        const snap = _state.snapshots.find(s => s.id === id);
        const label = snap
            ? (snap.name?.trim() || formatTime(snap.timestamp))
            : t('Diff Slot Empty');
        slotEl.classList.add('pas-diff-slot-set');
        if (text) text.textContent = label;
    };
    formatSlot('a', slotA);
    formatSlot('b', slotB);

    const ready = !!_state.diffSel.a && !!_state.diffSel.b;
    if (startBtn) {
        if (ready) startBtn.removeAttribute('disabled');
        else startBtn.setAttribute('disabled', 'disabled');
    }
    if (clearBtn) {
        const hasAny = !!_state.diffSel.a || !!_state.diffSel.b;
        if (hasAny) clearBtn.removeAttribute('disabled');
        else clearBtn.setAttribute('disabled', 'disabled');
    }
}

async function onRestore(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    // 防御：拒绝恢复明显损坏的快照（避免清空预设）
    const preset = snapshot.preset;
    if (!preset || typeof preset !== 'object' || Object.keys(preset).length < 5) {
        const fieldCount = preset && typeof preset === 'object' ? Object.keys(preset).length : 0;
        logger.error(
            `Refusing to restore corrupt snapshot id=${snapshotId} fields=${fieldCount}`
        );
        toast.error(t('Restore Failed', {
            message: `Snapshot is corrupted (only ${fieldCount} fields). Refusing to restore to avoid clearing your preset.`,
        }));
        return;
    }

    const time = formatTime(snapshot.timestamp);
    const ok = await confirmSafe(
        t('Confirm Restore'),
        `<div>${t('Restore Snapshot Hint', { name: escapeHtml(snapshot.presetName) })}</div>
         <div style="margin: 8px 0; padding: 8px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; font-family: monospace;">${escapeHtml(time)}</div>
         <div style="color: var(--white50a, #999); font-size: 0.9em;">${escapeHtml(t('Restore Irreversible'))}</div>`
    );
    if (!ok) return;

    try {
        await savePresetSafe(snapshot.presetName, snapshot.preset, {
            skipUpdate: false, apiId: snapshot.apiId,
        });
        selectPresetSafe(snapshot.presetName);
        toast.success(t('Restored To Time', { time }));
        await refreshData();
    } catch (e) {
        logger.error('Restore failed:', e);
        toast.error(t('Restore Failed', { message: e?.message || String(e) }));
    }
}

async function onView(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    const json = JSON.stringify(snapshot.preset, null, 2);
    const time = formatTime(snapshot.timestamp);
    const triggerLabel = t(TRIGGER_LABEL_KEYS[snapshot.trigger] || 'Trigger Auto');
    const summaryHtml = renderSummary(snapshot.summary, { compact: false });
    const ctx = SillyTavern.getContext();

    const html = `
<div class="pas-view-popup">
    <div class="pas-view-header">
        <div class="pas-view-title">
            <i class="fa-solid fa-eye"></i>
            <h4>${escapeHtml(snapshot.presetName)}</h4>
        </div>
        <div class="pas-view-meta">
            <span><i class="fa-regular fa-clock"></i> ${escapeHtml(time)}</span>
            <span class="pas-view-meta-divider">·</span>
            <span class="pas-tag pas-tag-${escapeAttr(snapshot.trigger)}">${escapeHtml(triggerLabel)}</span>
            <span class="pas-view-meta-divider">·</span>
            <span><i class="fa-solid fa-database"></i> ${formatBytes(snapshot.size || 0)}</span>
        </div>
    </div>
    <div class="pas-view-summary">${summaryHtml}</div>
    <pre class="pas-view-json"><code>${escapeHtml(json)}</code></pre>
    <div class="pas-view-actions">
        <button class="menu_button pas-view-copy-btn" type="button">
            <i class="fa-solid fa-copy"></i> ${escapeHtml(t('Copy JSON'))}
        </button>
    </div>
</div>`;

    _viewPopup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        wide: true, large: true,
        allowVerticalScrolling: true,
        okButton: false, cancelButton: t('Close'),
    });

    const showPromise = _viewPopup.show();

    // 使用 requestAnimationFrame 比 setTimeout(100) 更稳定的时序——
    // Popup 一进 DOM 就能命中
    const tryBindCopy = () => {
        const btn = document.querySelector('.pas-view-popup .pas-view-copy-btn');
        if (btn && !btn.dataset.pasBound) {
            btn.dataset.pasBound = '1';
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(json)
                    .then(() => toast.success(t('Copied')))
                    .catch(() => toast.error(t('Copy Failed')));
            });
            return true;
        }
        return false;
    };
    // 双保险：rAF + 短延迟
    requestAnimationFrame(() => {
        if (!tryBindCopy()) setTimeout(tryBindCopy, 50);
    });

    showPromise.finally(() => { _viewPopup = null; });
}

async function onDelete(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return;

    const time = formatTime(snapshot.timestamp);
    const ok = await confirmSafe(
        t('Delete Snapshot'),
        t('Delete Snapshot Hint', { name: escapeHtml(snapshot.presetName), time: escapeHtml(time) })
    );
    if (!ok) return;

    await deleteSnapshot(snapshotId);
    toast.success(t('Deleted'));
    await refreshData();
}

async function onClearPreset(key) {
    const { apiId, presetName } = parsePresetKey(key);
    if (!apiId || !presetName) return;
    const ok = await confirmSafe(
        t('Clear Preset Confirm'),
        t('Clear Preset Hint', { name: escapeHtml(presetName) })
    );
    if (!ok) return;
    // 1) 清空快照历史
    await clearPresetHistory(apiId, presetName);
    // 2) 检查 ST 里是否还存在同名预设 → 如有，再问是否一并删除
    //    （这是用户报"0KB 数据删不掉，因为面板里一直显示"的根因）
    let stillExists = false;
    try {
        const all = (getAllPresetNames() || []).map(o => (o && (o.name || o.preset_name)) || o);
        stillExists = all.some(n => String(n) === String(presetName));
    } catch (_) {}
    if (stillExists) {
        const removeFromST = await confirmSafe(
            t('Clear Preset Also Remove From ST Confirm'),
            t('Clear Preset Also Remove From ST Hint', { name: escapeHtml(presetName) })
        );
        if (removeFromST) {
            try {
                const delOk = await deletePresetSafe(presetName, apiId);
                if (delOk) {
                    toast.success(t('Cleared'));
                } else {
                    toast.warning(t('Clear Preset ST Delete Failed'));
                }
            } catch (e) {
                toast.warning(t('Clear Preset ST Delete Failed'));
                logger.warn('delete preset from ST failed:', e);
            }
        } else {
            toast.success(t('Cleared'));
        }
    } else {
        toast.success(t('Cleared'));
    }
    await refreshData();
}

/**
 * 切换"系列默认应用版本"
 *   - 如果当前 presetName 已经是该 seriesKey 的默认 → 取消（删除映射）
 *   - 否则设为该系列的默认版本
 *   - 切换后立即调用 refreshTakeover() 让原生下拉重新生效
 */
async function onToggleSeriesDefault(seriesKey, presetName) {
    if (!seriesKey || !presetName) return;
    const settings = getSettings();
    const map = { ...(settings.seriesDefaultApply || {}) };
    const wasDefault = map[seriesKey] === presetName;

    if (wasDefault) {
        delete map[seriesKey];
    } else {
        map[seriesKey] = presetName;
    }

    updateSetting('seriesDefaultApply', map);
    // ⚡ 关键：不再触发 refreshTakeover()！
    //   default 是"用户点代表项时跳到哪个版本"的运行时决策，
    //   不应该改变当前 select 的代表项，否则 DOM 重写会让 ST 误触发预设切换。

    if (wasDefault) {
        toast.info(t('Default Apply Cleared', { series: seriesKey }));
    } else {
        toast.success(t('Default Apply Set', { series: seriesKey, name: presetName }));
    }

    // 仅重渲列表 Tab，避免抢焦点
    renderListTab();
}

/**
 * 直接应用某个版本（面板里的"应用"按钮）
 *   - 调用 ST 的 selectPresetSafe，让 ST 走完整的预设切换流程
 *   - 这条路径绕过接管的"代表 option 重定向"，明确指向某个具体预设
 *
 * 注意：DOM 接管模式下，被合并的版本对应的 option 已被摘除。
 *   ST 的 findPreset() 用的是内部 preset 列表（不是 DOM），所以查询能成功。
 *   但 selectPreset() 写回 select.value 时，如果 option 不在 DOM 里会失败 —
 *   所以要先用 refreshTakeover 触发一次接管刷新，让"目标版本"成为代表。
 */
async function onApplyVersionDirect(presetName) {
    if (!presetName) return;
    try {
        // 切换前先把"未保存修改"自动备份（享受 switchGuard 的能力）
        await saveNow().catch(() => {});
    } catch (_) {}

    let ok = false;
    try {
        ok = selectPresetSafe(presetName);
    } catch (e) {
        logger.warn('selectPresetSafe threw:', e);
        ok = false;
    }

    // 如果失败，可能是接管模式下 option 被摘除：
    //   把目标设为该系列的"默认应用"，再触发刷新让它成为代表，然后重试
    if (!ok) {
        try {
            const settings = getSettings();
            // 推断目标系列
            const info = parsePresetName(presetName);
            const seriesKey = info.series || presetName;
            const map = { ...(settings.seriesDefaultApply || {}) };
            map[seriesKey] = presetName;
            updateSetting('seriesDefaultApply', map);
            // 等接管刷新落地（防抖窗口 220ms + 接管 + 浏览器渲染）
            await new Promise(r => setTimeout(r, 380));
            ok = selectPresetSafe(presetName);
        } catch (e) {
            logger.warn('apply-version retry failed:', e);
        }
    }

    if (ok) {
        toast.success(t('Applied Version', { name: presetName }));
    } else {
        toast.error(t('Apply Version Failed', { name: presetName }));
    }
}

// =====================================================
// 分组管理弹窗（手动覆盖 + 排除）
// =====================================================
let _groupingManagerPopup = null;

/**
 * 打开"管理分组"弹窗：列出所有出现过的预设名，
 * 让用户手动指定每个预设属于哪个系列（或标记为"不分组"）。
 *
 * 数据来源：
 *   1. 当前所有快照的 (apiId, presetName)
 *   2. SillyTavern 当前已加载的预设名（getAllPresetNames）
 */
async function showGroupingManager() {
    if (_groupingManagerPopup) return;

    // 收集所有候选名（快照中出现过 + 当前预设管理器列表）
    const fromSnapshots = new Set(_state.snapshots.map(s => s.presetName).filter(Boolean));
    const allNames = new Set(fromSnapshots);
    try {
        const names = getAllPresetNames();
        if (Array.isArray(names)) for (const n of names) if (n) allNames.add(n);
    } catch (_) { /* 忽略：getAllPresetNames 可能在切换 API 期间失败 */ }

    if (allNames.size === 0) {
        toast.info(t('Grouping Empty Series'));
        return;
    }

    const settings = getSettings();
    const overrides = { ...(settings.groupingManualOverrides || {}) };
    const excluded = { ...(settings.groupingExcluded || {}) };

    // 按"自动识别系列"分组列表，方便用户快速调整
    const sortedNames = Array.from(allNames).sort((a, b) => a.localeCompare(b));
    const grouped = groupNamesBySeries(sortedNames, overrides, excluded);

    const ctx = SillyTavern.getContext();
    const html = buildGroupingManagerHTML(grouped, sortedNames, overrides, excluded);

    _groupingManagerPopup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: t('Grouping Manage Save'),
        cancelButton: t('Cancel'),
    });

    const promise = _groupingManagerPopup.show();
    setTimeout(() => bindGroupingManagerEvents(), 50);

    const result = await promise;
    _groupingManagerPopup = null;

    if (result) {
        // 用户点了"保存"
        const root = document.querySelector('.pas-grouping-manager');
        if (!root) return;
        const newOverrides = {};
        const newExcluded = {};
        root.querySelectorAll('.pas-grouping-row').forEach(row => {
            const presetName = row.getAttribute('data-preset-name');
            if (!presetName) return;
            const ex = row.querySelector('.pas-grouping-exclude');
            if (ex && ex.checked) {
                newExcluded[presetName] = true;
                return;
            }
            const input = row.querySelector('.pas-grouping-series-input');
            const val = (input?.value || '').trim();
            if (val) newOverrides[presetName] = val;
        });
        batchUpdate({
            groupingManualOverrides: newOverrides,
            groupingExcluded: newExcluded,
        });
        toast.success(t('Grouping Manage Saved'));
        await refreshData();
    }
}

function buildGroupingManagerHTML(grouped, allNames, overrides, excluded) {
    const rowsHtml = allNames.map(name => {
        const parsed = parsePresetName(name);
        const autoSeries = parsed.series;
        const overrideVal = overrides[name] || '';
        const isExcluded = !!excluded[name];
        const safeName = escapeAttr(name);
        const seriesValue = overrideVal;
        return `
<div class="pas-grouping-row" data-preset-name="${safeName}">
    <div class="pas-grouping-row-name">
        <span class="pas-grouping-original" title="${safeName}">${escapeHtml(name)}</span>
        ${parsed.version ? `<span class="pas-grouping-version">${escapeHtml(parsed.version)}</span>` : ''}
    </div>
    <div class="pas-grouping-row-auto" title="${escapeAttr(t('Grouping Manage Auto'))}">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
        <span>${escapeHtml(autoSeries)}</span>
    </div>
    <div class="pas-grouping-row-input">
        <input type="text" class="pas-grouping-series-input text_pole"
            value="${escapeAttr(seriesValue)}"
            placeholder="${escapeAttr(t('Grouping Manage Manual Placeholder'))}"
            ${isExcluded ? 'disabled' : ''} />
    </div>
    <label class="pas-grouping-row-exclude">
        <input type="checkbox" class="pas-grouping-exclude" ${isExcluded ? 'checked' : ''}>
        <span>${escapeHtml(t('Grouping Manage Excluded Label'))}</span>
    </label>
</div>`;
    }).join('');

    return `
<div class="pas-grouping-manager">
    <h3 style="margin: 0 0 6px 0;">
        <i class="fa-solid fa-folder-tree"></i> ${escapeHtml(t('Grouping Manage Title Full'))}
    </h3>
    <div class="pas-grouping-hint">${escapeHtml(t('Grouping Manage Hint'))}</div>
    <div class="pas-grouping-list">${rowsHtml}</div>
</div>`;
}

function bindGroupingManagerEvents() {
    const root = document.querySelector('.pas-grouping-manager');
    if (!root) return;
    // 勾选"不分组"时禁用 input
    root.querySelectorAll('.pas-grouping-row').forEach(row => {
        const ex = row.querySelector('.pas-grouping-exclude');
        const input = row.querySelector('.pas-grouping-series-input');
        if (!ex || !input) return;
        ex.addEventListener('change', () => {
            input.disabled = ex.checked;
            if (ex.checked) input.value = '';
        });
    });
}

// =====================================================
// 首次扫描向导
// =====================================================
let _firstScanWizardPopup = null;

/**
 * 弹出"首次整理预设分组"向导
 * 调用方：当扩展加载，且 settings.groupingFirstScanDone === false 且 enabled === true 时
 */
export async function showGroupingFirstScanWizard(opts = {}) {
    if (_firstScanWizardPopup) return;
    const ctx = (() => {
        try { return SillyTavern.getContext(); } catch (_) { return null; }
    })();
    if (!ctx) return;

    let names = [];
    try {
        const list = getAllPresetNames();
        if (Array.isArray(list)) names = list.filter(Boolean);
    } catch (_) {}

    if (names.length < 2) {
        // 不足以分组：直接标记完成不再打扰
        updateSetting('groupingFirstScanDone', true);
        return;
    }

    const groups = groupNamesBySeries(names);
    // 只显示"含 ≥2 个版本"的系列作为预览（说明确实有重复）
    const significantGroups = groups.filter(g => g.items.length >= 2);
    const previewHtml = significantGroups.slice(0, 12).map(g => `
<div class="pas-firstscan-group">
    <div class="pas-firstscan-group-name">
        <i class="fa-solid fa-folder"></i>
        <strong>${escapeHtml(g.series)}</strong>
        <span class="pas-firstscan-group-count">×${g.items.length}</span>
    </div>
    <div class="pas-firstscan-group-items">
        ${g.items.map(it => `<span class="pas-firstscan-item">${escapeHtml(it.presetName)}${it.version ? ` <em>(${escapeHtml(it.version)})</em>` : ''}</span>`).join('')}
    </div>
</div>`).join('');

    const moreCount = significantGroups.length > 12 ? significantGroups.length - 12 : 0;

    const html = `
<div class="pas-firstscan">
    <h3 style="margin: 0 0 8px 0;">
        <i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(t('Grouping First Scan Title'))}
    </h3>
    <p class="pas-firstscan-hint">${escapeHtml(t('Grouping First Scan Hint', { count: names.length }))}</p>
    <div class="pas-firstscan-summary">
        ${escapeHtml(t('Grouping First Scan Sample', { series: groups.length }))}
    </div>
    <div class="pas-firstscan-preview">
        ${previewHtml || `<p style="opacity: 0.6;">${escapeHtml(t('Grouping Empty Series'))}</p>`}
        ${moreCount > 0 ? `<div class="pas-firstscan-more">+${moreCount}</div>` : ''}
    </div>
</div>`;

    _firstScanWizardPopup = new ctx.Popup(html, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: t('Grouping First Scan Confirm'),
        cancelButton: t('Grouping First Scan Skip'),
    });

    let result = false;
    try {
        result = await _firstScanWizardPopup.show();
    } finally {
        _firstScanWizardPopup = null;
    }

    if (result) {
        // 用户确认：开启分组并标记完成
        batchUpdate({
            groupingEnabled: true,
            groupingFirstScanDone: true,
        });
        toast.success(t('Grouping First Scan Done', {
            series: groups.length,
            versions: names.length,
        }));
    } else {
        // 用户跳过：仍然标记完成（不要每次启动都打扰）
        updateSetting('groupingFirstScanDone', true);
    }
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
 *   - 如果用户为该预设手动设置过归属（出现在 overrides/excluded），不再提示
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
 */
function collectKnownPresetNames() {
    const set = new Set();
    try {
        const arr = getAllPresetNames();
        if (Array.isArray(arr)) for (const n of arr) if (n) set.add(n);
    } catch (_) {}
    return set;
}

async function importWatchTick() {
    const settings = getSettings();
    if (!settings.groupingEnabled || !settings.groupingPromptOnImport) return;
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

    // 已被用户标记的不再提示
    const overrides = settings.groupingManualOverrides || {};
    const excluded = settings.groupingExcluded || {};
    const candidates = added.filter(n =>
        !Object.hasOwn(overrides, n) &&
        !Object.hasOwn(excluded, n)
    );
    if (candidates.length === 0) return;

    // 收集现有系列（不含 added 自己）
    const existingNames = Array.from(cur).filter(n => !candidates.includes(n));
    const existingGroups = groupNamesBySeries(existingNames, overrides, excluded);
    const existingSeries = existingGroups.map(g => g.series);

    // ⚡ P3 修复：过滤掉与已存在预设同属一个系列的候选
    //   版本切换（takeover）时，被隐藏的 option 可能被临时恢复到 select 中，
    //   导致同系列版本被误判为"新导入"。通过 normalizeSeriesKey 比较排除。
    const existingNormKeys = new Set(existingSeries.map(s => normalizeSeriesKey(s)));
    const trulyNewCandidates = candidates.filter(n => {
        const info = getSeriesInfo(n, overrides, excluded);
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

// =====================================================
// 日志 Tab 渲染
// =====================================================
function renderLogTab() {
    const view = _root?.querySelector('#pas-log-view');
    if (!view) return;

    const filter = {};
    if (_state.log.level && _state.log.level !== 'all') {
        filter.level = _state.log.level;
    }
    if (_state.log.search) filter.search = _state.log.search;

    const entries = logger.getLogs(filter);
    updateLogBadge(entries.length);

    if (entries.length === 0) {
        view.innerHTML = `
            <div class="pas-empty">
                <i class="fa-solid fa-bug-slash pas-empty-icon"></i>
                <p class="pas-empty-text">${escapeHtml(t('No logs'))}</p>
            </div>`;
        return;
    }

    const html = entries.map(renderLogEntry).join('');
    view.innerHTML = html;

    if (_state.log.autoScroll) {
        view.scrollTop = view.scrollHeight;
    }
}

function renderLogEntry(entry) {
    const time = formatLogTime(entry.ts);
    const level = (entry.level || 'info').toLowerCase();
    return `
<div class="pas-log-row pas-log-row-${escapeAttr(level)}">
    <span class="pas-log-time">${escapeHtml(time)}</span>
    <span class="pas-log-level pas-log-level-${escapeAttr(level)}">${escapeHtml(level.toUpperCase())}</span>
    <span class="pas-log-msg">${escapeHtml(entry.message || '')}</span>
</div>`;
}

function updateLogBadge(count = null) {
    const badge = _root?.querySelector('#pas-log-badge');
    if (!badge) return;
    const c = count !== null ? count : logger.getLogCount();
    badge.textContent = String(c);
}

async function onLogClear() {
    const ok = await confirmSafe(t('Clear Logs Confirm'), t('Clear Logs Hint'));
    if (!ok) return;
    logger.clearLogs();
    renderLogTab();
}

async function onLogCopy() {
    const filter = {};
    if (_state.log.level && _state.log.level !== 'all') filter.level = _state.log.level;
    if (_state.log.search) filter.search = _state.log.search;
    const text = logger.exportText(filter);
    try {
        await navigator.clipboard.writeText(text);
        toast.success(t('Copied'));
    } catch (_) {
        toast.error(t('Copy Failed'));
    }
}

function onLogExport() {
    try {
        const filter = {};
        if (_state.log.level && _state.log.level !== 'all') filter.level = _state.log.level;
        if (_state.log.search) filter.search = _state.log.search;
        const text = logger.exportText(filter);
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `pas-logs-${ts}.log`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success(t('Logs Exported'));
    } catch (e) {
        logger.error('Export logs failed:', e);
        toast.error(t('Export Failed'));
    }
}

// =====================================================
// 设置 Tab 渲染
// =====================================================
function renderSettingsTab() {
    const container = _root?.querySelector('[data-content="settings"]');
    if (!container) return;
    const s = getSettings();

    container.innerHTML = `
<div class="pas-settings">
    ${group(t('Auto Save Group'), [
        toggle('enabled', t('Enable Auto Save'), t('Master switch'), s.enabled),
        number('debounceMs', t('Debounce Delay'), t('Debounce Delay Desc'), s.debounceMs, 100, 10000, 100, 'ms'),
        number('textInputDebounce', t('Text Input Debounce'), t('Text Input Debounce Desc'), s.textInputDebounce, 100, 10000, 100, 'ms'),
        toggle('sliderReleaseSave', t('Slider Release Save'), t('Slider Release Save Desc'), s.sliderReleaseSave),
        toggle('skipUnchangedSave', t('Skip Unchanged Save'), t('Skip Unchanged Save Desc'), s.skipUnchangedSave),
    ])}

    ${group(t('History Group'), [
        number('maxHistoryPerPreset', t('Max History Per Preset'), t('Max History Per Preset Desc'), s.maxHistoryPerPreset, 5, 500, 5, t('Records')),
        number('mergeWindowSec', t('Merge Window'), t('Merge Window Desc'), s.mergeWindowSec, 0, 600, 5, 's'),
        number('cleanupSizeMB', t('Cleanup Size'), t('Cleanup Size Desc'), s.cleanupSizeMB, 10, 1000, 10, 'MB'),
    ])}

    ${group(t('Protection Group'), [
        toggle('enableSwitchGuard', t('Switch Guard'), t('Switch Guard Desc'), s.enableSwitchGuard),
    ])}

    ${group(t('Appearance Group'), [
        toggle('showStatusIndicator', t('Status Indicator'), t('Status Indicator Desc'), s.showStatusIndicator),
        toggle('notifyOnSave', t('Notify On Save'), t('Notify On Save Desc'), s.notifyOnSave),
    ])}

    ${group(t('Grouping Group'), [
        toggle('groupingEnabled', t('Grouping Enabled'), t('Grouping Enabled Desc'), s.groupingEnabled),
        toggle('groupingPromptOnImport', t('Grouping Prompt On Import'), t('Grouping Prompt On Import Desc'), s.groupingPromptOnImport),
        select('groupingDefaultExpand', t('Grouping Default Expand'), t('Grouping Default Expand Desc'), s.groupingDefaultExpand, [
            { value: 'current', label: t('Grouping Default Expand Current') },
            { value: 'all',     label: t('Grouping Default Expand All') },
            { value: 'none',    label: t('Grouping Default Expand None') },
        ]),
    ])}

    ${group(t('Takeover Group'), [
        toggle('takeoverEnabled', t('Takeover Enabled'), t('Takeover Enabled Desc'), s.takeoverEnabled),
        select('takeoverMode', t('Takeover Mode'), t('Takeover Mode Desc'), s.takeoverMode, [
            { value: 'dom',  label: t('Takeover Mode DOM') },
            { value: 'data', label: t('Takeover Mode Data') },
        ]),
        select('takeoverDefaultStrategy', t('Takeover Default Strategy'), t('Takeover Default Strategy Desc'), s.takeoverDefaultStrategy, [
            { value: 'latest', label: t('Takeover Strategy Latest') },
            { value: 'manual', label: t('Takeover Strategy Manual') },
        ]),
        toggle('autoSeedOnTakeover', t('Auto Seed Enabled'), t('Auto Seed Enabled Desc'), s.autoSeedOnTakeover),
        action('reseed', t('Reseed Snapshots'), t('Reseed Snapshots Desc'), 'fa-magic-wand-sparkles'),
    ])}

    ${group(t('Advanced Group'), [
        toggle('debugMode', t('Debug Mode'), t('Debug Mode Desc'), s.debugMode),
        toggle('fallbackPolling', t('Fallback Polling'), t('Fallback Polling Desc'), s.fallbackPolling),
    ])}

    <div class="pas-settings-actions">
        <button class="menu_button pas-btn-reset" type="button">
            <i class="fa-solid fa-rotate-right"></i> ${escapeHtml(t('Reset Defaults'))}
        </button>
        <button class="menu_button caution pas-btn-clear-all" type="button">
            <i class="fa-solid fa-trash"></i> ${escapeHtml(t('Clear All'))}
        </button>
    </div>
</div>`;

    bindSettingsEvents(container);
}

function group(title, items) {
    return `
<div class="pas-settings-group">
    <div class="pas-settings-group-title">${escapeHtml(title)}</div>
    <div class="pas-settings-group-items">${items.join('')}</div>
</div>`;
}

function toggle(key, label, desc, value) {
    return `
<div class="pas-setting-item">
    <div class="pas-setting-info">
        <div class="pas-setting-label">${escapeHtml(label)}</div>
        <div class="pas-setting-desc">${escapeHtml(desc)}</div>
    </div>
    <label class="pas-switch">
        <input type="checkbox" data-setting="${escapeAttr(key)}" ${value ? 'checked' : ''}>
        <span class="pas-switch-slider"></span>
    </label>
</div>`;
}

function number(key, label, desc, value, min, max, step, unit = '') {
    return `
<div class="pas-setting-item">
    <div class="pas-setting-info">
        <div class="pas-setting-label">${escapeHtml(label)}</div>
        <div class="pas-setting-desc">${escapeHtml(desc)}</div>
    </div>
    <div class="pas-setting-input">
        <input type="number" class="text_pole pas-number-input"
            data-setting="${escapeAttr(key)}"
            value="${value}" min="${min}" max="${max}" step="${step}">
        ${unit ? `<span class="pas-setting-unit">${escapeHtml(unit)}</span>` : ''}
    </div>
</div>`;
}

function select(key, label, desc, value, options) {
    const optsHtml = (options || []).map(o => `
        <option value="${escapeAttr(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>
    `).join('');
    return `
<div class="pas-setting-item">
    <div class="pas-setting-info">
        <div class="pas-setting-label">${escapeHtml(label)}</div>
        <div class="pas-setting-desc">${escapeHtml(desc)}</div>
    </div>
    <div class="pas-setting-input">
        <select class="text_pole pas-select-input" data-setting="${escapeAttr(key)}" data-setting-type="select">
            ${optsHtml}
        </select>
    </div>
</div>`;
}

function action(actionKey, label, desc, icon = 'fa-bolt') {
    return `
<div class="pas-setting-item pas-setting-action-row">
    <div class="pas-setting-info">
        <div class="pas-setting-label">${escapeHtml(label)}</div>
        <div class="pas-setting-desc">${escapeHtml(desc)}</div>
    </div>
    <div class="pas-setting-input">
        <button class="menu_button pas-setting-action-btn" data-action="${escapeAttr(actionKey)}" type="button">
            <i class="fa-solid ${escapeAttr(icon)}"></i>
        </button>
    </div>
</div>`;
}

function bindSettingsEvents(container) {
    // 复选框
    container.querySelectorAll('input[type="checkbox"][data-setting]').forEach(input => {
        input.addEventListener('change', () => {
            updateSetting(input.getAttribute('data-setting'), input.checked);
        });
    });

    // 数字输入
    container.querySelectorAll('input[type="number"][data-setting]').forEach(input => {
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const key = input.getAttribute('data-setting');
                const val = parseInt(input.value, 10);
                if (Number.isFinite(val)) updateSetting(key, val);
            }, 500);
        });
        // 失焦时回填校验后的实际值（避免用户以为超出范围的值已生效）
        input.addEventListener('blur', () => {
            clearTimeout(timer);
            const key = input.getAttribute('data-setting');
            const val = parseInt(input.value, 10);
            if (Number.isFinite(val)) {
                updateSetting(key, val);
                input.value = String(getSettings()[key]);
            }
        });
    });

    // 下拉
    container.querySelectorAll('select[data-setting]').forEach(sel => {
        sel.addEventListener('change', async () => {
            const key = sel.getAttribute('data-setting');
            const newValue = sel.value;

            // 特殊：切换到"数据接管"模式需要明确确认
            if (key === 'takeoverMode' && newValue === 'data' && !getSettings().takeoverDataConfirmed) {
                const ok = await confirmSafe(
                    t('Takeover Data Confirm Title'),
                    t('Takeover Data Confirm Hint')
                );
                if (!ok) {
                    sel.value = getSettings().takeoverMode || 'dom';
                    return;
                }
                updateSetting('takeoverDataConfirmed', true);
            }

            updateSetting(key, newValue);
        });
    });

    // 重置按钮
    container.querySelector('.pas-btn-reset')?.addEventListener('click', async () => {
        const ok = await confirmSafe(t('Reset Settings Confirm'), t('Reset Settings Hint'));
        if (!ok) return;
        resetSettings();
        toast.success(t('Reset Settings Done'));
        renderSettingsTab();
    });

    // ⭐ 立即扫描全部预设建立快照（接管模式下用户随时能让"未修改的预设"出现在面板里）
    container.querySelector('.pas-setting-action-btn[data-action="reseed"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        const oldHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            const result = await forceReseedSnapshots();
            if (result && typeof result.added === 'number') {
                if (result.added > 0) {
                    toast.success(t('Reseed Done', { added: result.added, skipped: result.skipped, total: result.total }));
                } else {
                    toast.info(t('Reseed All Already Done', { total: result.total || 0 }));
                }
                // 立即刷新面板（保持当前 tab 是 list）
                if (_state.tab === 'list') await refreshData();
            } else {
                toast.warning(t('Reseed Skipped'));
            }
        } catch (e2) {
            toast.error(t('Reseed Failed', { message: e2?.message || String(e2) }));
        } finally {
            btn.disabled = false;
            btn.innerHTML = oldHtml;
        }
    });

    // 清空所有
    container.querySelector('.pas-btn-clear-all')?.addEventListener('click', async () => {
        const stats = await getStats();
        const ok = await confirmSafe(
            t('Clear All Confirm'),
            `<div>${t('Clear All Hint', { count: stats.snapshotCount })}</div>
             <div style="margin-top: 8px; color: var(--white50a, #999);">${escapeHtml(t('Clear All Warning'))}</div>`
        );
        if (!ok) return;
        await clearAll();
        toast.success(t('Cleared All'));
        await refreshData();
    });
}

// =====================================================
// 底部操作
// =====================================================
async function onCleanup() {
    const stats = await getStats();
    const settings = getSettings();
    const ok = await confirmSafe(
        t('Cleanup Confirm'),
        `<div>${t('Cleanup Description', { count: stats.snapshotCount, size: stats.totalSizeFormatted })}</div>
         <div style="margin: 12px 0;">${t('Cleanup Action Hint', { max: settings.maxHistoryPerPreset })}</div>`
    );
    if (!ok) return;

    const removed = await trimOldSnapshots();
    toast.success(t('Cleanup Done', { count: removed }));
    await refreshData();
}

async function onExport() {
    try {
        const data = await exportAll();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `preset-auto-save-backup-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success(t('Export Done'));
    } catch (e) {
        logger.error('Export failed:', e);
        toast.error(t('Export Failed'));
    }
}

async function onImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';

    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) {
            input.remove();
            return;
        }

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            const ok = await confirmSafe(
                t('Import Backup'),
                `<div>${escapeHtml(t('Import Hint'))}</div>
                 <div style="margin-top: 8px; color: var(--white50a, #999);">${escapeHtml(t('Import Detail'))}</div>`
            );
            if (!ok) return;

            const count = await importAll(data, 'merge');
            toast.success(t('Import Done', { count }));
            await refreshData();
        } catch (e) {
            logger.error('Import failed:', e);
            toast.error(t('Import Failed', { message: e?.message || String(e) }));
        } finally {
            input.remove();
        }
    });

    document.body.appendChild(input);
    input.click();
}

/**
 * 清理所有损坏的快照（preset 为空对象或字段过少）
 * 这是修复 v0.x 版本"openai 永远返回空对象" bug 留下的脏数据的工具
 */
async function onPurgeCorrupt() {
    const ok = await confirmSafe(
        t('Purge Corrupt Confirm'),
        `<div>${escapeHtml(t('Purge Corrupt Hint'))}</div>
         <div style="margin-top: 8px; color: var(--white50a, #999);">${escapeHtml(t('Purge Corrupt Detail'))}</div>`
    );
    if (!ok) return;

    try {
        const result = await cleanCorruptSnapshots();
        toast.success(t('Purge Corrupt Done', {
            cleaned: result.cleaned,
            scanned: result.scanned,
        }));
        logger.info(`[Purge] cleaned ${result.cleaned} of ${result.scanned} snapshots`);
        await refreshData();
    } catch (e) {
        logger.error('Purge corrupt failed:', e);
        toast.error(t('Purge Corrupt Failed', { message: e?.message || String(e) }));
    }
}

/**
 * 立即手动快照当前预设（也作为"卡住状态"的紧急逃生口）
 */
async function onSnapshotNow() {
    try {
        // 重置 lastSavedHash，保证强制写入一份新快照（即使内容看起来"没变"）
        resetLastSavedHash();
        const snap = await saveNow();
        const tracking = getCurrentTracking();
        if (snap) {
            toast.success(t('Snapshot Saved', { name: snap.presetName }));
            logger.info(`[Manual snapshot] [${snap.apiId}] ${snap.presetName} hash=${snap.hash}`);
        } else {
            // saveNow 内部已 _setStatus，且会在合并窗口/未变化时返回 null
            toast.info(t('Snapshot Skipped'));
            logger.info(`[Manual snapshot] skipped tracking=${JSON.stringify(tracking)}`);
        }
        await refreshData();
    } catch (e) {
        logger.error('Manual snapshot failed:', e);
        toast.error(t('Snapshot Failed', { message: e?.message || String(e) }));
    }
}

// =====================================================
// 状态更新（防御性：_root 在 await 期间可能已被关闭）
// =====================================================
async function updateStats() {
    if (!_root) return;
    let stats;
    try {
        stats = await getStats();
    } catch (e) {
        logger.debug('updateStats getStats failed:', e);
        return;
    }
    // ⚡ 关键：await 之后必须再次检查 _root，
    //    用户在 stats 读取期间关闭面板会导致 _root === null → querySelector 抛 TypeError
    if (!_root || !_root.isConnected) return;

    const headerStats = _root.querySelector('#pas-panel-stats');
    if (headerStats) {
        headerStats.textContent = t('Header Stats', {
            count: stats.snapshotCount,
            size: stats.totalSizeFormatted,
        });
    }

    const footerStats = _root.querySelector('#pas-footer-stats');
    if (footerStats) {
        footerStats.innerHTML = t('Footer Stats', {
            count: stats.snapshotCount,
            size: stats.totalSizeFormatted,
            presets: stats.presetCount,
        });
    }
}

function updateBadge(count) {
    if (!_root || !_root.isConnected) return;
    const badge = _root.querySelector('#pas-list-badge');
    if (badge) badge.textContent = String(count);
}

// =====================================================
// 工具函数
// =====================================================
function formatTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatLogTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttr(s) {
    return escapeHtml(s);
}
