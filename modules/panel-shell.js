import { SAVE_STATUS_STATES, saveStatusLabelKey } from './core/save-status.js';

/**
 * Pure history-panel shell renderer.
 * Keeping the shell free of DOM and application imports makes its semantic
 * contract cheap to test and keeps history-panel.js focused on orchestration.
 */
export function buildPanelHTML({ t, escapeHtml, escapeAttr, saveStatus = 'idle', saveStatusLabel = null }) {
    const text = (key, vars) => escapeHtml(t(key, vars));
    const attr = (key) => escapeAttr(t(key));
    const safeStatus = SAVE_STATUS_STATES.includes(saveStatus) ? saveStatus : 'idle';
    const statusText = escapeHtml(saveStatusLabel ?? t(saveStatusLabelKey(safeStatus)));

    return `
<div class="pas-panel">
    <header class="pas-panel-header">
        <div class="pas-panel-brand">
            <span class="pas-panel-mark" aria-hidden="true"><i class="fa-solid fa-clock-rotate-left"></i></span>
            <div class="pas-panel-heading">
                <h3>${text('Preset history records')}</h3>
                <div class="pas-panel-status" role="status">
                    <span class="pas-status-dot pas-status-${safeStatus}" data-pas-element="panel-status-dot" data-status="${safeStatus}" aria-hidden="true"></span>
                    <span data-pas-status-label>${statusText}</span>
                    <span class="pas-panel-stats" id="pas-panel-stats"></span>
                </div>
            </div>
        </div>
        <div class="pas-header-actions">
            <button class="pas-btn-snap pas-primary-action" type="button" title="${attr('Snapshot Now Title')}">
                <span class="pas-control-face"><i class="fa-solid fa-camera" aria-hidden="true"></i><span>${text('Snapshot Short')}</span></span>
            </button>
            <div class="pas-tools">
                <button class="pas-tools-trigger" type="button" aria-label="${attr('Panel Tools')}" title="${attr('Panel Tools')}" aria-haspopup="menu" aria-expanded="false" aria-controls="pas-tools-menu">
                    <span class="pas-control-face"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i><span>${text('Panel Tools')}</span></span>
                </button>
                <div class="pas-tools-menu" id="pas-tools-menu" role="menu" hidden>
                    <div class="pas-tools-section" role="group" aria-label="${attr('History Group')}">
                        <button class="pas-tool-item pas-btn-batch-toggle" role="menuitem" type="button"><i class="fa-solid fa-check-double"></i><span>${text('Batch Manage Btn')}</span></button>
                        <button class="pas-tool-item pas-btn-manage-grouping" role="menuitem" type="button"><i class="fa-solid fa-folder-tree"></i><span>${text('Grouping Manage')}</span></button>
                        <button class="pas-tool-item pas-btn-rescan-grouping" role="menuitem" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${text('Grouping Rescan')}</span></button>
                        <button class="pas-tool-item pas-btn-expand-all" role="menuitem" type="button"><i class="fa-solid fa-angles-down"></i><span>${text('Expand All')}</span></button>
                        <button class="pas-tool-item pas-btn-collapse-all" role="menuitem" type="button"><i class="fa-solid fa-angles-up"></i><span>${text('Collapse All')}</span></button>
                    </div>
                    <div class="pas-tools-section" role="group" aria-label="${attr('Advanced Group')}">
                        <button class="pas-tool-item pas-btn-export" role="menuitem" type="button"><i class="fa-solid fa-download"></i><span>${text('Export Backup')}</span></button>
                        <button class="pas-tool-item pas-btn-import" role="menuitem" type="button"><i class="fa-solid fa-upload"></i><span>${text('Import Backup')}</span></button>
                        <button class="pas-tool-item pas-btn-cleanup" role="menuitem" type="button"><i class="fa-solid fa-broom"></i><span>${text('Cleanup')}</span></button>
                        <button class="pas-tool-item pas-tool-danger pas-btn-purge" role="menuitem" type="button"><i class="fa-solid fa-shield-halved"></i><span>${text('Purge Corrupt')}</span></button>
                    </div>
                </div>
            </div>
        </div>
    </header>

    <nav class="pas-panel-tabs" role="tablist" aria-label="${attr('Preset history')}">
        ${tab('list', 'fa-list', 'Records', 'pas-list-badge', true, text, attr)}
        ${tab('logs', 'fa-bug', 'Logs', 'pas-log-badge', false, text, attr)}
        ${tab('settings', 'fa-gear', 'Settings', '', false, text, attr)}
    </nav>

    <main class="pas-panel-body">
        <section class="pas-tab-content pas-tab-content-active" id="pas-panel-list" data-content="list" role="tabpanel" aria-labelledby="pas-tab-list">
            <div class="pas-toolbar">
                <div class="pas-toolbar-primary">
                    <label class="pas-search-wrap">
                        <span class="pas-visually-hidden">${text('Search preset...')}</span>
                        <i class="fa-solid fa-magnifying-glass pas-search-icon" aria-hidden="true"></i>
                        <input type="search" class="pas-search text_pole" placeholder="${attr('Search preset...')}" />
                    </label>
                    <div class="pas-view-toggle" role="group" aria-label="${attr('View')}">
                        <button class="pas-view-btn pas-view-btn-series pas-view-btn-active" data-view="series" type="button" aria-label="${attr('Grouping View Series')}" aria-pressed="true" title="${attr('Grouping View Series Title')}"><i class="fa-solid fa-layer-group"></i><span>${text('Grouping View Series')}</span></button>
                        <button class="pas-view-btn pas-view-btn-flat" data-view="flat" type="button" aria-label="${attr('Grouping View Flat')}" aria-pressed="false" title="${attr('Grouping View Flat Title')}"><i class="fa-solid fa-list-ul"></i><span>${text('Grouping View Flat')}</span></button>
                    </div>
                </div>
                <div class="pas-filters" role="group" aria-label="${attr('Panel Filters')}">
                    ${filter('all', 'fa-asterisk', 'All', true, text)}
                    ${filter('current', 'fa-bullseye', 'Current Preset', false, text)}
                    ${filter('pinned', 'fa-thumbtack', 'Filter Pinned', false, text)}
                    ${filter('today', 'fa-calendar-day', 'Today', false, text)}
                    ${filter('week', 'fa-calendar-week', 'This Week', false, text)}
                </div>
                <div class="pas-diff-bar" id="pas-diff-bar" hidden>
                    <span class="pas-diff-bar-label"><i class="fa-solid fa-code-compare"></i>${text('Diff Bar Label')}</span>
                    ${diffSlot('a', text)}${diffSlot('b', text)}
                    <span class="pas-diff-bar-actions">
                        <button class="pas-mini-btn pas-mini-btn-primary pas-btn-start-diff" type="button" disabled><i class="fa-solid fa-play"></i><span>${text('Diff Start')}</span></button>
                        <button class="pas-mini-btn pas-btn-clear-diff" type="button" disabled aria-label="${attr('Diff Clear')}" title="${attr('Diff Clear')}"><i class="fa-solid fa-xmark"></i></button>
                    </span>
                </div>
            </div>
            <div class="pas-snapshot-list" aria-live="polite"></div>
            <div class="pas-batch-toolbar" id="pas-batch-toolbar" hidden>
                <button class="pas-mini-btn pas-btn-batch-select-all" type="button"><i class="fa-solid fa-check-double"></i><span>${text('Batch Select All')}</span></button>
                <button class="pas-mini-btn pas-btn-batch-deselect-all" type="button"><i class="fa-solid fa-xmark"></i><span>${text('Batch Deselect All')}</span></button>
                <span class="pas-batch-spacer"></span>
                <button class="pas-batch-delete-btn" id="pas-batch-delete-btn" type="button" disabled><i class="fa-solid fa-trash-can"></i><span>${text('Batch Delete Btn', { count: 0 })}</span></button>
            </div>
        </section>

        <section class="pas-tab-content" id="pas-panel-logs" data-content="logs" role="tabpanel" aria-labelledby="pas-tab-logs" hidden>
            <div class="pas-log-toolbar">
                <label class="pas-search-wrap"><span class="pas-visually-hidden">${text('Search logs...')}</span><i class="fa-solid fa-magnifying-glass pas-search-icon"></i><input type="search" class="pas-log-search text_pole" placeholder="${attr('Search logs...')}" /></label>
                <div class="pas-filters" role="group" aria-label="${attr('Logs')}">
                    <button class="pas-log-filter pas-filter-active" data-level="all" type="button"><span>${text('All')}</span></button>
                    <button class="pas-log-filter pas-log-filter-debug" data-level="debug" type="button"><span>DEBUG</span></button>
                    <button class="pas-log-filter pas-log-filter-info" data-level="info" type="button"><span>INFO</span></button>
                    <button class="pas-log-filter pas-log-filter-warn" data-level="warn" type="button"><span>WARN</span></button>
                    <button class="pas-log-filter pas-log-filter-error" data-level="error" type="button"><span>ERROR</span></button>
                </div>
                <div class="pas-log-actions">
                    <label class="pas-log-autoscroll" title="${attr('Auto Scroll Desc')}"><input type="checkbox" class="pas-log-autoscroll-input" checked><span>${text('Auto Scroll')}</span></label>
                    <button class="pas-mini-btn pas-btn-log-clear" type="button"><i class="fa-solid fa-broom"></i><span>${text('Clear Logs')}</span></button>
                    <button class="pas-mini-btn pas-btn-log-copy" type="button"><i class="fa-solid fa-copy"></i><span>${text('Copy')}</span></button>
                    <button class="pas-mini-btn pas-btn-log-export" type="button"><i class="fa-solid fa-download"></i><span>${text('Export')}</span></button>
                </div>
            </div>
            <div class="pas-log-view" id="pas-log-view" aria-live="polite"></div>
        </section>

        <section class="pas-tab-content" id="pas-panel-settings" data-content="settings" role="tabpanel" aria-labelledby="pas-tab-settings" hidden></section>
    </main>

    <footer class="pas-panel-footer"><span class="pas-stats" id="pas-footer-stats">—</span></footer>
</div>`;
}

function tab(name, icon, label, badgeId, active, text) {
    return `<button class="pas-tab${active ? ' pas-tab-active' : ''}" id="pas-tab-${name}" data-tab="${name}" type="button" role="tab" aria-selected="${active}" aria-controls="pas-panel-${name}" tabindex="${active ? '0' : '-1'}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${text(label)}</span>${badgeId ? `<span class="pas-tab-badge" id="${badgeId}">0</span>` : ''}</button>`;
}

function filter(name, icon, label, active, text) {
    return `<button class="pas-filter${active ? ' pas-filter-active' : ''}" data-filter="${name}" type="button" aria-pressed="${active}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${text(label)}</span></button>`;
}

function diffSlot(name, text) {
    return `<span class="pas-diff-bar-slot pas-diff-slot-${name}" id="pas-diff-slot-${name}"><span class="pas-diff-bar-slot-tag">${name.toUpperCase()}</span><span class="pas-diff-bar-slot-text">${text('Diff Slot Empty')}</span></span>`;
}
