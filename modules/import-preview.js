import {
    confirmSafe,
    createPopupSafe,
    escapeHtml,
    t,
} from './compatibility.js';
import { createMountedResources } from './core/mounted-resources.js';

let previewSequence = 0;
const previewBindings = new WeakMap();

function translated(options, key, vars = {}) {
    return options.escapeHtml(options.t(key, vars));
}

export function renderHistoryImportPreview(preview, options = {}) {
    const renderOptions = {
        t: options.t || t,
        escapeHtml: options.escapeHtml || escapeHtml,
    };
    const text = (key, vars) => translated(renderOptions, key, vars);
    const mergeAvailable = preview?.modes?.merge?.available === true;
    const replace = preview?.modes?.replace || {};
    const merge = preview?.modes?.merge || {};
    const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts : [];
    const conflictRows = conflicts.slice(0, 3).map(conflict => `
        <li><code>${renderOptions.escapeHtml(conflict.key)}</code> · ${renderOptions.escapeHtml(conflict.snapshotId)}</li>`).join('');
    const remainingConflicts = Math.max(0, conflicts.length - 3);
    const schemaVersion = preview?.schemaVersion ?? renderOptions.t('Import Preview Unknown Version');
    const instance = options.instance;
    const radioName = instance === undefined ? 'pas-import-mode' : `pas-import-mode-${instance}`;
    const instanceAttribute = instance === undefined ? '' : ` data-pas-import-instance="${renderOptions.escapeHtml(instance)}"`;

    return `
<div class="pas-import-preview"${instanceAttribute} data-conflict-count="${Number(preview?.conflictCount) || 0}">
    <div class="pas-import-preview-heading">
        <span class="pas-import-preview-icon" aria-hidden="true"><i class="fa-solid fa-file-shield"></i></span>
        <div>
            <h3>${text('Import Preview Title')}</h3>
            <p>${text('Import Preview Verified')}</p>
        </div>
    </div>

    <div class="pas-import-preview-stats" aria-label="${text('Import Preview File Summary')}">
        <span>${text('Import Preview Presets', { count: preview?.presetCount ?? 0 })}</span>
        <span>${text('Import Preview Snapshots', { count: preview?.snapshotCount ?? 0 })}</span>
        <span>${text('Import Preview Format', { version: preview?.sourceVersion ?? '?' })}</span>
        <span>${text('Import Preview Schema', { version: schemaVersion })}</span>
    </div>

    <p class="pas-import-preview-overlap">
        ${text('Import Preview Overlap', {
            presets: preview?.overlappingPresetCount ?? 0,
            duplicates: preview?.duplicateSnapshotCount ?? 0,
        })}
    </p>

    ${conflicts.length > 0 ? `
    <div class="pas-import-preview-alert" role="alert">
        <strong>${text('Import Preview Conflicts', { count: conflicts.length })}</strong>
        <p>${text('Import Preview Conflict Detail')}</p>
        <ul>${conflictRows}${remainingConflicts > 0 ? `<li>${text('Import Preview More Conflicts', { count: remainingConflicts })}</li>` : ''}</ul>
    </div>` : ''}

    <fieldset class="pas-import-preview-modes">
        <legend>${text('Import Preview Choose Mode')}</legend>
        <label class="pas-import-mode-card${mergeAvailable ? ' is-selected' : ' is-disabled'}">
            <input type="radio" name="${renderOptions.escapeHtml(radioName)}" value="merge"${mergeAvailable ? ' checked' : ' disabled'}>
            <span class="pas-import-mode-copy">
                <strong>${text('Import Preview Merge')}</strong>
                <span>${text(mergeAvailable ? 'Import Preview Merge Detail' : 'Import Preview Merge Blocked', {
                    count: merge.importedSnapshotCount ?? 0,
                })}</span>
                ${mergeAvailable ? `<small>${text('Import Preview Result', {
                    presets: merge.finalPresetCount ?? 0,
                    snapshots: merge.finalSnapshotCount ?? 0,
                })}</small>` : ''}
            </span>
        </label>

        <label class="pas-import-mode-card pas-import-mode-danger">
            <input type="radio" name="${renderOptions.escapeHtml(radioName)}" value="replace">
            <span class="pas-import-mode-copy">
                <strong>${text('Import Preview Replace')}</strong>
                <span>${text('Import Preview Replace Detail')}</span>
                <small>${text('Import Preview Replace Removes', { count: replace.removedPresetCount ?? 0 })}</small>
            </span>
        </label>
    </fieldset>

    <div class="pas-import-preview-actions">
        <button type="button" class="menu_button pas-import-confirm" data-import-confirm${mergeAvailable ? '' : ' disabled'}>
            <i class="fa-solid fa-file-import" aria-hidden="true"></i>
            <span>${text('Import Preview Confirm')}</span>
        </button>
    </div>
</div>`;
}

