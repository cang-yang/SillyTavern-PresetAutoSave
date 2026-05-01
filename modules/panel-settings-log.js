/**
 * SillyTavern Preset Auto Save - Panel Settings & Log Tab
 * 设置 Tab 和日志 Tab 的渲染/绑定/操作逻辑
 *
 * 从 history-panel.js 提取，通过 panelCtx 上下文对象访问面板状态。
 *
 * panelCtx 接口：
 *   root()          → DOM 根元素（可能为 null）
 *   state()         → 面板状态对象（_state）
 *   refreshData()   → 刷新数据并重渲染
 *   renderListTab() → 重新渲染列表 Tab
 */

import { logger } from './logger.js';
import {
    getSettings, updateSetting, resetSettings,
} from './settings.js';
import {
    getStats, trimOldSnapshots, cleanCorruptSnapshots,
    exportAll, importAll, clearAll,
} from './history-store.js';
import {
    confirmSafe, toast, t,
} from './compatibility.js';
import { saveNow, getCurrentTracking, resetLastSavedHash } from './auto-save.js';
import { forceReseedSnapshots } from './preset-takeover.js';
import { escapeHtml } from './panel-summary.js';

// =====================================================
// 内部工具函数
// =====================================================

/** HTML 属性转义（与 escapeHtml 等价） */
function escapeAttr(s) {
    return escapeHtml(s);
}

function formatLogTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// =====================================================
// 日志 Tab 渲染
// =====================================================
export function renderLogTab(panelCtx) {
    const root = panelCtx.root();
    const state = panelCtx.state();
    const view = root?.querySelector('#pas-log-view');
    if (!view) return;

    const filter = {};
    if (state.log.level && state.log.level !== 'all') {
        filter.level = state.log.level;
    }
    if (state.log.search) filter.search = state.log.search;

    const entries = logger.getLogs(filter);
    updateLogBadge(panelCtx, entries.length);

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

    if (state.log.autoScroll) {
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

export function updateLogBadge(panelCtx, count = null) {
    const root = panelCtx.root();
    const badge = root?.querySelector('#pas-log-badge');
    if (!badge) return;
    const c = count !== null ? count : logger.getLogCount();
    badge.textContent = String(c);
}

export async function onLogClear(panelCtx) {
    const ok = await confirmSafe(t('Clear Logs Confirm'), t('Clear Logs Hint'));
    if (!ok) return;
    logger.clearLogs();
    renderLogTab(panelCtx);
}

export async function onLogCopy(panelCtx) {
    const state = panelCtx.state();
    const filter = {};
    if (state.log.level && state.log.level !== 'all') filter.level = state.log.level;
    if (state.log.search) filter.search = state.log.search;
    const text = logger.exportText(filter);
    try {
        await navigator.clipboard.writeText(text);
        toast.success(t('Copied'));
    } catch (_) {
        toast.error(t('Copy Failed'));
    }
}

export function onLogExport(panelCtx) {
    try {
        const state = panelCtx.state();
        const filter = {};
        if (state.log.level && state.log.level !== 'all') filter.level = state.log.level;
        if (state.log.search) filter.search = state.log.search;
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
export function renderSettingsTab(panelCtx) {
    const root = panelCtx.root();
    const container = root?.querySelector('[data-content="settings"]');
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
        toggle('takeoverDefaultExpand', t('Takeover Default Expand'), t('Takeover Default Expand Hint'), s.takeoverDefaultExpand),
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

    bindSettingsEvents(container, panelCtx);
}

// =====================================================
// 设置 HTML 构建辅助函数（内部）
// =====================================================
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

// =====================================================
// 设置事件绑定
// =====================================================
export function bindSettingsEvents(container, panelCtx) {
    // 复选框
    container.querySelectorAll('input[type="checkbox"][data-setting]').forEach(input => {
        input.addEventListener('change', () => {
            const key = input.getAttribute('data-setting');
            updateSetting(key, input.checked);
            // takeoverEnabled 变更后刷新面板，使 UI 即时反映接管状态变化
            if (key === 'takeoverEnabled') {
                panelCtx.refreshData();
            }
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

            updateSetting(key, newValue);
        });
    });

    // 重置按钮
    container.querySelector('.pas-btn-reset')?.addEventListener('click', async () => {
        const ok = await confirmSafe(t('Reset Settings Confirm'), t('Reset Settings Hint'));
        if (!ok) return;
        resetSettings();
        toast.success(t('Reset Settings Done'));
        renderSettingsTab(panelCtx);
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
                if (panelCtx.state().tab === 'list') await panelCtx.refreshData();
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
        await panelCtx.refreshData();
    });
}

// =====================================================
// 底部操作
// =====================================================
export async function onCleanup(panelCtx) {
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
    await panelCtx.refreshData();
}

export async function onExport() {
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

export async function onImport(panelCtx) {
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
            await panelCtx.refreshData();
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
export async function onPurgeCorrupt(panelCtx) {
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
        await panelCtx.refreshData();
    } catch (e) {
        logger.error('Purge corrupt failed:', e);
        toast.error(t('Purge Corrupt Failed', { message: e?.message || String(e) }));
    }
}

/**
 * 立即手动快照当前预设（也作为"卡住状态"的紧急逃生口）
 */
export async function onSnapshotNow(panelCtx) {
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
        await panelCtx.refreshData();
    } catch (e) {
        logger.error('Manual snapshot failed:', e);
        toast.error(t('Snapshot Failed', { message: e?.message || String(e) }));
    }
}

// =====================================================
// 状态更新（防御性：root 在 await 期间可能已被关闭）
// =====================================================
export async function updateStats(panelCtx) {
    const root = panelCtx.root();
    if (!root) return;
    let stats;
    try {
        stats = await getStats();
    } catch (e) {
        logger.debug('updateStats getStats failed:', e);
        return;
    }
    // ⚡ 关键：await 之后必须再次检查 root，
    //    用户在 stats 读取期间关闭面板会导致 root === null → querySelector 抛 TypeError
    const rootAfter = panelCtx.root();
    if (!rootAfter || !rootAfter.isConnected) return;

    const headerStats = rootAfter.querySelector('#pas-panel-stats');
    if (headerStats) {
        headerStats.textContent = t('Header Stats', {
            count: stats.snapshotCount,
            size: stats.totalSizeFormatted,
        });
    }

    const footerStats = rootAfter.querySelector('#pas-footer-stats');
    if (footerStats) {
        footerStats.innerHTML = t('Footer Stats', {
            count: stats.snapshotCount,
            size: stats.totalSizeFormatted,
            presets: stats.presetCount,
        });
    }
}
