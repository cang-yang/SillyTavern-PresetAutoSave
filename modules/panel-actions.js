/**
 * SillyTavern Preset Auto Save - Panel Actions
 * 面板操作处理（协调层——分组管理已提取至 panel-group-manager.js）
 *
 * 从 history-panel.js 提取：
 *   - 列表点击分发（handleListClick）
 *   - CRUD 操作（rename / pin / restore / view / delete / clearPreset）
 *   - Diff 操作（setDiff / clearDiff / startDiff / updateDiffBar）
 *   - 版本/系列操作（toggleSeriesDefault / applyVersionDirect）
 *   - 分组管理弹窗（showGroupingManager → panel-group-manager.js）
 *   - 首次扫描向导（showGroupingFirstScanWizard）
 */

import { logger } from './logger.js';
import {
    getSettings, updateSetting, batchUpdate,
} from './settings.js';
import {
    getSnapshotById, deleteSnapshot,
    clearPresetHistory, deleteOldSnapshotsForPreset,
    renameSnapshot, togglePinSnapshot,
    TRIGGER,
    getSnapshots,
} from './history-store.js';
import {
    sanitizePresetForExport,
    confirmSafe, toast, t,
    selectPresetSafe,
    getAllPresetNames,
    createPopupSafe,
    getCurrentApiId,
    getSelectedPresetName,
    getContextSafe,
    escapeTranslationHtml,
} from './compatibility.js';
import { saveNow, restoreSnapshotDetailed, deleteHostPresetDetailed } from './auto-save.js';
import { showDiffPopup, cleanupDiffPopup } from './diff-viewer.js';
import { refreshTakeover } from './preset-takeover.js';
import { removeArchivedPreset } from './archive-store.js';
import {
    parsePresetName,
    groupNamesBySeries,
    getSeriesInfo,
    normalizeSeriesKey,
} from './preset-grouping.js';
import {
    escapeHtml, escapeAttr, formatTime,
} from './panel-summary.js';
import { parsePresetKey } from './panel-list-model.js';
import { showSnapshotViewer as onView, cleanupSnapshotViewer } from './snapshot-viewer.js';
import { setDisclosureExpanded } from './panel-disclosure.js';
import { increaseSnapshotRenderLimit } from './core/bounded-snapshot-list.js';
import { createPresetDeletionCommand } from './core/preset-deletion.js';
import { selectGroupDefault } from './core/group-organization.js';

// --- 从子模块导入分组管理函数（软拆分：panel-group-manager.js） ---
import {
    clearGroupingManagerState,
    disposeGroupingManagerMount,
    getGroupingManagerPopup,
    setGroupingManagerPopup,
    showGroupingManager,
} from './panel-group-manager.js';

// =====================================================
// 弹窗状态（模块级）
// =====================================================
let _firstScanWizardPopup = null;

// =====================================================
// 常量
// =====================================================
/** 接管刷新等待（防抖 220ms + 接管重建 + 浏览器渲染余量） */
const TAKEOVER_REFRESH_WAIT_MS = 380;

// =====================================================
// 清理弹窗（供 teardown / panel-close 调用）
// =====================================================

/**
 * 关闭所有由 panel-actions 管理的子弹窗
 * @param {object} [options]
 * @param {boolean} [options.includeWizard] - 是否也关闭首次扫描向导（teardown 时 true）
 */
export function cleanupActionPopups({ includeWizard = false } = {}) {
    cleanupDiffPopup();
    cleanupSnapshotViewer();
    const gmPopup = getGroupingManagerPopup();
    if (gmPopup) {
        try { gmPopup.completeCancelled?.(); } catch (_) {}
        setGroupingManagerPopup(null);
        disposeGroupingManagerMount();
        // P1-1: 弹窗关闭时释放模块级状态，防止下次打开时残留旧数据
        clearGroupingManagerState();
    }
    if (includeWizard && _firstScanWizardPopup) {
        try { _firstScanWizardPopup.completeCancelled?.(); } catch (_) {}
        _firstScanWizardPopup = null;
    }
}