async function chooseFallback(preview) {
    if (!preview?.modes?.merge?.available) {
        await confirmSafe(
            escapeHtml(t('Import Preview Title')),
            `<div>${escapeHtml(t('Import Preview Merge Blocked'))}</div>
             <div style="margin-top:8px;opacity:.75">${escapeHtml(t('Import Preview No Changes'))}</div>`,
        );
        return null;
    }
    const ok = await confirmSafe(
        escapeHtml(t('Import Preview Title')),
        `<div>${escapeHtml(t('Import Preview Fallback Summary', {
            presets: preview.presetCount,
            snapshots: preview.snapshotCount,
        }))}</div>
         <div style="margin-top:8px;opacity:.75">${escapeHtml(t('Import Preview Merge Detail', {
            count: preview.modes.merge.importedSnapshotCount,
        }))}</div>`,
    );
    return ok ? 'merge' : null;
}

function findMountedImportPreview(instance, owner) {
    return new Promise(resolve => {
        const release = owner.own(() => resolve(null));
        let attempts = 0;
        const check = () => {
            const root = document.querySelector(`[data-pas-import-instance="${instance}"]`);
            if (root || ++attempts >= 8) {
                release();
                resolve(root || null);
            } else {
                owner.schedule(check, 25);
            }
        };
        owner.schedule(check, 0);
    });
}

export function bindHistoryImportPreview(root, { onConfirm = () => {}, translate = t } = {}) {
    if (!root || typeof root.querySelector !== 'function') {
        throw new TypeError('Import preview root is required');
    }
    previewBindings.get(root)?.destroy();
    const owner = createMountedResources();
    const confirm = root.querySelector('[data-import-confirm]');
    const confirmLabel = confirm?.querySelector('span');
    const radios = [...root.querySelectorAll('input[type="radio"]')];
    let selectedMode = null;

    const sync = () => {
        selectedMode = root.querySelector('input[type="radio"]:checked')?.value || null;
        for (const card of root.querySelectorAll('.pas-import-mode-card')) {
            card.classList.toggle('is-selected', card.querySelector('input')?.checked === true);
        }
        if (confirm) {
            confirm.disabled = !selectedMode;
            confirm.classList.toggle('pas-import-confirm-danger', selectedMode === 'replace');
        }
        if (confirmLabel) {
            confirmLabel.textContent = translate(selectedMode === 'replace'
                ? 'Import Preview Replace Confirm'
                : 'Import Preview Confirm');
        }
        return selectedMode;
    };
    const handleConfirm = () => {
        const mode = sync();
        if (mode) onConfirm(mode);
    };

    for (const radio of radios) owner.listen(radio, 'change', sync);
    owner.listen(confirm, 'click', handleConfirm);
    sync();

    const controller = {
        getSelectedMode: () => selectedMode,
        destroy() {
            owner.destroy();
            if (previewBindings.get(root) === controller) previewBindings.delete(root);
        },
    };
    previewBindings.set(root, controller);
    return controller;
}

export async function chooseHistoryImportMode(preview, { signal } = {}) {
    if (signal?.aborted) return null;
    const fallback = async () => {
        const mode = await chooseFallback(preview);
        return signal?.aborted ? null : mode;
    };
    const instance = ++previewSequence;
    const html = renderHistoryImportPreview(preview, { instance });
    const popup = createPopupSafe(html, 'DISPLAY', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: t('Cancel'),
    });
    if (!popup) return fallback();

    const owner = createMountedResources();
    const closed = new Promise(resolve => owner.own(resolve));
    owner.own(() => {
        try { popup.completeCancelled?.(); } catch (_) {}
    });
    owner.listen(signal, 'abort', () => owner.destroy());
    let showPromise;
    try {
        showPromise = Promise.resolve(popup.show());
        showPromise.then(
            () => owner.destroy(),
            () => owner.destroy(),
        );
    } catch (_) {
        owner.destroy();
        return signal?.aborted ? null : fallback();
    }

    const root = await findMountedImportPreview(instance, owner);
    if (!root) {
        const wasActive = owner.active;
        owner.destroy();
        return wasActive && !signal?.aborted ? fallback() : null;
    }

    let confirmed = false;
    let selectedMode = null;
    const controller = bindHistoryImportPreview(root, { onConfirm: mode => {
        if (!owner.active) return;
        selectedMode = mode;
        confirmed = true;
        try {
            if (typeof popup.completeCancelled === 'function') popup.completeCancelled();
            else popup.complete?.(true);
        } catch (_) {}
    } });
    owner.own(() => controller.destroy());

    await Promise.race([showPromise.catch(() => {}), closed]);
    owner.destroy();
    return confirmed && !signal?.aborted ? selectedMode : null;
}
