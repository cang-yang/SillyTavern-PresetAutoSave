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
    on as onEvent, getEventType,
} from './compatibility.js';
import { saveNow, getCurrentTracking, resetLastSavedHash } from './auto-save.js';
import { showDiffPopup } from './diff-viewer.js';
import {
    parsePresetName,
    groupSnapshotsBySeries,
    groupNamesBySeries,
    clearParseCache,
} from './preset-grouping.js';

// =====================================================
// 状态
// =====================================================
let _popup = null;
let _root = null;
let _viewPopup = null;
let _logUnsubscribe = null;
let _logRefreshTimer = null;

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
    _state.snapshots = await getAllSnapshots();
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

    if (_state.viewMode === 'series' && curName) {
        const overrides = settings.groupingManualOverrides;
        const excluded = settings.groupingExcluded;
        const expandMode = settings.groupingDefaultExpand || 'current';
        const seriesMap = groupSnapshotsBySeries(_state.snapshots, { overrides, excluded });

        if (expandMode === 'all') {
            for (const k of seriesMap.keys()) _state.expandedSeries.add(k);
        } else if (expandMode === 'current') {
            // 找到当前预设所在系列
            for (const [k, info] of seriesMap.entries()) {
                if (info.versions.some(v => v.apiId === curApi && v.presetName === curName)) {
                    _state.expandedSeries.add(k);
                    break;
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
        </div>
        <div class="pas-panel-stats" id="pas-panel-stats"></div>
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
 */
function renderSeriesView(filtered) {
    const settings = getSettings();
    const seriesMap = groupSnapshotsBySeries(filtered, {
        overrides: settings.groupingManualOverrides,
        excluded: settings.groupingExcluded,
    });

    // 没有任何系列分组（全部都被 excluded）→ 兜底渲染 flat
    if (seriesMap.size === 0) return renderFlatView(filtered);

    // 系列按"最新时间"倒序
    const seriesList = Array.from(seriesMap.values()).sort((a, b) => b.latestTime - a.latestTime);
    return seriesList.map(renderSeriesGroup).join('');
}

/**
 * 扁平视图：保留旧的"按预设分组"行为（兼容、调试用）
 */
function renderFlatView(filtered) {
    const grouped = groupSnapshotsByPreset(filtered);
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
 * 系列卡（一级）
 *   - 标题左侧：箭头 + 图标 + 系列名 + 版本数
 *   - 标题右侧：快照总数 / 总大小 / 最新时间
 *   - 展开后渲染版本列表
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
        <div class="pas-series-header-main">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-series-chevron"></i>
            <i class="fa-solid fa-folder${isExpanded ? '-open' : ''} pas-series-icon"></i>
            <span class="pas-series-name" title="${escapeAttr(seriesKey)}">${escapeHtml(seriesKey)}</span>
            ${isCurrent ? `<span class="pas-tag pas-tag-current">${escapeHtml(t('Current Preset'))}</span>` : ''}
        </div>
        <div class="pas-series-header-meta">
            <span class="pas-series-versions" title="${escapeAttr(t('Grouping Series Header Versions', { count: info.versionCount }))}">
                <i class="fa-solid fa-code-branch"></i> ${info.versionCount}
            </span>
            <span class="pas-divider">·</span>
            <span class="pas-series-snapshots" title="${escapeAttr(t('Grouping Series Header Snapshots', { count: info.snapshotCount }))}">
                <i class="fa-solid fa-camera"></i> ${info.snapshotCount}
            </span>
            <span class="pas-divider">·</span>
            <span class="pas-series-size">${formatBytes(info.totalSize)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-series-latest">${formatTime(info.latestTime)}</span>
        </div>
    </div>
    <div class="pas-series-body"${isExpanded ? '' : ' hidden'}>
        ${info.versions.map(v => renderVersionGroup(v, seriesKey)).join('')}
    </div>
</div>`;
}

/**
 * 版本卡（二级）：每个 (apiId+presetName) 对应一个版本
 */
function renderVersionGroup(ver, seriesKey) {
    const versionKey = presetKey(ver.apiId, ver.presetName);
    const isExpanded = _state.expandedVersions.has(versionKey);
    const safeKey = escapeAttr(versionKey);
    const safeSeries = escapeAttr(seriesKey);
    const currentName = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    const isCurrent = (ver.presetName === currentName && ver.apiId === currentApi);

    const versionLabel = ver.version
        ? escapeHtml(ver.version)
        : `<span class="pas-version-untitled">${escapeHtml(t('Grouping Untitled Version'))}</span>`;
    const dupHtml = ver.duplicate
        ? `<span class="pas-version-duplicate" title="${escapeAttr(ver.duplicate)}">${escapeHtml(ver.duplicate)}</span>`
        : '';
    const manualHtml = ver.manualOverride
        ? `<span class="pas-tag pas-tag-manual-override" title="${escapeAttr(t('Grouping Manual Tag Title'))}">${escapeHtml(t('Grouping Manual Tag'))}</span>`
        : '';

    return `
<div class="pas-version-group ${isCurrent ? 'pas-version-current' : ''}" data-version-key="${safeKey}" data-series-key="${safeSeries}">
    <div class="pas-version-header" data-action="toggle-version">
        <div class="pas-version-header-main">
            <i class="fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} pas-version-chevron"></i>
            <i class="fa-solid fa-code-branch pas-version-icon"></i>
            <span class="pas-version-label">${versionLabel}</span>
            ${dupHtml}
            <span class="pas-version-rawname" title="${escapeAttr(ver.presetName)}">${escapeHtml(ver.presetName)}</span>
            ${isCurrent ? `<span class="pas-tag pas-tag-current">${escapeHtml(t('Current Preset'))}</span>` : ''}
            ${manualHtml}
            <span class="pas-version-api">${escapeHtml(ver.apiId)}</span>
        </div>
        <div class="pas-version-header-meta">
            <span class="pas-version-count">${ver.snapshotCount}</span>
            <span class="pas-divider">·</span>
            <span class="pas-version-size">${formatBytes(ver.totalSize)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-version-latest">${formatTime(ver.latestTime)}</span>
            <button class="pas-btn-action pas-btn-clear-preset" data-action="clear-preset" data-preset-key="${safeKey}" title="${escapeAttr(t('Clear Preset History'))}" type="button" aria-label="${escapeAttr(t('Clear Preset History'))}">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>
    <div class="pas-version-body"${isExpanded ? '' : ' hidden'}>
        ${ver.snapshots.map(renderCard).join('')}
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
    await clearPresetHistory(apiId, presetName);
    toast.success(t('Cleared'));
    await refreshData();
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

    // 一次只处理一个，避免连环弹窗
    for (const newName of candidates) {
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
        sel.addEventListener('change', () => {
            updateSetting(sel.getAttribute('data-setting'), sel.value);
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
// 状态更新
// =====================================================
async function updateStats() {
    if (!_root) return;
    const stats = await getStats();

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
    const badge = _root?.querySelector('#pas-list-badge');
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