// =====================================================
// 点击分发：列表区域事件委托中心
// =====================================================

/**
 * @param {MouseEvent} e
 * @param {object} panelCtx - { root, state, refreshData, renderListTab, archivedCache }
 */
export async function handleListClick(e, panelCtx) {
    const showMoreBtn = e.target.closest('.pas-btn-show-more-snapshots');
    const clearBtn = e.target.closest('.pas-btn-clear-preset');
    const applyVersionBtn = e.target.closest('.pas-btn-apply-version');
    const deletePresetBtn = e.target.closest('.pas-version-delete-btn');
    const seriesHeader = e.target.closest('.pas-series-header');
    const versionHeader = e.target.closest('.pas-version-header');
    const presetHeader = e.target.closest('.pas-preset-header');

    if (showMoreBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = showMoreBtn.getAttribute('data-preset-key');
        const total = Number.parseInt(showMoreBtn.getAttribute('data-total-snapshots') || '0', 10);
        if (!key || !Number.isFinite(total)) return;
        const state = panelCtx.state();
        state.snapshotRenderLimits.set(
            key,
            increaseSnapshotRenderLimit(state.snapshotRenderLimits.get(key), total),
        );
        panelCtx.renderListTab();
        return;
    }

    // 1) 清除某预设/版本的全部历史按钮
    if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const key = clearBtn.getAttribute('data-preset-key');
        await onClearPreset(key, panelCtx);
        return;
    }

    // 1.1) "应用此版本"按钮（圆勾）
    if (applyVersionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const presetName = applyVersionBtn.getAttribute('data-preset-name');
        if (presetName) {
            await onApplyVersionDirect(presetName);
        }
        return;
    }

    // 1.2) AR-0: "删除预设"按钮
    if (deletePresetBtn) {
        e.preventDefault();
        e.stopPropagation();
        const presetName = deletePresetBtn.getAttribute('data-preset-name');
        const apiId = deletePresetBtn.getAttribute('data-api-id');
        if (presetName && apiId) {
            const ok = await onDeletePreset(presetName, apiId);
            if (ok) await panelCtx.refreshData();
        }
        return;
    }

    // ⚡ 性能优化：折叠/展开操作改成原地切换 DOM class，
    // 避免每次点击都重建整个面板的 innerHTML（数千个 DOM 节点）
    // 仅在确实需要"惰性渲染"内容时（首次展开 + body 还没生成）才走 renderListTab()

    const state = panelCtx.state();
    const renderListTab = panelCtx.renderListTab;

    // 2) 系列折叠（series 模式）
    if (seriesHeader) {
        const group = seriesHeader.closest('.pas-series-group');
        const key = group?.getAttribute('data-series-key');
        if (!key) return;
        const wasExpanded = state.expandedSeries.has(key);
        if (wasExpanded) state.expandedSeries.delete(key);
        else state.expandedSeries.add(key);
        // 优先做原地切换：body 已渲染过则直接切类即可
        const body = group.querySelector(':scope > .pas-series-body');
        if (body) {
            // Collapsed series intentionally omit their version markup. On the
            // first expansion, rebuild the list so native presets (including
            // zero-snapshot presets) are hydrated before the body is shown.
            if (!wasExpanded && body.childElementCount === 0) {
                renderListTab();
                return;
            }
            setDisclosureExpanded(group, body, !wasExpanded, {
                headerSelector: '.pas-series-header',
                chevronSelector: '.pas-series-chevron',
                iconSelector: '.pas-series-icon',
            });
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
        const wasExpanded = state.expandedVersions.has(key);
        if (wasExpanded) state.expandedVersions.delete(key);
        else state.expandedVersions.add(key);
        const body = group.querySelector(':scope > .pas-version-body');
        if (body) {
            // Collapsed versions are intentionally rendered with an empty body.
            // The first expansion must hydrate their cards instead of only
            // toggling the already-present placeholder container.
            if (!wasExpanded && body.childElementCount === 0) {
                renderListTab();
                return;
            }
            setDisclosureExpanded(group, body, !wasExpanded, {
                headerSelector: '.pas-version-header',
                chevronSelector: '.pas-version-chevron',
            });
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
        const wasExpanded = state.expandedPresets.has(key);
        if (wasExpanded) state.expandedPresets.delete(key);
        else state.expandedPresets.add(key);
        const body = group.querySelector(':scope > .pas-preset-body');
        if (body) {
            if (!wasExpanded && body.childElementCount === 0) {
                renderListTab();
                return;
            }
            setDisclosureExpanded(group, body, !wasExpanded, {
                headerSelector: '.pas-preset-header',
                chevronSelector: '.pas-preset-chevron',
            });
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
        case 'restore': await onRestore(id, panelCtx); break;
        case 'view':    await onView(id);              break;
        case 'export':  await onExportPreset(id);      break;
        case 'delete':  await onDelete(id, panelCtx);  break;
        case 'rename':  await onRename(id, panelCtx);  break;
        case 'pin':     await onTogglePin(id, panelCtx); break;
        case 'diff-a':  onSetDiff(id, 'a', panelCtx);  break;
        case 'diff-b':  onSetDiff(id, 'b', panelCtx);  break;
        default:
            // 兼容旧 class 路由
            if (btn.classList.contains('pas-btn-restore')) await onRestore(id, panelCtx);
            else if (btn.classList.contains('pas-btn-view')) await onView(id);
            else if (btn.classList.contains('pas-btn-export-preset')) await onExportPreset(id);
            else if (btn.classList.contains('pas-btn-delete')) await onDelete(id, panelCtx);
    }
}

// =====================================================
// CRUD 操作
// =====================================================

async function onRename(snapshotId, panelCtx) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    const current = (snapshot.name || '').trim();

    // P2 fix: 通过 createPopupSafe 集中防御 ctx / Popup / POPUP_TYPE.INPUT 缺失
    // 第四参数 inputValue 即 INPUT popup 的默认值
    let result;
    try {
        const popup = createPopupSafe(
            `<div class="pas-rename-popup">
                <div><strong>${escapeHtml(t('Rename Snapshot'))}</strong></div>
                <div class="pas-rename-popup-hint">${escapeHtml(t('Rename Hint'))}</div>
            </div>`,
            'INPUT',
            {
                okButton: t('Confirm'),
                cancelButton: t('Cancel'),
                rows: 1,
            },
            current
        );
        if (popup) {
            result = await popup.show();
        } else {
            // Popup 不可用：回退到原生 prompt
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
        await panelCtx.refreshData();
    } else {
        toast.error(t('Snapshot Not Found'));
    }
}

async function onTogglePin(snapshotId, panelCtx) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));
    const next = !snapshot.pinned;
    const result = await togglePinSnapshot(snapshotId, next);
    if (result === null) return toast.error(t('Snapshot Not Found'));
    toast.success(result ? t('Pinned Done') : t('Unpinned Done'));
    await panelCtx.refreshData({ allowCache: false });
}

