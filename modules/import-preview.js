import {
    confirmSafe,
    createPopupSafe,
    escapeHtml,
    t,
} from './compatibility.js';

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

    return `
<div class="pas-import-preview" data-conflict-count="${Number(preview?.conflictCount) || 0}">
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
            <input type="radio" name="pas-import-mode" value="merge"${mergeAvailable ? ' checked' : ' disabled'}>
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
            <input type="radio" name="pas-import-mode" value="replace">
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
            t('Import Preview Title'),
            `<div>${escapeHtml(t('Import Preview Merge Blocked'))}</div>
             <div style="margin-top:8px;opacity:.75">${escapeHtml(t('Import Preview No Changes'))}</div>`,
        );
        return null;
    }
    const ok = await confirmSafe(
        t('Import Preview Title'),
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

function afterPopupMount() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame !== 'function') {
            setTimeout(resolve, 0);
            return;
        }
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

async function findMountedImportPreview(isPopupSettled) {
    for (let attempt = 0; attempt < 8; attempt++) {
        await afterPopupMount();
        const roots = document.querySelectorAll('.pas-import-preview');
        if (roots.length > 0) return roots[roots.length - 1];
        if (isPopupSettled()) return null;
    }
    return null;
}

export function bindHistoryImportPreview(root, { onConfirm = () => {}, translate = t } = {}) {
    if (!root || typeof root.querySelector !== 'function') {
        throw new TypeError('Import preview root is required');
    }
    const confirm = root.querySelector('[data-import-confirm]');
    const confirmLabel = confirm?.querySelector('span');
    const radios = [...root.querySelectorAll('input[name="pas-import-mode"]')];
    let selectedMode = null;

    const sync = () => {
        selectedMode = root.querySelector('input[name="pas-import-mode"]:checked')?.value || null;
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

    for (const radio of radios) radio.addEventListener('change', sync);
    confirm?.addEventListener('click', handleConfirm);
    sync();

    return {
        getSelectedMode: () => selectedMode,
        destroy() {
            for (const radio of radios) radio.removeEventListener('change', sync);
            confirm?.removeEventListener('click', handleConfirm);
        },
    };
}

export async function chooseHistoryImportMode(preview) {
    const html = renderHistoryImportPreview(preview);
    const popup = createPopupSafe(html, 'DISPLAY', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: t('Cancel'),
    });
    if (!popup) return chooseFallback(preview);

    let showPromise;
    let popupSettled = false;
    try {
        showPromise = Promise.resolve(popup.show());
        showPromise.then(
            () => { popupSettled = true; },
            () => { popupSettled = true; },
        );
    } catch (_) {
        return chooseFallback(preview);
    }

    const root = await findMountedImportPreview(() => popupSettled);
    if (!root) {
        if (popupSettled) return null;
        try { popup.completeCancelled?.(); } catch (_) {}
        try { await showPromise; } catch (_) {}
        return chooseFallback(preview);
    }

    let confirmed = false;
    let selectedMode = null;
    const controller = bindHistoryImportPreview(root, { onConfirm: mode => {
        selectedMode = mode;
        confirmed = true;
        try {
            if (typeof popup.completeCancelled === 'function') popup.completeCancelled();
            else popup.complete?.(true);
        } catch (_) {}
    } });

    try { await showPromise; } catch (_) { return null; }
    finally { controller.destroy(); }
    return confirmed ? selectedMode : null;
}
