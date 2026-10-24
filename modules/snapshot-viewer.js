import { logger } from './logger.js';
import { getSnapshotById, TRIGGER_LABEL_KEYS, formatBytes } from './history-store.js';
import { sanitizePresetForExport, createPopupSafe, toast, t } from './compatibility.js';
import { escapeHtml, escapeAttr, formatTime, renderSummary } from './panel-summary.js';
import { getSnapshotDiagnostics, getSnapshotSummary } from './core/snapshot-diagnostics.js';
import { createMountedResources } from './core/mounted-resources.js';

let activePopup = null;
let activeOwner = null;
let sequence = 0;

export function cleanupSnapshotViewer() {
    sequence++;
    activeOwner?.destroy();
    activeOwner = null;
    const popup = activePopup;
    activePopup = null;
    try { popup?.completeCancelled?.(); } catch (_) {}
}

function renderDiagnostics(snapshot) {
    const diagnostics = getSnapshotDiagnostics(snapshot);
    const statusKey = `Diagnostic Status ${diagnostics.saveStatus}`;
    const translatedStatus = t(statusKey);
    const status = translatedStatus === statusKey ? diagnostics.saveStatus : translatedStatus;
    const none = t('Diagnostic None');
    const paths = diagnostics.changedPaths.length > 0
        ? diagnostics.changedPaths.map(path => `<code>${escapeHtml(path)}</code>`).join('')
        : `<span>${escapeHtml(none)}</span>`;
    const row = (label, value) => `<div class="pas-diagnostic-row">
        <dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value || none)}</dd>
    </div>`;
    return `<details class="pas-view-diagnostics" open>
        <summary><i class="fa-solid fa-shield-halved"></i> ${escapeHtml(t('Diagnostic Details'))}</summary>
        <dl class="pas-diagnostic-grid">
            ${row('Diagnostic Schema Version', `v${diagnostics.schemaVersion}`)}
            ${row('Diagnostic Save Status', status)}
            ${row('Diagnostic Transaction ID', diagnostics.transactionId)}
            ${row('Diagnostic Parent Snapshot', diagnostics.parentSnapshotId)}
            ${row('Diagnostic Canonical Hash', diagnostics.canonicalHash)}
            <div class="pas-diagnostic-row pas-diagnostic-paths">
                <dt>${escapeHtml(t('Diagnostic Changed Paths'))}</dt><dd>${paths}</dd>
            </div>
        </dl>
    </details>`;
}

export async function showSnapshotViewer(snapshotId) {
    cleanupSnapshotViewer();
    const instance = sequence;
    const snapshot = await getSnapshotById(snapshotId);
    if (instance !== sequence) return;
    if (!snapshot) return toast.error(t('Snapshot Not Found'));
    const safePreset = sanitizePresetForExport(snapshot.preset, { apiId: snapshot.apiId });
    const json = JSON.stringify(safePreset, null, 2);
    const triggerLabel = t(TRIGGER_LABEL_KEYS[snapshot.trigger] || 'Trigger Auto');
    const html = `
<div class="pas-view-popup" data-pas-view-instance="${instance}">
    <div class="pas-view-header">
        <div class="pas-view-title">
            <i class="fa-solid fa-eye"></i>
            <h4>${escapeHtml(snapshot.presetName)}</h4>
        </div>
        <div class="pas-view-meta">
            <span><i class="fa-regular fa-clock"></i> ${escapeHtml(formatTime(snapshot.timestamp))}</span>
            <span class="pas-view-meta-divider">&#183;</span>
            <span class="pas-tag pas-tag-${escapeAttr(snapshot.trigger)}">${escapeHtml(triggerLabel)}</span>
            <span class="pas-view-meta-divider">&#183;</span>
            <span><i class="fa-solid fa-database"></i> ${formatBytes(snapshot.size || 0)}</span>
        </div>
    </div>
    <div class="pas-view-summary">${renderSummary(getSnapshotSummary(snapshot), { compact: false })}</div>
    ${renderDiagnostics(snapshot)}
    <pre class="pas-view-json"><code>${escapeHtml(json)}</code></pre>
    <div class="pas-view-actions">
        <button class="menu_button pas-view-copy-btn" type="button">
            <i class="fa-solid fa-copy"></i> ${escapeHtml(t('Copy JSON'))}
        </button>
    </div>
</div>`;
    const popup = createPopupSafe(html, 'DISPLAY', {
        wide: true, large: true, allowVerticalScrolling: true,
        okButton: false, cancelButton: t('Close'),
    });
    if (!popup) {
        logger.error('[Snapshot viewer] Popup API unavailable');
        toast.error(t('Snapshot Not Found'));
        return;
    }
    const owner = createMountedResources();
    activePopup = popup;
    activeOwner = owner;
    const settled = () => {
        owner.destroy();
        if (activePopup === popup) {
            activePopup = null;
            activeOwner = null;
        }
    };
    try {
        Promise.resolve(popup.show()).then(settled, settled);
        let attempts = 0;
        const bind = () => {
            const root = document.querySelector(`[data-pas-view-instance="${instance}"]`);
            const button = root?.querySelector('.pas-view-copy-btn');
            if (!button) {
                if (++attempts < 10) owner.schedule(bind, 50);
                return;
            }
            owner.listen(button, 'click', async () => {
                try {
                    await navigator.clipboard.writeText(json);
                    if (owner.active) toast.success(t('Copied'));
                } catch (_) {
                    if (owner.active) toast.error(t('Copy Failed'));
                }
            });
        };
        owner.schedule(bind, 0);
    } catch (error) {
        settled();
        logger.error('Snapshot viewer failed:', error);
    }
}