let _restoreBusy = false;

async function onRestore(snapshotId, panelCtx) {
    // AM-0: 重入防护 — 防止快速连续点击恢复按钮
    if (_restoreBusy) {
        logger.warn('[onRestore] blocked reentrant call');
        return;
    }
    _restoreBusy = true;
    try {
        await _onRestoreImpl(snapshotId, panelCtx);
    } finally {
        _restoreBusy = false;
    }
}

async function _onRestoreImpl(snapshotId, panelCtx) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    // 防御：拒绝恢复明显损坏的快照（避免清空预设）
    const preset = snapshot.preset;
    if (!preset || typeof preset !== 'object' || Array.isArray(preset) || Object.keys(preset).length === 0) {
        const fieldCount = preset && typeof preset === 'object' ? Object.keys(preset).length : 0;
        logger.error(
            `Refusing to restore corrupt snapshot id=${snapshotId} fields=${fieldCount}`
        );
        toast.error(t('Restore Failed', {
            message: `Snapshot is corrupted (only ${fieldCount} fields). Refusing to restore to avoid clearing your preset.`,
        }));
        return;
    }

    // AM-0 P0: 跨预设安全检查 — 禁止恢复不属于当前预设的快照
    const currentPreset = getSelectedPresetName();
    const currentApi = getCurrentApiId();
    if (snapshot.presetName !== currentPreset || snapshot.apiId !== currentApi) {
        toast.warning(t('Restore Cross Preset Warning', {
            snapshotPreset: snapshot.presetName,
            currentPreset: currentPreset || '(unknown)',
        }));
        logger.warn(
            `[onRestore] blocked cross-preset restore: snapshot="${snapshot.presetName}" current="${currentPreset}"`
        );
        return;
    }

    const time = formatTime(snapshot.timestamp);
    const ok = await confirmSafe(
        escapeHtml(t('Confirm Restore')),
        `<div>${escapeTranslationHtml(t('Restore Snapshot Hint', { name: snapshot.presetName }))}</div>
         <div style="margin: 8px 0; padding: 8px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; font-family: monospace;">${escapeHtml(time)}</div>
         <div style="color: var(--white50a, #999); font-size: 0.9em;">${escapeHtml(t('Restore Irreversible'))}</div>`
    );
    if (!ok) return;

    if (currentApi !== getCurrentApiId() || currentPreset !== getSelectedPresetName()) {
        toast.warning(t('Restore Cross Preset Warning', {
            snapshotPreset: snapshot.presetName,
            currentPreset: getSelectedPresetName() || '(unknown)',
        }));
        return;
    }
    try {
        const result = await restoreSnapshotDetailed({
            apiId: currentApi, presetName: currentPreset, preset: snapshot.preset,
        });
        if (result.status === 'committed' || result.status === 'unchanged') {
            toast.success(t('Restored To Time', { time }));
        } else if (result.status === 'partial') {
            toast.error(t('Restore Partial'));
        } else {
            toast.error(t('Restore Failed', {
                message: result.error?.message || t('Restore Not Completed'),
            }));
        }
        await panelCtx.refreshData({ allowCache: false });
    } catch (e) {
        logger.error('Restore failed:', e);
        toast.error(t('Restore Failed', { message: e?.message || String(e) }));
    }
}

