/**
 * SillyTavern Preset Auto Save - Panel Actions
 * 面板操作处理 & 分组管理弹窗
 *
 * 从 history-panel.js 提取：
 *   - 列表点击分发（handleListClick）
 *   - CRUD 操作（rename / pin / restore / view / delete / clearPreset）
 *   - Diff 操作（setDiff / clearDiff / startDiff / updateDiffBar）
 *   - 版本/系列操作（toggleSeriesDefault / applyVersionDirect）
 *   - 分组管理弹窗（showGroupingManager / showGroupingFirstScanWizard）
 */

import { logger } from './logger.js';
import {
    getSettings, updateSetting, batchUpdate,
} from './settings.js';
import {
    getSnapshotById, deleteSnapshot,
    clearPresetHistory,
    renameSnapshot, togglePinSnapshot,
    addSnapshot, TRIGGER, TRIGGER_LABEL_KEYS, formatBytes,
    hashPreset,
    getSnapshots,
} from './history-store.js';
import {
    sanitizePresetForExport,
    confirmSafe, toast, t,
    savePresetSafe, selectPresetSafe,
    getPresetSnapshot,
    getAllPresetNames,
    deletePresetSafe,
    createPopupSafe,
    getCurrentApiId,
    getSelectedPresetName,
} from './compatibility.js';
import { saveNow, resetLastSavedHash, beginAtomicRestore, endAtomicRestore } from './auto-save.js';
import { showDiffPopup } from './diff-viewer.js';
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
    renderSummary,
} from './panel-summary.js';
import { parsePresetKey } from './panel-list-render.js';

// =====================================================
// 弹窗状态（模块级）
// =====================================================
let _viewPopup = null;
let _groupingManagerPopup = null;
let _firstScanWizardPopup = null;

// =====================================================
// 清理弹窗（供 teardown / panel-close 调用）
// =====================================================

/**
 * 关闭所有由 panel-actions 管理的子弹窗
 * @param {object} [options]
 * @param {boolean} [options.includeWizard] - 是否也关闭首次扫描向导（teardown 时 true）
 */
export function cleanupActionPopups({ includeWizard = false } = {}) {
    if (_viewPopup) {
        try { _viewPopup.completeCancelled?.(); } catch (_) {}
        _viewPopup = null;
    }
    if (_groupingManagerPopup) {
        try { _groupingManagerPopup.completeCancelled?.(); } catch (_) {}
        _groupingManagerPopup = null;
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
    const clearBtn = e.target.closest('.pas-btn-clear-preset');
    const applyVersionBtn = e.target.closest('.pas-btn-apply-version');
    const deletePresetBtn = e.target.closest('.pas-version-delete-btn');
    const seriesHeader = e.target.closest('.pas-series-header');
    const versionHeader = e.target.closest('.pas-version-header');
    const presetHeader = e.target.closest('.pas-preset-header');

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
        const wasExpanded = state.expandedVersions.has(key);
        if (wasExpanded) state.expandedVersions.delete(key);
        else state.expandedVersions.add(key);
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
        const wasExpanded = state.expandedPresets.has(key);
        if (wasExpanded) state.expandedPresets.delete(key);
        else state.expandedPresets.add(key);
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
    await panelCtx.refreshData();
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
        t('Confirm Restore'),
        `<div>${t('Restore Snapshot Hint', { name: escapeHtml(snapshot.presetName) })}</div>
         <div style="margin: 8px 0; padding: 8px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; font-family: monospace;">${escapeHtml(time)}</div>
         <div style="color: var(--white50a, #999); font-size: 0.9em;">${escapeHtml(t('Restore Irreversible'))}</div>`
    );
    if (!ok) return;

    // AL-1: 原子恢复 — 在整个操作期间抑制所有自动保存事件副作用
    // （savePresetSafe 会触发 SETTINGS_UPDATED 等事件，若不抑制会导致
    //  updateTrackingAfterSwitch → seedSnapshot → resetHash
    //  与 onRestore 自身的 addSnapshot / resetHash 互相干扰，hash 震荡）
    beginAtomicRestore();
    try {
        // 1. 写入预设到磁盘（skipUpdate:false 让 ST 重新加载 UI）
        //    AM-0 P1a: 使用当前预设名/API（已通过 P0 验证与快照一致），
        //    不再调用 selectPresetSafe()，因为当前预设就是目标预设
        await savePresetSafe(currentPreset, snapshot.preset, {
            skipUpdate: false, apiId: currentApi,
        });

        // 2. 创建恢复快照并计算正确的 hash
        //    AN-1 修复：直接使用快照中的预设数据，而不是从 getPresetSnapshot()
        //    读取可能尚未更新的 live 数据（oai_settings）。
        //    savePresetSafe(skipUpdate:false) 触发 ST 重新加载 UI 是异步的，
        //    oai_settings 在 savePresetSafe 返回后可能仍是恢复前的旧值，
        //    导致 hashPreset() 算出旧 hash → endAtomicRestore 设置错误的基线。
        let restoreHash = null;
        try {
            const restoredPreset = snapshot.preset;
            if (restoredPreset) {
                await addSnapshot(currentPreset, currentApi, restoredPreset, TRIGGER.RESTORE);
                restoreHash = hashPreset(restoredPreset);
            }
        } catch (snapErr) {
            logger.warn('Post-restore snapshot failed (non-fatal):', snapErr);
        }

        // 3. 结束原子恢复：将 tracking hash 设为恢复后的真实指纹
        //    （而非 null，避免"下次必定认为有变化"的错误行为）
        //    endAtomicRestore 内部会设置 2 秒抑制窗口（AM-0 P1b）
        endAtomicRestore(restoreHash, {
            apiId: currentApi,
            presetName: currentPreset,
        });

        toast.success(t('Restored To Time', { time }));
        await panelCtx.refreshData();
    } catch (e) {
        // 异常时也必须结束原子恢复，防止卡住
        endAtomicRestore(null);
        logger.error('Restore failed:', e);
        toast.error(t('Restore Failed', { message: e?.message || String(e) }));
    }
}

