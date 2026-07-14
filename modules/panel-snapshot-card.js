import { TRIGGER_LABEL_KEYS, formatBytes } from './history-store.js';
import { t } from './compatibility.js';
import { renderSummary, escapeHtml, escapeAttr, formatTime } from './panel-summary.js';
import { getSnapshotDiagnostics, getSnapshotSummary } from './core/snapshot-diagnostics.js';

/** Render one recovery point and its complete action surface. */
export function renderSnapshotCard(snapshot, panelCtx) {
    const state = panelCtx.state();
    const triggerLabel = t(TRIGGER_LABEL_KEYS[snapshot.trigger] || 'Trigger Auto');
    const id = escapeAttr(snapshot.id);
    const diagnostics = getSnapshotDiagnostics(snapshot);
    const summaryHtml = renderSummary(getSnapshotSummary(snapshot));
    const isPinned = !!snapshot.pinned;
    const isA = state.diffSel.a === snapshot.id;
    const isB = state.diffSel.b === snapshot.id;
    const customName = (snapshot.name || '').trim();
    const cardClass = [
        'pas-card',
        `pas-card-trigger-${escapeAttr(snapshot.trigger)}`,
        isPinned ? 'pas-card-pinned' : '',
        isA ? 'pas-card-selected-a' : '',
        isB ? 'pas-card-selected-b' : '',
    ].filter(Boolean).join(' ');
    const pinTitle = isPinned ? t('Unpin Snapshot') : t('Pin Snapshot');
    const aTitle = isA ? t('Diff Clear A') : t('Diff Set A');
    const bTitle = isB ? t('Diff Clear B') : t('Diff Set B');
    const statusKey = `Diagnostic Status ${diagnostics.saveStatus}`;
    const translatedStatus = t(statusKey);
    const statusLabel = translatedStatus === statusKey ? diagnostics.saveStatus : translatedStatus;
    const diagnosticsTitle = diagnostics.transactionId
        ? `${t('Diagnostic Transaction ID')}: ${diagnostics.transactionId}`
        : t('Diagnostic Details');
    const schemaBadge = diagnostics.schemaVersion >= 2
        ? `<span class="pas-schema-badge" title="${escapeAttr(diagnosticsTitle)}">v${diagnostics.schemaVersion} · ${escapeHtml(statusLabel)}</span>`
        : '';
    const deleteAttributes = isPinned
        ? `disabled title="${escapeAttr(t('Cannot Delete Pinned'))}"`
        : `title="${escapeAttr(t('Delete'))}"`;

    return `
<div class="${cardClass}" data-snapshot-id="${id}">
    <div class="pas-card-main">
        <div class="pas-card-title-row">
            ${isPinned ? `<i class="fa-solid fa-thumbtack pas-card-pin-icon" title="${escapeAttr(t('Pinned'))}"></i>` : ''}
            ${customName ? `<span class="pas-card-name-custom" title="${escapeAttr(customName)}">${escapeHtml(customName)}</span>` : ''}
            <span class="pas-card-time">${formatTime(snapshot.timestamp)}</span>
            <span class="pas-tag pas-tag-${escapeAttr(snapshot.trigger)}">${escapeHtml(triggerLabel)}</span>
        </div>
        ${summaryHtml}
        <div class="pas-card-meta">
            <span class="pas-card-size">${formatBytes(snapshot.size || 0)}</span>
            <span class="pas-divider">·</span>
            <span class="pas-card-hash" title="${escapeAttr(t('Diagnostic Canonical Hash'))}">${escapeHtml(diagnostics.canonicalHash)}</span>
            ${schemaBadge ? `<span class="pas-divider">·</span>${schemaBadge}` : ''}
        </div>
    </div>
    <div class="pas-card-actions">
        <div class="pas-card-primary-actions">
            <button class="pas-btn-action pas-btn-diff-a ${isA ? 'pas-btn-diff-active' : ''}" data-id="${id}" data-action="diff-a" title="${escapeAttr(aTitle)}" type="button" aria-label="${escapeAttr(aTitle)}"><span style="font-weight:700;font-size:0.85em;">A</span></button>
            <button class="pas-btn-action pas-btn-diff-b ${isB ? 'pas-btn-diff-active' : ''}" data-id="${id}" data-action="diff-b" title="${escapeAttr(bTitle)}" type="button" aria-label="${escapeAttr(bTitle)}"><span style="font-weight:700;font-size:0.85em;">B</span></button>
            <button class="pas-btn-action pas-btn-restore" data-id="${id}" data-action="restore" title="${escapeAttr(t('Restore'))}" type="button" aria-label="${escapeAttr(t('Restore'))}"><i class="fa-solid fa-rotate-left"></i><span class="pas-action-label">${escapeHtml(t('Restore'))}</span></button>
            <button class="pas-btn-action pas-btn-view" data-id="${id}" data-action="view" title="${escapeAttr(t('View'))}" type="button" aria-label="${escapeAttr(t('View'))}"><i class="fa-solid fa-eye"></i><span class="pas-action-label">${escapeHtml(t('View'))}</span></button>
        </div>
        <details class="pas-card-tools">
            <summary class="pas-card-tools-trigger" title="${escapeAttr(t('Panel Tools'))}" aria-label="${escapeAttr(t('Panel Tools'))}">
                <i class="fa-solid fa-ellipsis"></i><span class="pas-action-label">${escapeHtml(t('Panel Tools'))}</span>
            </summary>
            <div class="pas-card-tools-actions">
                <button class="pas-btn-action pas-btn-rename" data-id="${id}" data-action="rename" title="${escapeAttr(t('Rename Snapshot'))}" type="button" aria-label="${escapeAttr(t('Rename Snapshot'))}"><i class="fa-solid fa-pen"></i><span class="pas-action-label">${escapeHtml(t('Rename Snapshot'))}</span></button>
                <button class="pas-btn-action pas-btn-pin ${isPinned ? 'pas-btn-pin-active' : ''}" data-id="${id}" data-action="pin" title="${escapeAttr(pinTitle)}" type="button" aria-label="${escapeAttr(pinTitle)}"><i class="fa-solid fa-thumbtack"></i><span class="pas-action-label">${escapeHtml(pinTitle)}</span></button>
                <button class="pas-btn-action pas-btn-export-preset" data-id="${id}" data-action="export" title="${escapeAttr(t('Export Preset'))}" type="button" aria-label="${escapeAttr(t('Export Preset'))}"><i class="fa-solid fa-file-export"></i><span class="pas-action-label">${escapeHtml(t('Export Preset'))}</span></button>
                <button class="pas-btn-action pas-btn-delete" data-id="${id}" data-action="delete" ${deleteAttributes} type="button" aria-label="${escapeAttr(t('Delete'))}"><i class="fa-solid fa-trash"></i><span class="pas-action-label">${escapeHtml(t('Delete'))}</span></button>
            </div>
        </details>
    </div>
</div>`;
}