// =====================================================
// 导出预设快照为完整预设文件
// =====================================================

/**
 * 导出快照的完整预设数据为 JSON 文件
 * 快照中存储的 preset 字段就是完整的 oai_settings 对象，
 * 包含 prompts、prompt_order、custom_stopping_strings 等所有字段。
 * @param {string} snapshotId
 */
async function onExportPreset(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot?.preset) {
        toast.warning(t('Export Failed'));
        return;
    }

    // R-1: 过滤敏感/环境配置字段，只导出预设参数
    const data = sanitizePresetForExport(snapshot.preset, { apiId: snapshot.apiId });
    const safeName = (snapshot.presetName || 'preset').replace(/[<>:"/\\|?*]/g, '_');
    const dateStr = new Date(snapshot.timestamp).toISOString().slice(0, 10);
    const fileName = `${safeName}_${dateStr}.json`;

    try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(t('Export Preset Success'));
    } catch (e) {
        logger.error('Export preset failed:', e);
        toast.error(t('Export Failed'));
    }
}

async function onDelete(snapshotId, panelCtx) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return;

    const time = formatTime(snapshot.timestamp);
    const ok = await confirmSafe(
        escapeHtml(t('Delete Snapshot')),
        escapeTranslationHtml(t('Delete Snapshot Hint', { name: snapshot.presetName, time }))
    );
    if (!ok) return;

    await deleteSnapshot(snapshotId);
    toast.success(t('Deleted'));
    await panelCtx.refreshData({ allowCache: false });
}