async function onView(snapshotId) {
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) return toast.error(t('Snapshot Not Found'));

    // 显示前过滤敏感字段，避免 API key 等泄露到 UI
    const safePreset = sanitizePresetForExport(snapshot.preset);
    const json = JSON.stringify(safePreset, null, 2);
    const time = formatTime(snapshot.timestamp);
    const triggerLabel = t(TRIGGER_LABEL_KEYS[snapshot.trigger] || 'Trigger Auto');
    const summaryHtml = renderSummary(snapshot.summary, { compact: false });

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

    _viewPopup = createPopupSafe(html, 'DISPLAY', {
        wide: true, large: true,
        allowVerticalScrolling: true,
        okButton: false, cancelButton: t('Close'),
    });

    if (!_viewPopup) {
        logger.error('[onView] createPopupSafe returned null');
        toast.error(t('Snapshot Not Found'));
        return;
    }

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
    const data = sanitizePresetForExport(snapshot.preset);
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
        t('Delete Snapshot'),
        t('Delete Snapshot Hint', { name: escapeHtml(snapshot.presetName), time: escapeHtml(time) })
    );
    if (!ok) return;

    await deleteSnapshot(snapshotId);
    toast.success(t('Deleted'));
    await panelCtx.refreshData();
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
        t('Clear Preset Confirm'),
        t('Clear Preset Hint', { name: escapeHtml(presetName) })
    );
    if (!ok) return;

    // AY-1: 保留最新的一条快照作为当前基准，只删除历史旧快照
    const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
    // sorted[0] 是最新的，保留它；删除其余的
    let deletedCount = 0;
    for (let i = 1; i < sorted.length; i++) {
        const result = await deleteSnapshot(sorted[i].id, { force: true });
        if (result) deletedCount++;
    }

    logger.info(`[onClearPreset] kept newest snapshot, deleted ${deletedCount}/${sorted.length - 1} old snapshots for [${apiId}] ${presetName}`);
    toast.success(t('Cleared'));
    await panelCtx.refreshData();
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
export async function onDeletePreset(presetName, apiId) {
    // L1: 当前预设保护
    const currentPreset = getSelectedPresetName();
    if (presetName === currentPreset) {
        toast.warning(t('Delete Preset Current Warning'));
        return false;
    }

    // L2: 确认对话框（presetName 必须 escapeHtml，confirmSafe → Popup 会渲染 HTML）
    const confirmed = await confirmSafe(
        t('Delete Preset Btn'),
        t('Delete Preset Confirm', { name: escapeHtml(presetName) })
    );
    if (!confirmed) return false;

    // L1-bis: 竞态防护 — 用户在确认弹窗期间可能已切换预设
    const currentAfterConfirm = getSelectedPresetName();
    if (presetName === currentAfterConfirm) {
        toast.warning(t('Delete Preset Current Warning'));
        return false;
    }

    try {
        // L5: 执行删除（调用 ST PresetManager.deletePreset）
        await deletePresetSafe(presetName, apiId);

        // L5-b: 补全 ST 原生 onDeletePresetClick 的后续动作
        //   ST 的 PresetManager.deletePreset() 只处理 DOM/数组/API 调用，
        //   不 emit PRESET_DELETED、不调用 saveSettingsDebounced()。
        //   这两步在 ST openai.js onDeletePresetClick() 中单独完成。
        try {
            const ctx = SillyTavern.getContext();
            if (ctx?.eventSource?.emit && ctx?.event_types?.PRESET_DELETED) {
                await ctx.eventSource.emit(ctx.event_types.PRESET_DELETED, { apiId, name: presetName });
            }
            if (typeof ctx?.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
        } catch (postErr) {
            logger.warn('[DeletePreset] post-delete ST sync failed (non-fatal):', postErr);
        }

        // L5-c: 全量清理
        // - 删除对应的快照数据
        await clearPresetHistory(apiId, presetName);
        // - 删除对应的归档数据（如果有）
        await removeArchivedPreset(apiId, presetName);
        // - 清理分组覆盖
        const overrides = { ...(getSettings().groupingManualOverrides || {}) };
        if (overrides[presetName]) {
            delete overrides[presetName];
            batchUpdate({ groupingManualOverrides: overrides });
        }

        // L6: 操作日志
        logger.warn(`[DeletePreset] deleted "${presetName}" (apiId=${apiId})`);

        // 刷新 UI
        refreshTakeover({ force: true });
        toast.success(t('Delete Preset Success', { name: escapeHtml(presetName) }));

        return true;
    } catch (e) {
        logger.error(`[DeletePreset] failed:`, e);
        toast.error(t('Delete Preset Failed', { name: escapeHtml(presetName) }));
        return false;
    }
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
 * @param {string[]} presetNames
 * @param {string} apiId
 * @returns {Promise<number>} 成功删除的数量
 */
export async function onBatchDeletePresets(presetNames, apiId) {
    if (!presetNames || !presetNames.length) return 0;

    // L1: 过滤掉当前预设
    const currentPreset = getSelectedPresetName();
    const toDelete = presetNames.filter(n => n !== currentPreset);
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
    const currentAfterConfirm = getSelectedPresetName();
    const safeToDelete = toDelete.filter(n => n !== currentAfterConfirm);
    if (safeToDelete.length === 0) {
        toast.warning(t('Delete Preset Current Warning'));
        return 0;
    }

    // 逐个删除
    let successCount = 0;
    const deletedNames = [];
    for (const name of safeToDelete) {
        try {
            await deletePresetSafe(name, apiId);
            await clearPresetHistory(apiId, name);
            await removeArchivedPreset(apiId, name);
            logger.warn(`[BatchDelete] deleted "${name}"`);
            deletedNames.push(name);
            successCount++;
        } catch (e) {
            logger.error(`[BatchDelete] failed for "${name}":`, e);
        }
    }

    // 补全 ST 原生后续动作：emit PRESET_DELETED + saveSettingsDebounced
    if (deletedNames.length > 0) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx?.eventSource?.emit && ctx?.event_types?.PRESET_DELETED) {
                for (const name of deletedNames) {
                    await ctx.eventSource.emit(ctx.event_types.PRESET_DELETED, { apiId, name });
                }
            }
            if (typeof ctx?.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
        } catch (postErr) {
            logger.warn('[BatchDelete] post-delete ST sync failed (non-fatal):', postErr);
        }
    }

    // 清理分组覆盖（批量）
    const overrides = { ...(getSettings().groupingManualOverrides || {}) };
    let changed = false;
    for (const name of deletedNames) {
        if (overrides[name]) {
            delete overrides[name];
            changed = true;
        }
    }
    if (changed) batchUpdate({ groupingManualOverrides: overrides });

    refreshTakeover({ force: true });
    toast.success(t('Batch Delete Success', { count: successCount }));
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

    // T11: 限制对比只能在同系列（same series）内进行
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
    const startBtn = root.querySelector('.pas-btn-start-diff');
    const clearBtn = root.querySelector('.pas-btn-clear-diff');

    const formatSlot = (slot, slotEl) => {
        if (!slotEl) return;
        const id = state.diffSel[slot];
        const text = slotEl.querySelector('.pas-diff-bar-slot-text');
        if (!id) {
            slotEl.classList.remove('pas-diff-slot-set');
            if (text) text.textContent = t('Diff Slot Empty');
            return;
        }
        const snap = state.snapshots.find(s => s.id === id);
        const label = snap
            ? (snap.name?.trim() || formatTime(snap.timestamp))
            : t('Diff Slot Empty');
        slotEl.classList.add('pas-diff-slot-set');
        if (text) text.textContent = label;
    };
    formatSlot('a', slotA);
    formatSlot('b', slotB);

    const ready = !!state.diffSel.a && !!state.diffSel.b;
    if (startBtn) {
        if (ready) startBtn.removeAttribute('disabled');
        else startBtn.setAttribute('disabled', 'disabled');
    }
    if (clearBtn) {
        const hasAny = !!state.diffSel.a || !!state.diffSel.b;
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
// 分组管理弹窗（AA-3 重构：系列卡片为核心视图）
// =====================================================

// --- 模块级状态：分组管理弹窗运行时数据 ---
let _gmOverrides = {};
let _gmAllNames = [];
let _gmPanelCtx = null;
/** @type {Set<string>} 尚未有预设的自定义空分组名（AQ-1） */
let _pendingCustomGroups = new Set();

/**
 * 构建分组数据结构（AI-0 重构：不再有 excluded）
 * @returns {{ groups: Array }}
 */
function buildGroupingData() {
    const settings = getSettings();
    _gmOverrides = { ...(settings.groupingManualOverrides || {}) };
    const groups = groupNamesBySeries(_gmAllNames, _gmOverrides);
    return { groups };
}

/**
 * 渲染分组管理 HTML（AI-0 重构 + AQ-1 增强：新建分组按钮 + 自定义标记 + 系列级 ⋯ 菜单）
 */
function renderGroupingHTML(groups) {
    // AQ-1: 收集已存在的 seriesKey，用于去重 _pendingCustomGroups
    const existingKeys = new Set(groups.map(g => normalizeSeriesKey(g.series)));

    const seriesCardsHtml = groups.map(g => {
        const itemsHtml = g.items.map(it => {
            const isManual = it.manualOverride;
            const badgeKey = isManual ? 'Grouping Manual Override' : 'Grouping Auto Detected';
            const badgeClass = isManual ? 'pas-gm-badge-manual' : 'pas-gm-badge-auto';
            return `
            <div class="pas-gm-preset" draggable="true"
                 data-preset-name="${escapeAttr(it.presetName)}"
                 data-series-key="${escapeAttr(normalizeSeriesKey(g.series))}">
                <span class="pas-gm-preset-name" title="${escapeAttr(it.presetName)}">${escapeHtml(it.presetName)}</span>
                <span class="pas-gm-badge ${badgeClass}">${escapeHtml(t(badgeKey))}</span>
                <span class="pas-gm-menu-btn" title="⋯">⋯</span>
            </div>`;
        }).join('');

        // AQ-1: 判断是否为纯自定义分组（所有成员都是手动覆盖 + 没有自动识别到这个 seriesKey 的预设）
        const isCustomGroup = g.items.length > 0 && g.items.every(it => it.manualOverride);
        const customBadgeHtml = isCustomGroup
            ? ` <i class="fa-solid fa-star pas-gm-custom-icon" title="${escapeAttr(t('Grouping Custom Badge'))}"></i><span class="pas-gm-badge pas-gm-badge-custom">${escapeHtml(t('Grouping Custom Badge'))}</span>`
            : '';

        const seriesKey = normalizeSeriesKey(g.series);
        return `
        <div class="pas-gm-series collapsed" data-series-key="${escapeAttr(seriesKey)}"${isCustomGroup ? ' data-custom-group="1"' : ''}>
            <div class="pas-gm-series-header">
                <i class="fa-solid fa-box-open pas-gm-series-icon"></i>
                <span class="pas-gm-series-name">${escapeHtml(g.series)}</span>${customBadgeHtml}
                <span class="pas-gm-series-count">${escapeHtml(t('Grouping Count', { count: g.items.length }))}</span>
                <i class="fa-solid fa-chevron-down pas-gm-chevron"></i>
            </div>
            <div class="pas-gm-series-body">
                ${itemsHtml || `<div class="pas-gm-empty">${escapeHtml(t('Grouping Empty Series'))}</div>`}
            </div>
        </div>`;
    }).join('');

    // AQ-1: 渲染 _pendingCustomGroups 中尚未有预设的空分组
    const pendingCardsHtml = [..._pendingCustomGroups]
        .filter(name => !existingKeys.has(normalizeSeriesKey(name)))
        .map(name => {
            const seriesKey = normalizeSeriesKey(name);
            return `
        <div class="pas-gm-series collapsed" data-series-key="${escapeAttr(seriesKey)}" data-custom-group="1">
            <div class="pas-gm-series-header">
                <i class="fa-solid fa-box-open pas-gm-series-icon"></i>
                <span class="pas-gm-series-name">${escapeHtml(name)}</span>
                <i class="fa-solid fa-star pas-gm-custom-icon" title="${escapeAttr(t('Grouping Custom Badge'))}"></i>
                <span class="pas-gm-badge pas-gm-badge-custom">${escapeHtml(t('Grouping Custom Badge'))}</span>
                <span class="pas-gm-series-count">${escapeHtml(t('Grouping Count', { count: 0 }))}</span>
                <i class="fa-solid fa-chevron-down pas-gm-chevron"></i>
            </div>
            <div class="pas-gm-series-body">
                <div class="pas-gm-empty">${escapeHtml(t('Grouping Empty Series'))}</div>
            </div>
        </div>`;
        }).join('');

    // "自动分组"目标区域 — AI-0 新设计（替代旧"未分组"区域）
    const autoZoneSection = `
    <div class="pas-gm-auto-zone" data-series="__auto__">
        <div class="pas-gm-auto-zone-header">
            <i class="fa-solid fa-rotate"></i>
            <span>${escapeHtml(t('Grouping Auto Zone Title'))}</span>
        </div>
        <div class="pas-gm-auto-zone-hint">${escapeHtml(t('Grouping Auto Zone Hint'))}</div>
    </div>`;

    return `
<div class="pas-gm-popup">
    <div class="pas-gm-header">
        <div class="pas-gm-header-left">
            <i class="fa-solid fa-shuffle"></i>
            <h3>${escapeHtml(t('Grouping Manage Title'))}</h3>
        </div>
        <div class="pas-gm-header-actions">
            <button class="pas-gm-new-group-btn" type="button" title="${escapeAttr(t('Grouping New Group Btn'))}">
                ${escapeHtml(t('Grouping New Group Btn'))}
            </button>
            <button class="menu_button pas-gm-reset-all-btn" type="button" title="${escapeAttr(t('Grouping Reset All'))}">
                <i class="fa-solid fa-rotate-right"></i> ${escapeHtml(t('Grouping Reset All'))}
            </button>
        </div>
    </div>
    <div class="pas-gm-desc">${escapeHtml(t('Grouping Manage Desc'))}</div>
    <div class="pas-gm-body">
        ${seriesCardsHtml}
        ${pendingCardsHtml}
    </div>
    ${autoZoneSection}
</div>`;
}

/**
 * 保存分组设置到 extensionSettings（AI-0 极简化：只保存 overrides）
 */
function saveGroupingSettings(overrides) {
    batchUpdate({ groupingManualOverrides: { ...overrides } });
    logger.debug('[saveGroupingSettings] saved, calling refreshTakeover');
    try {
        refreshTakeover({ force: true });
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

/**
 * 执行移动：将预设移到目标系列（AI-0 重构 + AQ-1：移入后清理 _pendingCustomGroups）
 */
function performMove(presetName, targetSeriesKey, container) {
    // 拖到"自动分组"区 = 恢复自动识别
    if (targetSeriesKey === '__auto__') {
        delete _gmOverrides[presetName];
        saveGroupingSettings(_gmOverrides);
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
            _gmOverrides[presetName] = pendingName || targetSeriesKey;
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
    refreshGroupingUI(container);
}

/**
 * 重置单个预设：删除手动覆盖（AI-0：恢复自动分组）
 */
function performResetOne(presetName, container) {
    delete _gmOverrides[presetName];
    saveGroupingSettings(_gmOverrides);
    refreshGroupingUI(container);
}

/**
 * 重置全部（AI-0：清空所有覆盖）
 */
function performResetAll(container) {
    for (const key of Object.keys(_gmOverrides)) delete _gmOverrides[key];
    saveGroupingSettings(_gmOverrides);
    refreshGroupingUI(container);
}

/**
 * 刷新分组 UI
 */
function refreshGroupingUI(container) {
    if (!container) return;
    const { groups } = buildGroupingData();
    const bodyEl = container.querySelector('.pas-gm-body');
    if (!bodyEl) return;
    // 重新生成 body + auto-zone 内容
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = renderGroupingHTML(groups);
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
    // 重新绑定事件
    bindGroupingEvents(container);
}

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
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));

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
                    _gmOverrides[presetName] = newName;
                    saveGroupingSettings(_gmOverrides);
                    refreshGroupingUI(container);
                } else {
                    const targetName = opt.getAttribute('data-target-name') || targetKey;
                    _gmOverrides[presetName] = targetName;
                    saveGroupingSettings(_gmOverrides);
                    refreshGroupingUI(container);
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
        toast.warning(t('Grouping New Group Prompt') + ': ' + escapeHtml(trimmed));
        return;
    }

    // 添加到待建空分组集合，刷新 UI 让其显示为空卡片
    _pendingCustomGroups.add(trimmed);
    toast.success(t('Grouping New Group Created', { name: escapeHtml(trimmed) }));
    refreshGroupingUI(container);
}

/**
 * AQ-1: 重命名系列分组（批量更新 overrides 中指向 oldSeriesKey 的值）
 */
async function onRenameSeriesGroup(oldSeriesKey, container) {
    // 找到显示名
    const { groups } = buildGroupingData();
    const group = groups.find(g => normalizeSeriesKey(g.series) === oldSeriesKey);
    const displayName = group ? group.series : oldSeriesKey;

    const inputPopup = createPopupSafe(
        t('Grouping Rename Prompt', { name: escapeHtml(displayName) }),
        'INPUT',
        { okButton: t('Confirm'), cancelButton: t('Cancel'), rows: 1 },
        displayName
    );
    let newName = null;
    if (inputPopup) {
        try { newName = await inputPopup.show(); } catch (_) {}
    } else {
        newName = window.prompt(t('Grouping Rename Prompt', { name: displayName }), displayName);
    }
    if (newName === null || newName === undefined || newName === false) return;
    const trimmed = String(newName).trim().slice(0, 120); // 限制长度防止滥用
    if (!trimmed || trimmed === displayName) return;

    // 检查是否与其他分组重名
    const targetKey = normalizeSeriesKey(trimmed);
    const duplicate = groups.some(g => normalizeSeriesKey(g.series) === targetKey && normalizeSeriesKey(g.series) !== oldSeriesKey)
        || [..._pendingCustomGroups].some(n => normalizeSeriesKey(n) === targetKey && normalizeSeriesKey(n) !== oldSeriesKey);
    if (duplicate) {
        toast.warning(t('Grouping New Group Prompt') + ': ' + escapeHtml(trimmed));
        return;
    }

    // 将所有指向 oldSeriesKey 的 overrides 更新为新名
    for (const [presetName, seriesVal] of Object.entries(_gmOverrides)) {
        if (normalizeSeriesKey(seriesVal) === oldSeriesKey) {
            _gmOverrides[presetName] = trimmed;
        }
    }

    // 也更新 _pendingCustomGroups
    for (const pName of _pendingCustomGroups) {
        if (normalizeSeriesKey(pName) === oldSeriesKey) {
            _pendingCustomGroups.delete(pName);
            _pendingCustomGroups.add(trimmed);
            break;
        }
    }

    saveGroupingSettings(_gmOverrides);
    toast.success(t('Grouping Renamed', { name: escapeHtml(trimmed) }));
    refreshGroupingUI(container);
}

/**
 * AQ-1: 删除纯自定义分组（将其中所有预设的 overrides 删除，恢复自动分组）
 */
async function onDeleteCustomGroup(seriesKey, container) {
    const { groups } = buildGroupingData();
    const group = groups.find(g => normalizeSeriesKey(g.series) === seriesKey);
    const displayName = group ? group.series : seriesKey;

    const ok = await confirmSafe(
        t('Grouping Menu Delete Group'),
        t('Grouping Delete Group Confirm', { name: escapeHtml(displayName) })
    );
    if (!ok) return;

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

    saveGroupingSettings(_gmOverrides);
    refreshGroupingUI(container);
}

/**
 * 绑定分组管理弹窗的所有事件（AI-0 重构 + AQ-1 增强：复制预设名、新建分组）
 * AW-1: 移除了系列级 ⋯ 按钮（仅保留预设级 ⋯）
 */
function bindGroupingEvents(container) {
    if (!container) return;

    // --- AQ-1: "+ 新建分组"按钮 ---
    const newGroupBtn = container.querySelector('.pas-gm-new-group-btn');
    if (newGroupBtn) {
        const newBtn = newGroupBtn.cloneNode(true);
        newGroupBtn.parentNode.replaceChild(newBtn, newGroupBtn);
        newBtn.addEventListener('click', () => onCreateCustomGroup(container));
    }

    // --- 折叠/展开系列卡片 ---
    container.querySelectorAll('.pas-gm-series-header').forEach(header => {
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);
        newHeader.addEventListener('click', (e) => {
            if (e.target.closest('.pas-gm-menu-btn')) return;
            const series = newHeader.closest('.pas-gm-series');
            if (series) series.classList.toggle('collapsed');
        });
    });

    // --- 拖拽（桌面端） ---
    container.querySelectorAll('.pas-gm-preset').forEach(presetEl => {
        const newEl = presetEl.cloneNode(true);
        presetEl.parentNode.replaceChild(newEl, presetEl);

        newEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', newEl.getAttribute('data-preset-name'));
            e.dataTransfer.effectAllowed = 'move';
            newEl.classList.add('dragging');
            container.querySelectorAll('.pas-gm-series-body').forEach(body => {
                body.classList.add('pas-gm-drop-zone');
            });
            // 也高亮"自动分组"区域
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.add('pas-gm-drop-zone');
        });

        newEl.addEventListener('dragend', () => {
            newEl.classList.remove('dragging');
            container.querySelectorAll('.pas-gm-series-body').forEach(body => {
                body.classList.remove('pas-gm-drop-zone', 'drag-over');
            });
            const autoZone = container.querySelector('.pas-gm-auto-zone');
            if (autoZone) autoZone.classList.remove('pas-gm-drop-zone', 'drag-over');
        });
    });

    // --- series-body 拖拽目标 ---
    container.querySelectorAll('.pas-gm-series-body').forEach(body => {
        body.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            body.classList.add('drag-over');
        });
        body.addEventListener('dragleave', (e) => {
            if (!body.contains(e.relatedTarget)) {
                body.classList.remove('drag-over');
            }
        });
        body.addEventListener('drop', (e) => {
            e.preventDefault();
            body.classList.remove('drag-over');
            const presetName = e.dataTransfer.getData('text/plain');
            if (!presetName) return;
            const targetSeries = body.closest('.pas-gm-series');
            const targetKey = targetSeries?.getAttribute('data-series-key');
            if (!targetKey) return;
            performMove(presetName, targetKey, container);
        });
    });

    // --- "自动分组"区域拖拽目标（AI-0 新增） ---
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
            const presetName = e.dataTransfer.getData('text/plain');
            if (!presetName) return;
            // 拖到"自动分组"= 恢复自动识别
            performMove(presetName, '__auto__', container);
        });
    }

    // --- ⋯ 菜单（AI-0 + AQ-1：新增"复制预设名"） ---
    container.querySelectorAll('.pas-gm-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            container.querySelectorAll('.pas-gm-context-menu').forEach(m => m.remove());

            const presetEl = btn.closest('.pas-gm-preset');
            const presetName = presetEl?.getAttribute('data-preset-name');
            if (!presetName) return;

            const isManual = !!_gmOverrides[presetName];

            const menu = document.createElement('div');
            menu.className = 'pas-gm-context-menu';
            menu.innerHTML = `
                <div class="pas-gm-ctx-item" data-action="move">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i> ${escapeHtml(t('Grouping Menu Move To'))}
                </div>
                ${isManual ? `<div class="pas-gm-ctx-item" data-action="reset">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(t('Grouping Menu Reset Auto'))}
                </div>` : ''}
                <div class="pas-gm-ctx-separator"></div>
                <div class="pas-gm-ctx-item" data-action="copy-name">
                    <i class="fa-solid fa-copy"></i> ${escapeHtml(t('Grouping Menu Copy Name'))}
                </div>
            `;

            const rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.visibility = 'hidden';
            document.body.appendChild(menu);
            const menuWidth = menu.offsetWidth || 150;
            const menuHeight = menu.offsetHeight || 120;
            let menuLeft = rect.left - menuWidth;
            menuLeft = Math.max(8, Math.min(menuLeft, window.innerWidth - menuWidth - 8));
            let menuTop = rect.bottom + 4;
            menuTop = Math.min(menuTop, window.innerHeight - menuHeight - 8);
            menu.style.left = `${menuLeft}px`;
            menu.style.top = `${menuTop}px`;
            menu.style.visibility = '';

            menu.querySelectorAll('.pas-gm-ctx-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const action = item.getAttribute('data-action');
                    menu.remove();
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
                });
            });

            const closeMenu = (ev) => {
                if (!menu.contains(ev.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu, true);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
        });
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

