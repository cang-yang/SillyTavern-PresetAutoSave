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
    getSettings, updateSetting, resetSettings,
} from './settings.js';
import {
    getAllSnapshots, deleteSnapshot, getSnapshotById,
    getStats, clearAll, trimOldSnapshots,
    clearPresetHistory,
    exportAll, importAll,
    TRIGGER_LABEL_KEYS, formatBytes,
} from './history-store.js';
import {
    confirmSafe, toast, t,
    getCurrentApiId, getSelectedPresetName,
    savePresetSafe, selectPresetSafe,
} from './compatibility.js';

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
    expandedPresets: null,    // Set<string> - 展开的预设 key（"<apiId>::<presetName>"）
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
        expandedPresets: new Set(),
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
        // 关闭子弹窗（如查看 JSON）
        if (_viewPopup) {
            try { _viewPopup.completeCancelled?.(); } catch (_) {}
            _viewPopup = null;
        }
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
    // 默认展开当前预设
    const curName = getSelectedPresetName();
    const curApi = getCurrentApiId();
    if (curName && curApi) {
        _state.expandedPresets.add(presetKey(curApi, curName));
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
                    <button class="pas-filter" data-filter="today" type="button">
                        <i class="fa-solid fa-calendar-day"></i><span>${escapeHtml(t('Today'))}</span>
                    </button>
                    <button class="pas-filter" data-filter="week" type="button">
                        <i class="fa-solid fa-calendar-week"></i><span>${escapeHtml(t('This Week'))}</span>
                    </button>
                </div>
                <div class="pas-list-actions">
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

    // 展开/收起全部
    $('.pas-btn-expand-all')?.addEventListener('click', () => {
        const presets = groupSnapshotsByPreset(applyFiltersAndSearch(_state.snapshots));
        for (const k of Object.keys(presets)) _state.expandedPresets.add(k);
        renderListTab();
    });
    $('.pas-btn-collapse-all')?.addEventListener('click', () => {
        _state.expandedPresets.clear();
        renderListTab();
    });

    // 列表事件委托
    const list = $('.pas-snapshot-list');
    if (list) list.addEventListener('click', handleListClick);

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
// 列表 Tab 渲染（按预设分组）
// =====================================================
function renderListTab() {
    const list = _root?.querySelector('.pas-snapshot-list');
    if (!list) return;

    const filtered = applyFiltersAndSearch(_state.snapshots);

    if (filtered.length === 0) {
        list.innerHTML = renderEmptyState();
        updateBadge(0);
        return;
    }

    // 按预设分组
    const grouped = groupSnapshotsByPreset(filtered);
    const presetKeys = Object.keys(grouped).sort((a, b) => {
        // 按各预设最新时间倒序排
        const at = grouped[a][0]?.timestamp || 0;
        const bt = grouped[b][0]?.timestamp || 0;
        return bt - at;
    });

    let html = '';
    for (const key of presetKeys) {
        html += renderPresetGroup(key, grouped[key]);
    }

    list.innerHTML = html;
    updateBadge(filtered.length);
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
    ${isExpanded ? `
    <div class="pas-preset-body">
        ${snapshots.map(renderCard).join('')}
    </div>` : ''}
</div>`;
}

function applyFiltersAndSearch(snapshots) {
    let result = [...snapshots];

    if (_state.filter === 'current') {
        const name = getSelectedPresetName();
        const api = getCurrentApiId();
        result = result.filter(s => s.presetName === name && s.apiId === api);
    } else if (_state.filter === 'today') {
        const start = startOfToday();
        result = result.filter(s => s.timestamp >= start);
    } else if (_state.filter === 'week') {
        const start = startOfWeek();
        result = result.filter(s => s.timestamp >= start);
    }

    if (_state.search) {
        const q = _state.search.toLowerCase();
        result = result.filter(s => (s.presetName || '').toLowerCase().includes(q));
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

    return `
<div class="pas-card" data-snapshot-id="${id}">
    <div class="pas-card-main">
        <div class="pas-card-title-row">
            <i class="fa-solid fa-circle pas-card-dot"></i>
            <span class="pas-card-time">${formatTime(s.timestamp)}</span>
            <span class="pas-tag pas-tag-${escapeAttr(s.trigger)}">${escapeHtml(triggerLabel)}</span>
        </div>
        <div class="pas-card-meta">
            <span class="pas-card-size">${formatBytes(s.size || 0)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-card-hash" title="hash">${escapeHtml(s.hash || '')}</span>
        </div>
    </div>
    <div class="pas-card-actions">
        <button class="pas-btn-action pas-btn-restore" data-id="${id}" title="${escapeAttr(t('Restore'))}" type="button" aria-label="${escapeAttr(t('Restore'))}">
            <i class="fa-solid fa-rotate-left"></i>
        </button>
        <button class="pas-btn-action pas-btn-view" data-id="${id}" title="${escapeAttr(t('View'))}" type="button" aria-label="${escapeAttr(t('View'))}">
            <i class="fa-solid fa-eye"></i>
        </button>
        <button class="pas-btn-action pas-btn-delete" data-id="${id}" title="${escapeAttr(t('Delete'))}" type="button" aria-label="${escapeAttr(t('Delete'))}">
            <i class="fa-solid fa-trash"></i>
        </button>
    </div>
</div>`;
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
    // 1) 折叠头点击 -> 切换展开
    const header = e.target.closest('.pas-preset-header');
    const clearBtn = e.target.closest('.pas-btn-clear-preset');

    if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = clearBtn.getAttribute('data-preset-key');
        await onClearPreset(key);
        return;
    }

    if (header) {
        const group = header.closest('.pas-preset-group');
        const key = group?.getAttribute('data-preset-key');
        if (!key) return;
        if (_state.expandedPresets.has(key)) _state.expandedPresets.delete(key);
        else _state.expandedPresets.add(key);
        renderListTab();
        return;
    }

    // 2) 卡片操作按钮
    const btn = e.target.closest('.pas-btn-action');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const id = btn.getAttribute('data-id');
    if (!id) return;

    if (btn.classList.contains('pas-btn-restore')) await onRestore(id);
    else if (btn.classList.contains('pas-btn-view')) await onView(id);
    else if (btn.classList.contains('pas-btn-delete')) await onDelete(id);
}

async function onRestore(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

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
    const ctx = SillyTavern.getContext();

    const html = `
<div class="pas-view-popup">
    <h4 style="margin: 0 0 8px 0; color: var(--SmartThemeQuoteColor, #b794f6);">
        <i class="fa-solid fa-circle" style="font-size: 0.5em; vertical-align: middle;"></i>
        ${escapeHtml(snapshot.presetName)}
    </h4>
    <div style="font-size: 0.85em; color: var(--white50a, #999); margin-bottom: 12px;">
        ${escapeHtml(time)} · ${escapeHtml(triggerLabel)} · ${formatBytes(snapshot.size || 0)}
    </div>
    <pre style="max-height: 60vh; overflow: auto; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 6px; font-size: 0.85em; line-height: 1.5;"><code>${escapeHtml(json)}</code></pre>
    <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
        <button class="menu_button" id="pas-view-copy" type="button">
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

    setTimeout(() => {
        document.querySelector('#pas-view-copy')?.addEventListener('click', () => {
            navigator.clipboard.writeText(json)
                .then(() => toast.success(t('Copied')))
                .catch(() => toast.error(t('Copy Failed')));
        });
    }, 100);

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

    ${group(t('Advanced Group'), [
        toggle('debugMode', t('Debug Mode'), t('Debug Mode Desc'), s.debugMode),
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