async function onClearPreset(key, panelCtx) {
    const { apiId, presetName } = parsePresetKey(key);
    if (!apiId || !presetName) return;

    // AY-1: 获取该预设的所有快照，判断是否有可清理的历史
    const snapshots = await getSnapshots(apiId, presetName);
    if (!snapshots || snapshots.length <= 1) {
        toast.info(t('Clear Preset No History'));
        return;
    }

    const ok = await confirmSafe(
        escapeHtml(t('Clear Preset Confirm')),
        escapeTranslationHtml(t('Clear Preset Hint', { name: presetName }))
    );
    if (!ok) return;

    // AY-1: 保留最新的一条快照作为当前基准，只删除历史旧快照
    const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
    // sorted[0] 是最新的，保留它；删除其余的
    const result = await deleteOldSnapshotsForPreset(apiId, presetName, { keepNewest: 1, force: true });
    const deletedCount = result.deleted;

    logger.info(`[onClearPreset] kept newest snapshot, deleted ${deletedCount}/${sorted.length - 1} old snapshots for [${apiId}] ${presetName}`);
    toast.success(t('Cleared'));
    await panelCtx.refreshData({ allowCache: false });
}

// =====================================================
// 预设删除操作（AR-0）
// =====================================================

/**
 * 单个删除预设（从 ST + 快照 + 归档 + 分组覆盖 全量清理）
 *
 * 安全层级：
 *   L1: 当前预设保护（UI disabled + 逻辑检查）
 *   L2: confirmSafe 确认对话框
 *   L5: 执行删除 + 全量清理
 *   L6: 操作日志
 *
 * @param {string} presetName
 * @param {string} apiId
 * @returns {Promise<boolean>}
 */
const isCurrentPresetTarget = ({ apiId, presetName }) =>
    apiId === getCurrentApiId() && presetName === getSelectedPresetName();

const deletePresetCommand = createPresetDeletionCommand({
    runHostDeletion: (target, afterDelete) => deleteHostPresetDetailed(target, { afterDelete }),
    clearHistory: target => clearPresetHistory(target.apiId, target.presetName),
    removeArchive: target => removeArchivedPreset(target.apiId, target.presetName),
    isCurrentTarget: isCurrentPresetTarget,
    notifyHost: async ({ apiId, presetName }) => {
        const ctx = getContextSafe();
        if (ctx?.eventSource?.emit && ctx?.event_types?.PRESET_DELETED) {
            await ctx.eventSource.emit(ctx.event_types.PRESET_DELETED, { apiId, name: presetName });
        }
        ctx?.saveSettingsDebounced?.();
    },
});

function observeDeletionResult(result) {
    try {
        if (result.status === 'committed') {
            refreshTakeover({ force: true });
            toast.success(t('Delete Preset Success', { name: result.target.presetName }));
        } else if (result.status === 'protected') {
            toast.warning(t('Delete Preset Current Warning'));
        } else {
            logger.error(`Preset deletion ${result.status} at ${result.stage}`, result.error);
            toast.error(t(result.status === 'partial' ? 'Delete Preset Partial' : 'Delete Preset Failed',
                { name: result.target.presetName }));
        }
    } catch (error) {
        logger.warn('Deletion presentation failed:', error);
    }
}

