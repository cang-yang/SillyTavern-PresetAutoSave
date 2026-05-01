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
    TRIGGER_LABEL_KEYS, formatBytes,
} from './history-store.js';
import {
    confirmSafe, toast, t,
    savePresetSafe, selectPresetSafe,
    getAllPresetNames,
    deletePresetSafe,
    createPopupSafe,
} from './compatibility.js';
import { saveNow } from './auto-save.js';
import { showDiffPopup } from './diff-viewer.js';
import {
    parsePresetName,
    groupNamesBySeries,
} from './preset-grouping.js';
import {
    escapeHtml, formatTime,
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
// 工具函数
// =====================================================
function escapeAttr(s) {
    return escapeHtml(s);
}

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
        await onClearPreset(key, panelCtx);
        return;
    }

    // 1.1) "设为默认应用版本"按钮（图钉）
    if (setDefaultBtn) {
        e.preventDefault();
        e.stopPropagation();
        const presetName = setDefaultBtn.getAttribute('data-preset-name');
        const seriesKey = setDefaultBtn.getAttribute('data-series-key');
        if (presetName && seriesKey) {
            await onToggleSeriesDefault(seriesKey, presetName, panelCtx);
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
        case 'delete':  await onDelete(id, panelCtx);  break;
        case 'rename':  await onRename(id, panelCtx);  break;
        case 'pin':     await onTogglePin(id, panelCtx); break;
        case 'diff-a':  onSetDiff(id, 'a', panelCtx);  break;
        case 'diff-b':  onSetDiff(id, 'b', panelCtx);  break;
        default:
            // 兼容旧 class 路由
            if (btn.classList.contains('pas-btn-restore')) await onRestore(id, panelCtx);
            else if (btn.classList.contains('pas-btn-view')) await onView(id);
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

async function onRestore(snapshotId, panelCtx) {
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
        await panelCtx.refreshData();
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
    await panelCtx.refreshData();
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
    panelCtx.renderListTab();
}

/**
 * @param {object} panelCtx
 */
export function onClearDiff(panelCtx) {
    const state = panelCtx.state();
    state.diffSel.a = null;
    state.diffSel.b = null;
    updateDiffBar(panelCtx);
    panelCtx.renderListTab();
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
// 分组管理弹窗（手动覆盖 + 排除）
// =====================================================

/**
 * 打开"管理分组"弹窗：列出所有出现过的预设名，
 * 让用户手动指定每个预设属于哪个系列（或标记为"不分组"）。
 *
 * 数据来源：
 *   1. 当前所有快照的 (apiId, presetName)
 *   2. SillyTavern 当前已加载的预设名（getAllPresetNames）
 *
 * @param {object} panelCtx
 */
export async function showGroupingManager(panelCtx) {
    if (_groupingManagerPopup) return;

    const state = panelCtx.state();

    // 收集所有候选名（快照中出现过 + 当前预设管理器列表）
    const fromSnapshots = new Set(state.snapshots.map(s => s.presetName).filter(Boolean));
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

    const html = buildGroupingManagerHTML(grouped, sortedNames, overrides, excluded);

    _groupingManagerPopup = createPopupSafe(html, 'DISPLAY', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: t('Grouping Manage Save'),
        cancelButton: t('Cancel'),
    });

    if (!_groupingManagerPopup) {
        logger.error('[showGroupingManager] createPopupSafe returned null');
        toast.error(t('Grouping Empty Series'));
        return;
    }

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
        await panelCtx.refreshData();
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

    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const excluded = settings.groupingExcluded || {};
    const groups = groupNamesBySeries(names, overrides, excluded);
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

    _firstScanWizardPopup = createPopupSafe(html, 'CONFIRM', {
        okButton: t('Grouping First Scan Confirm'),
        cancelButton: t('Grouping First Scan Skip'),
    });

    if (!_firstScanWizardPopup) {
        logger.error('[showGroupingFirstScanWizard] createPopupSafe returned null');
        return;
    }

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