/**
 * 打开"管理分组"弹窗 — AI-0 重构版
 * 以系列卡片为核心视图，支持拖拽、⋯ 菜单、右键等操作。
 * 删除"未分组"概念，新增"自动分组"目标区域。
 *
 * @param {object} panelCtx
 */
export async function showGroupingManager(panelCtx) {
    if (_groupingManagerPopup) return;
    _gmPanelCtx = panelCtx;
    _pendingCustomGroups.clear(); // AQ-1: 每次打开弹窗清空临时空分组

    // AK-1 重构：只使用 getAllPresetNames() 作为唯一数据源
    // 不再从快照补充——旧逻辑因为 getAllPresetNames() 返回数字索引导致
    // 快照中的真实预设名全被当作"额外"名字加入，造成重复和混乱。
    // 分组管理器只管理当前存在的预设，已删除预设不在此显示。
    _gmAllNames = [];
    try {
        const names = getAllPresetNames();
        if (Array.isArray(names)) {
            const dedup = new Set();
            for (const n of names) {
                if (!n || typeof n !== 'string') continue;
                const lk = n.toLowerCase();
                if (!dedup.has(lk)) {
                    dedup.add(lk);
                    _gmAllNames.push(n);
                }
            }
        }
    } catch (e) {
        logger.warn('[showGroupingManager] getAllPresetNames failed:', e);
    }

    _gmAllNames.sort((a, b) => a.localeCompare(b));
    logger.debug(`[showGroupingManager] ${_gmAllNames.length} presets from getAllPresetNames()`);

    if (_gmAllNames.length === 0) {
        toast.info(t('Grouping Empty Series'));
        return;
    }

    const { groups } = buildGroupingData();
    const html = renderGroupingHTML(groups);

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
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));

    const container = document.querySelector('.pas-gm-popup');
    if (container) {
        bindGroupingEvents(container);

        // 重置全部按钮
        const resetAllBtn = container.querySelector('.pas-gm-reset-all-btn');
        if (resetAllBtn) {
            resetAllBtn.addEventListener('click', async () => {
                const ok = await confirmSafe(
                    t('Grouping Reset All'),
                    t('Grouping Reset All Confirm')
                );
                if (ok) performResetAll(container);
            });
        }
    }

    await promise;
    _groupingManagerPopup = null;

    // 弹窗关闭后刷新面板数据
    if (_gmPanelCtx) {
        try { await _gmPanelCtx.refreshData(); } catch (_) {}
    }
    _gmPanelCtx = null;
}

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
        updateSetting('groupingFirstScanDone', true);
        return;
    }

    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const groups = groupNamesBySeries(names, overrides);
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