export async function onDeletePreset(presetName, apiId) {
    // L1: 当前预设保护
    const target = Object.freeze({ apiId, presetName });
    if (isCurrentPresetTarget(target)) {
        toast.warning(t('Delete Preset Current Warning'));
        return false;
    }

    // L2: 确认对话框（presetName 必须 escapeHtml，confirmSafe → Popup 会渲染 HTML）
    const confirmed = await confirmSafe(
        escapeHtml(t('Delete Preset Btn')),
        escapeTranslationHtml(t('Delete Preset Confirm', { name: presetName }))
    );
    if (!confirmed) return false;

    // L1-bis: 竞态防护 — 用户在确认弹窗期间可能已切换预设
    if (isCurrentPresetTarget(target)) {
        toast.warning(t('Delete Preset Current Warning'));
        return false;
    }

    const result = await deletePresetCommand(target);
    // Organization is global across APIs and is not owned by this preset deletion.
    observeDeletionResult(result);
    return result.status === 'committed';
}

/**
 * 批量删除预设
 *
 * 安全层级：
 *   L1: 自动过滤当前预设
 *   L3: INPUT 弹窗强确认（要求输入数量）
 *   L5: 逐个删除 + 全量清理
 *   L6: 操作日志
 *
 * @param {Array<string|{apiId:string,presetName:string}>} presetNames
 * @param {string} apiId
 * @returns {Promise<number>} 成功删除的数量
 */
export async function onBatchDeletePresets(presetNames, apiId) {
    if (!presetNames || !presetNames.length) return 0;

    // L1: 过滤掉当前预设
    const targets = presetNames.map(item => typeof item === 'string'
        ? { apiId, presetName: item }
        : { apiId: item.apiId, presetName: item.presetName });
    const toDelete = [...new Map(targets.map(target => [
        JSON.stringify([target.apiId, target.presetName]), Object.freeze(target),
    ])).values()]
        .filter(target => !isCurrentPresetTarget(target));
    if (toDelete.length === 0) {
        toast.warning(t('Delete Preset Current Warning'));
        return 0;
    }

    // L3: 强确认 — 弹出 INPUT 弹窗要求输入数量
    const count = toDelete.length;
    const popup = createPopupSafe(
        t('Batch Delete Confirm', { count }),
        'INPUT',
        { okButton: t('Confirm'), cancelButton: t('Cancel'), rows: 1 },
        ''
    );
    let input = null;
    if (popup) {
        try { input = await popup.show(); } catch (_) {}
    } else {
        input = window.prompt(t('Batch Delete Confirm', { count }));
    }
    if (input === null || input === undefined || input === false) return 0; // 取消
    if (String(input).trim() !== String(count)) {
        toast.warning(t('Batch Delete Wrong Number'));
        return 0;
    }

    // L1-bis: 竞态防护 — 弹窗期间可能已切换预设，重新过滤
    const safeToDelete = toDelete.filter(target => !isCurrentPresetTarget(target));
    if (safeToDelete.length === 0) {
        toast.warning(t('Delete Preset Current Warning'));
        return 0;
    }

    // 逐个删除
    const results = [];
    for (const target of safeToDelete) results.push(await deletePresetCommand(target));
    const successCount = results.filter(result => result.status === 'committed').length;
    try {
        refreshTakeover({ force: true });
        if (successCount === safeToDelete.length) {
            toast.success(t('Batch Delete Success', { count: successCount }));
        } else {
            toast.warning(t('Batch Delete Incomplete', {
                count: successCount, total: safeToDelete.length,
            }));
        }
    } catch (error) {
        logger.warn('Batch deletion presentation failed:', error);
    }
    return successCount;
}

// =====================================================
// Diff 操作
// =====================================================

/**
 * 设置 / 取消 diff 对比的 A 或 B 槽
 * 同一 snapshot 重复点同一槽 = 取消
 * 同一 snapshot 已被另一槽选中时 = 交换槽
 */
function onSetDiff(snapshotId, slot /* 'a' | 'b' */, panelCtx) {
    if (slot !== 'a' && slot !== 'b') return;
    const sel = panelCtx.state().diffSel;

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

    updateDiffBar(panelCtx);
    // N-6: 保存滚动位置，渲染后恢复（避免选择 A/B 时列表跳回顶部）
    const listEl = panelCtx.root()?.querySelector('.pas-snapshot-list');
    const savedScrollTop = listEl ? listEl.scrollTop : 0;
    panelCtx.renderListTab();
    if (listEl) {
        requestAnimationFrame(() => { listEl.scrollTop = savedScrollTop; });
    }
}

/**
 * @param {object} panelCtx
 */
export function onClearDiff(panelCtx) {
    const state = panelCtx.state();
    state.diffSel.a = null;
    state.diffSel.b = null;
    updateDiffBar(panelCtx);
    // N-6: 保存滚动位置，渲染后恢复
    const listEl = panelCtx.root()?.querySelector('.pas-snapshot-list');
    const savedScrollTop = listEl ? listEl.scrollTop : 0;
    panelCtx.renderListTab();
    if (listEl) {
        requestAnimationFrame(() => { listEl.scrollTop = savedScrollTop; });
    }
}

/**
 * @param {object} panelCtx
 */
export async function onStartDiff(panelCtx) {
    const { a, b } = panelCtx.state().diffSel;
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

    // diff 对比始终限制为同一系列——不同系列之间预设结构不同，对比无意义
    // 嵌套分组仅影响 UI 展示组织，不扩大 diff 可比较范围
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const infoA = getSeriesInfo(snapA.presetName, overrides);
    const infoB = getSeriesInfo(snapB.presetName, overrides);
    const seriesA = normalizeSeriesKey(infoA.series || snapA.presetName);
    const seriesB = normalizeSeriesKey(infoB.series || snapB.presetName);
    if (seriesA !== seriesB) {
        toast.warning(t('Diff Cross Series Not Allowed'));
        return;
    }

    await showDiffPopup(snapA, snapB);
}

/**
 * 同步顶部 diff 选择条的显示文本与按钮可用性
 * @param {object} panelCtx
 */
export function updateDiffBar(panelCtx) {
    const root = panelCtx.root();
    const state = panelCtx.state();
    if (!root) return;
    const slotA = root.querySelector('#pas-diff-slot-a');
    const slotB = root.querySelector('#pas-diff-slot-b');
    const bar = root.querySelector('#pas-diff-bar');
    const startBtn = root.querySelector('.pas-btn-start-diff');
    const clearBtn = root.querySelector('.pas-btn-clear-diff');

    const formatSlot = (slot, slotEl) => {
        if (!slotEl) return;
        const id = state.diffSel[slot];
        const text = slotEl.querySelector('.pas-diff-bar-slot-text');
        if (!id) {
            slotEl.classList.remove('pas-diff-slot-set');
            if (text) text.title = text.textContent = t('Diff Slot Empty');
            return;
        }
        const snap = state.snapshots.find(s => s.id === id);
        const label = snap
            ? (snap.name?.trim() || formatTime(snap.timestamp))
            : t('Diff Slot Empty');
        slotEl.classList.add('pas-diff-slot-set');
        if (text) text.title = text.textContent = label;
    };
    formatSlot('a', slotA);
    formatSlot('b', slotB);

    const hasAny = !!state.diffSel.a || !!state.diffSel.b;
    if (bar) {
        const restoreSearchFocus = !hasAny && bar.contains(bar.ownerDocument.activeElement);
        bar.hidden = !hasAny;
        if (restoreSearchFocus) root.querySelector('.pas-search')?.focus();
    }
    const ready = !!state.diffSel.a && !!state.diffSel.b;
    if (startBtn) {
        if (ready) startBtn.removeAttribute('disabled');
        else startBtn.setAttribute('disabled', 'disabled');
    }
    if (clearBtn) {
        if (hasAny) clearBtn.removeAttribute('disabled');
        else clearBtn.setAttribute('disabled', 'disabled');
    }
}

// =====================================================
// 版本/系列操作
// =====================================================

/**
 * 切换"系列默认应用版本"
 *   - 如果当前 presetName 已经是该 seriesKey 的默认 → 取消（删除映射）
 *   - 否则设为该系列的默认版本
 *   - 切换后立即调用 refreshTakeover() 让原生下拉重新生效
 */
async function onToggleSeriesDefault(seriesKey, presetName, panelCtx) {
    if (!seriesKey || !presetName) return;
    const settings = getSettings();
    const defaults = settings.seriesDefaultApply || {};
    const wasDefault = Object.hasOwn(defaults, seriesKey) && defaults[seriesKey] === presetName;
    const map = selectGroupDefault(defaults, seriesKey, presetName, { toggle: true });

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
    panelCtx.renderListTab();
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
            const map = selectGroupDefault(settings.seriesDefaultApply, seriesKey, presetName);
            updateSetting('seriesDefaultApply', map);
            // 等接管刷新落地（防抖窗口 220ms + 接管 + 浏览器渲染）
            await new Promise(r => setTimeout(r, TAKEOVER_REFRESH_WAIT_MS));
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
// 分组管理弹窗（已提取至 panel-group-manager.js）
// 以下为 re-export，保持向后兼容
// =====================================================

// showGroupingManager 已通过顶层 import 导入，在此 re-export
export { showGroupingManager };

// =====================================================
// 首次扫描向导
// =====================================================

/**
 * 弹出"首次整理预设分组"向导
 * 调用方：当扩展加载，且 settings.groupingFirstScanDone === false 且 enabled === true 时
 */
export async function showGroupingFirstScanWizard(opts = {}) {
    const { isRescan = false } = opts;
    if (_firstScanWizardPopup) return;
    if (!getContextSafe()) return;

    let names = [];
    try {
        const list = getAllPresetNames();
        if (Array.isArray(list)) names = list.filter(Boolean);
    } catch (_) {}

    if (names.length < 2) {
        updateSetting('groupingFirstScanDone', true);
        return;
    }

    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const groups = groupNamesBySeries(names, overrides, settings.groupingSeriesAliases || {});
    // AT0: 不再过滤单版本组，全部显示；多版本组排前面
    const sortedGroups = [...groups].sort((a, b) => b.items.length - a.items.length);
    const previewHtml = sortedGroups.slice(0, 12).map(g => `
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

    const moreCount = sortedGroups.length > 12 ? sortedGroups.length - 12 : 0;

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

    // AT0: 首次向导用"暂不分组"，魔法棒重新扫描用"返回"
    const cancelText = isRescan ? t('Grouping Rescan Back') : t('Grouping First Scan Skip');
    _firstScanWizardPopup = createPopupSafe(html, 'CONFIRM', {
        okButton: t('Grouping First Scan Confirm'),
        cancelButton: cancelText,
    });

    if (!_firstScanWizardPopup) {
        logger.error('[showGroupingFirstScanWizard] createPopupSafe returned null');
        return;
    }

    // AT0: 弹出后给 OK 按钮加绿色样式
    try {
        requestAnimationFrame(() => {
            const okBtn = document.querySelector('.popup:last-of-type .popup-button-ok, .popup:last-of-type [data-result="1"]');
            if (okBtn) {
                okBtn.classList.add('pas-btn-confirm-green');
            }
        });
    } catch (_) {}

    let result = false;
    try {
        result = await _firstScanWizardPopup.show();
    } finally {
        _firstScanWizardPopup = null;
    }

    if (result) {
        batchUpdate({
            groupingEnabled: true,
            groupingFirstScanDone: true,
        });
        toast.success(t('Grouping First Scan Done', {
            series: groups.length,
            versions: names.length,
        }));
    } else if (!isRescan) {
        // AT0: 首次向导 → 点"暂不分组"：标记向导已完成（避免每次启动都弹）
        // 注意：不关闭 groupingEnabled，因为接管模块依赖它（preset-takeover refresh）
        updateSetting('groupingFirstScanDone', true);
    }
    // AT0: 返回布尔值，调用方可靠判断用户选择，不再依赖间接读 settings
    return !!result;
}
