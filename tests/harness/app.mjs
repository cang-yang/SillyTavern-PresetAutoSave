import { applyStatusIndicatorPresentation } from '../../modules/core/status-indicator.js';
import { saveStatusLabelKey, setSaveStatus } from '../../modules/core/save-status.js';
import { bindHistoryImportPreview, renderHistoryImportPreview } from '../../modules/import-preview.js';
import { escapeAttr, escapeHtml } from '../../modules/key-utils.js';
import { buildHarnessScenario } from '../fixtures/browser-harness-model.mjs';
import { normalizeHarnessOptions } from './config.mjs';
import { evaluateLayoutAudit } from './layout-audit.mjs';

const options = normalizeHarnessOptions(window.location.search);
const modelKind = options.scenario === 'loading' || options.scenario === 'error'
    ? 'empty'
    : options.scenario;
const scenario = buildHarnessScenario(modelKind);
const consoleErrors = [];
const operationEvents = [];
const translationOverrides = Object.create(null);
let lastRenderMs = 0;
let lastViewSwitchMs = null;
let confirmResult = true;

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
    const message = args.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(' ');
    if (!message.includes('HARNESS_EXPECTED_STORAGE_FAILURE')) consoleErrors.push(message);
    originalConsoleError(...args);
};
window.addEventListener('error', event => {
    consoleErrors.push(event.error?.stack || event.message || 'Unknown window error');
});
window.addEventListener('unhandledrejection', event => {
    consoleErrors.push(event.reason?.stack || event.reason?.message || String(event.reason));
});

document.body.classList.toggle('pas-light', options.theme === 'light');
document.documentElement.style.colorScheme = options.theme;

const translations = await fetch('../../i18n/zh-cn.json').then(response => {
    if (!response.ok) throw new Error(`Translation request failed: ${response.status}`);
    return response.json();
});
const translate = (key, variables = null) => {
    let output = Object.hasOwn(translationOverrides, key)
        ? String(translationOverrides[key])
        : typeof translations[key] === 'string' ? translations[key] : String(key);
    if (variables) {
        for (const [name, value] of Object.entries(variables)) {
            const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            output = output.replace(new RegExp(`{{\\s*${escapedName}\\s*}}`, 'g'), () => String(value));
        }
    }
    return output;
};

const nativeSelect = document.querySelector('.pas-harness-native-select');
for (const presetName of [...new Set(scenario.records.map(record => record.presetName))]) {
    const option = document.createElement('option');
    option.value = String(nativeSelect.options.length);
    option.textContent = presetName;
    nativeSelect.append(option);
}
if (nativeSelect.options.length === 0) {
    const option = document.createElement('option');
    option.value = '0';
    option.textContent = scenario.currentPresetName;
    nativeSelect.append(option);
}
nativeSelect.selectedIndex = 0;

const selectAdapter = {
    0: nativeSelect,
    val: () => nativeSelect.options[nativeSelect.selectedIndex]?.value ?? '',
};
const eventListeners = new Map();
const popupShow = async () => null;
popupShow.confirm = async () => confirmResult;
class HarnessPopup {
    constructor(html) {
        this.html = html;
        this.host = null;
        this.resolve = null;
    }

    show() {
        this.host = document.createElement('div');
        this.host.className = 'pas-harness-dialog';
        this.host.innerHTML = this.html;
        document.body.append(this.host);
        return new Promise(resolve => { this.resolve = resolve; });
    }

    completeCancelled() {
        this.host?.remove();
        this.resolve?.(false);
        this.resolve = null;
    }
}
HarnessPopup.show = popupShow;
const context = {
    mainApi: scenario.currentApiId,
    extensionSettings: {},
    event_types: {
        OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
        PRESET_CHANGED: 'preset_changed',
        SETTINGS_UPDATED: 'settings_updated',
        APP_READY: 'app_ready',
        APP_INITIALIZED: 'app_initialized',
    },
    eventSource: {
        on(name, handler) {
            if (!eventListeners.has(name)) eventListeners.set(name, new Set());
            eventListeners.get(name).add(handler);
        },
        off(name, handler) {
            eventListeners.get(name)?.delete(handler);
        },
    },
    getPresetManager: () => ({
        select: selectAdapter,
        savePreset: async () => true,
        getPresetSettings: () => scenario.records[0]?.preset || {},
        selectPreset: async name => {
            const index = [...nativeSelect.options].findIndex(option => option.textContent === name);
            if (index >= 0) nativeSelect.selectedIndex = index;
            return index >= 0;
        },
        findPreset: name => [...nativeSelect.options].find(option => option.textContent === name) || null,
        getSelectedPresetName: () => nativeSelect.options[nativeSelect.selectedIndex]?.textContent || '',
    }),
    saveSettingsDebounced: () => {},
    translate,
    Popup: HarnessPopup,
    POPUP_TYPE: { DISPLAY: 'display', INPUT: 'input', CONFIRM: 'confirm', TEXT: 'text' },
};
window.SillyTavern = { version: '1.13.4-harness', getContext: () => context, libs: {} };
window.main_api = scenario.currentApiId;
window.toastr = Object.fromEntries(['success', 'info', 'warning', 'error'].map(level => [level, message => {
    operationEvents.push(Object.freeze({ level, message: String(message || '') }));
}]));

const [{ initCompatibility }, { initSettings, batchUpdate }, historyPanel, historyStore, autoSave, groupManager] = await Promise.all([
    import('../../modules/compatibility.js'),
    import('../../modules/settings.js'),
    import('../../modules/history-panel.js'),
    import('../../modules/history-store.js'),
    import('../../modules/auto-save.js'),
    import('../../modules/panel-group-manager.js'),
]);
initCompatibility();
await initSettings();
batchUpdate({
    groupingEnabled: options.view === 'series',
    groupingFirstScanDone: true,
    groupingDefaultExpand: 'all',
    groupingManualOverrides: scenario.overrides,
    groupingSeriesAliases: {},
    nestingEnabled: Object.keys(scenario.tree).length > 0,
    nestingMaxDepth: 3,
    groupingTree: scenario.tree,
    enabled: true,
    fallbackPolling: false,
    takeoverEnabled: false,
    autoSeedOnTakeover: false,
});

function clearHarnessHistoryStorage() {
    const prefixes = ['PresetAutoSave_history:', 'PresetAutoSave_history_v2:'];
    for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key && prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
    }
}

async function seedHarnessHistory() {
    clearHarnessHistoryStorage();
    await historyStore.initHistoryStore();
    if (options.scenario !== 'ordinary') return;
    for (const record of scenario.records) {
        const snapshot = await historyStore.addSnapshot(
            record.presetName,
            record.apiId,
            record.preset,
            record.trigger,
        );
        if (!snapshot) continue;
        if (record.pinned) await historyStore.togglePinSnapshot(snapshot.id, true);
        if (record.label) await historyStore.renameSnapshot(snapshot.id, record.label);
    }
}

await seedHarnessHistory();
const { initAutoSave, teardown: teardownAutoSave } = autoSave;
await initAutoSave();

const app = document.querySelector('#pas-harness-app');
const scenarioLabel = document.querySelector('#pas-harness-scenario');
scenarioLabel.textContent = `${options.scenario} · ${options.theme} · ${options.view}`;
const { mountHistoryPanel, renderHistoryPanelShell, disposeHistoryPanelMount } = historyPanel;
let panelRoot = null;
let panelMount = null;
let groupManagerMount = null;

async function loadHarnessDataset() {
    if (options.scenario === 'loading') return new Promise(() => {});
    if (options.scenario === 'error') {
        return Promise.reject(new Error('HARNESS_EXPECTED_STORAGE_FAILURE'));
    }
    if (options.scenario === 'ordinary') {
        return { snapshots: await historyStore.getAllSnapshots(), archives: [] };
    }
    return Promise.resolve({ snapshots: scenario.records, archives: [] });
}

async function mountProductionPanel({ waitUntilReady = options.scenario !== 'loading' } = {}) {
    panelRoot = renderHistoryPanelShell(app);
    const started = performance.now();
    panelMount = mountHistoryPanel(panelRoot, { loadDataset: loadHarnessDataset });
    if (waitUntilReady) {
        await panelMount.ready;
        await nextPaint();
    }
    lastRenderMs = performance.now() - started;
    return panelRoot;
}

async function remountProductionPanel() {
    disposeHistoryPanelMount(panelRoot);
    app.replaceChildren();
    return mountProductionPanel();
}

await mountProductionPanel();

function selectorFor(element) {
    if (element.id) return `#${element.id}`;
    const className = [...element.classList].slice(0, 2).map(name => `.${name}`).join('');
    if (className) return className;
    return element.tagName.toLowerCase();
}

function parseRgb(value) {
    const channels = String(value || '').match(/[\d.]+/g)?.slice(0, 3).map(Number);
    return channels?.length === 3 && channels.every(Number.isFinite) ? channels : null;
}

function relativeLuminance(channels) {
    const linear = channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
    const foregroundRgb = parseRgb(foreground);
    const backgroundRgb = parseRgb(background);
    if (!foregroundRgb || !backgroundRgb) return Number.NaN;
    const foregroundLuminance = relativeLuminance(foregroundRgb);
    const backgroundLuminance = relativeLuminance(backgroundRgb);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function showSaveStatus(state) {
    if (!setSaveStatus(state)) return false;
    const dot = app.querySelector('.pas-panel-status .pas-status-dot');
    return applyStatusIndicatorPresentation(dot, state, translate(saveStatusLabelKey(state)));
}

function importPreviewFixture(conflicts = false) {
    const merge = {
        available: !conflicts,
        importedSnapshotCount: conflicts ? 0 : 16,
        finalPresetCount: 5,
        finalSnapshotCount: 31,
        removedPresetCount: 0,
    };
    return {
        sourceVersion: 2,
        schemaVersion: 2,
        presetCount: 3,
        snapshotCount: 18,
        overlappingPresetCount: 1,
        duplicateSnapshotCount: 2,
        conflictCount: conflicts ? 1 : 0,
        conflicts: conflicts ? [{ key: 'openai::超长预设名称 · Unicode 🦊', snapshotId: 'snap-conflict-1' }] : [],
        modes: {
            merge,
            replace: {
                available: true,
                importedSnapshotCount: 18,
                finalPresetCount: 3,
                finalSnapshotCount: 18,
                removedPresetCount: 2,
            },
        },
    };
}

function showImportPreview({ conflicts = false } = {}) {
    document.querySelector('.pas-harness-dialog')?.remove();
    const host = document.createElement('div');
    host.className = 'pas-harness-dialog';
    host.innerHTML = renderHistoryImportPreview(importPreviewFixture(conflicts), {
        t: translate,
        escapeHtml,
    });
    document.body.append(host);
    bindHistoryImportPreview(host.querySelector('.pas-import-preview'), { translate });
    return true;
}

function closeImportPreview() {
    document.querySelector('.pas-harness-dialog')?.remove();
}

async function showGroupManager() {
    groupManagerMount?.dispose();
    groupManagerMount = null;
    document.querySelector('.pas-harness-dialog')?.remove();
    const { mountGroupingManager } = groupManager;
    const presetNames = [...nativeSelect.options].map(option => option.textContent).filter(Boolean);
    const host = document.createElement('div');
    host.className = 'pas-harness-dialog pas-harness-group-dialog';
    document.body.append(host);
    groupManagerMount = mountGroupingManager(host, {
        panelCtx: { refreshData: async () => {} },
        presetNames,
    });
    return true;
}

function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

const DISCLOSURE_BODIES = Object.freeze({
    'toggle-series': ['.pas-series-group', '.pas-series-body'],
    'toggle-version': ['.pas-version-group', '.pas-version-body'],
    'toggle-group': ['.pas-preset-group', '.pas-preset-body'],
});

function disclosureState(header) {
    const [groupSelector, bodySelector] = DISCLOSURE_BODIES[header?.dataset.action] || [];
    const body = groupSelector && bodySelector
        ? header.closest(groupSelector)?.querySelector(`:scope > ${bodySelector}`)
        : null;
    return {
        expanded: header?.getAttribute('aria-expanded') === 'true',
        bodyHidden: body ? body.hidden : null,
    };
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Harness operation timed out');
}

async function exerciseGroupingMenus() {
    if (options.scenario !== 'ordinary') throw new Error('Grouping menu operations require the ordinary scenario');
    await showGroupManager();
    const manager = groupManagerMount?.root;
    let firstSeries = manager?.querySelector('.pas-gm-series');
    const firstSeriesKey = firstSeries?.getAttribute('data-series-key');
    if (firstSeries?.classList.contains('collapsed')) {
        firstSeries.querySelector('.pas-gm-series-toggle')?.click();
        firstSeries = manager.querySelector(`[data-series-key="${CSS.escape(firstSeriesKey)}"]`);
    }
    const trigger = firstSeries?.querySelector('.pas-gm-menu-btn');
    if (!manager || !trigger) throw new Error('Grouping preset action trigger was not rendered');

    trigger.focus();
    trigger.click();
    let menu = document.querySelector('.pas-gm-context-menu');
    let items = [...(menu?.querySelectorAll('[role="menuitem"]') || [])];
    const openedSemantically = Boolean(
        menu?.getAttribute('role') === 'menu'
        && trigger.getAttribute('aria-expanded') === 'true'
        && items.length >= 2
        && items.every(item => item.tagName === 'BUTTON')
        && document.activeElement === items[0]
    );

    items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const arrowMoved = document.activeElement === items[1];
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await Promise.resolve();
    const escapeClosed = !document.querySelector('.pas-gm-context-menu')
        && document.activeElement === trigger
        && trigger.getAttribute('aria-expanded') === 'false';

    trigger.click();
    menu = document.querySelector('.pas-gm-context-menu');
    items = [...(menu?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
    items[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await Promise.resolve();
    const tabContinued = !document.querySelector('.pas-gm-context-menu')
        && manager.contains(document.activeElement)
        && document.activeElement !== trigger;

    trigger.click();
    manager.querySelector('.pas-gm-search input')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await Promise.resolve();
    const outsideClosed = !document.querySelector('.pas-gm-context-menu')
        && trigger.getAttribute('aria-expanded') === 'false';

    const seriesTrigger = manager.querySelector('.pas-gm-series-menu-btn');
    seriesTrigger?.click();
    const renameItem = document.querySelector('.pas-gm-context-menu [data-action="rename"]');
    renameItem?.click();
    await nextPaint();
    const actionActivated = Boolean(manager.querySelector('.pas-gm-name-input'));
    manager.querySelector('.pas-gm-name-input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    trigger.click();
    groupManagerMount?.dispose();
    groupManagerMount = null;
    const disposalClosed = !document.querySelector('.pas-gm-context-menu');
    document.querySelector('.pas-harness-group-dialog')?.remove();

    const result = Object.freeze({
        openedSemantically,
        arrowMoved,
        escapeClosed,
        tabContinued,
        outsideClosed,
        actionActivated,
        disposalClosed,
    });
    if (Object.values(result).some(value => value !== true)) {
        throw new Error(`Grouping menu keyboard contract failed: ${JSON.stringify(result)}`);
    }
    return result;
}

async function exerciseGroupingLayout() {
    if (options.scenario !== 'ordinary') throw new Error('Grouping layout checks require the ordinary scenario');
    await showGroupManager();
    const input = groupManagerMount?.root?.querySelector('.pas-gm-search input');
    const rect = input?.getBoundingClientRect();
    const audit = evaluateLayoutAudit(collectMetrics());
    const result = Object.freeze({
        width: Number((rect?.width || 0).toFixed(2)),
        height: Number((rect?.height || 0).toFixed(2)),
        audit,
    });

    groupManagerMount?.dispose();
    groupManagerMount = null;
    document.querySelector('.pas-harness-group-dialog')?.remove();

    if (!audit.passed || result.width < 44 || result.height < 44) {
        throw new Error(`Grouping search touch target failed: ${JSON.stringify(result)}`);
    }
    return result;
}

async function exerciseHostileTranslations() {
    if (options.scenario !== 'ordinary') throw new Error('Hostile translation checks require the ordinary scenario');
    const marker = 'pas-hostile-translation-marker';
    window.__PAS_HOSTILE_TRANSLATION_EXECUTED__ = false;
    translationOverrides['Footer Stats'] = `<img id="${marker}" src="missing-hostile-translation" onerror="window.__PAS_HOSTILE_TRANSLATION_EXECUTED__=true">hostile`;

    try {
        await remountProductionPanel();
        await waitFor(() => panelRoot.querySelector('#pas-footer-stats')?.textContent?.includes('hostile'));
        await nextPaint();
        const footer = panelRoot.querySelector('#pas-footer-stats');
        const result = Object.freeze({
            injectedElement: Boolean(document.getElementById(marker)),
            handlerExecuted: window.__PAS_HOSTILE_TRANSLATION_EXECUTED__ === true,
            renderedLiterally: footer?.textContent?.includes('<img') === true,
        });
        if (result.injectedElement || result.handlerExecuted || !result.renderedLiterally) {
            throw new Error(`Hostile translation executed as markup: ${JSON.stringify(result)}`);
        }
        return result;
    } finally {
        delete translationOverrides['Footer Stats'];
        delete window.__PAS_HOSTILE_TRANSLATION_EXECUTED__;
        await remountProductionPanel();
    }
}

async function exerciseCoreOperations() {
    if (options.scenario !== 'ordinary') throw new Error('Core operations require the ordinary scenario');
    operationEvents.length = 0;

    const allSnapshotsBefore = await historyStore.getAllSnapshots();
    const currentPresetName = nativeSelect.options[nativeSelect.selectedIndex]?.textContent || '';
    const targetSnapshotsBefore = allSnapshotsBefore.filter(snapshot => (
        snapshot.apiId === scenario.currentApiId && snapshot.presetName === currentPresetName
    ));
    const previousSnapshot = structuredClone(targetSnapshotsBefore[0] || null);
    const previousIds = new Set(targetSnapshotsBefore.map(snapshot => snapshot.id));
    panelRoot.querySelector('.pas-btn-snap')?.click();
    await waitFor(() => operationEvents.some(event => event.level === 'success' || event.level === 'error'));
    const allSnapshotsAfter = await historyStore.getAllSnapshots();
    const targetSnapshotsAfter = allSnapshotsAfter.filter(snapshot => (
        snapshot.apiId === scenario.currentApiId && snapshot.presetName === currentPresetName
    ));
    const snapshotSucceeded = operationEvents.some(event => event.level === 'success');
    const newestSnapshot = targetSnapshotsAfter[0] || null;
    const preservedSnapshot = previousSnapshot
        ? targetSnapshotsAfter.find(snapshot => snapshot.id === previousSnapshot.id)
        : null;
    const countIncreased = allSnapshotsAfter.length === allSnapshotsBefore.length + 1
        && targetSnapshotsAfter.length === targetSnapshotsBefore.length + 1;
    const newIdCreated = Boolean(newestSnapshot?.id && !previousIds.has(newestSnapshot.id));
    const previousSnapshotPreserved = !previousSnapshot || Boolean(
        preservedSnapshot
        && preservedSnapshot.hash === previousSnapshot.hash
        && preservedSnapshot.timestamp === previousSnapshot.timestamp
        && JSON.stringify(preservedSnapshot.preset) === JSON.stringify(previousSnapshot.preset)
    );
    const snapshotCommitted = snapshotSucceeded && countIncreased && newIdCreated && previousSnapshotPreserved;
    if (!snapshotCommitted) throw new Error('Immediate snapshot did not retain a distinct recovery point');

    await showGroupManager({ withUndo: false });
    const manager = groupManagerMount?.root;
    const card = manager?.querySelector('.pas-gm-series');
    const key = card?.getAttribute('data-series-key') || '';
    const groupName = () => manager?.querySelector(`[data-series-key="${CSS.escape(key)}"] .pas-gm-series-name`)?.textContent || '';
    const originalName = groupName();
    card?.querySelector('.pas-gm-rename-btn')?.click();
    const input = card?.querySelector('.pas-gm-name-input');
    if (!input) throw new Error('Real grouping controller did not enter rename mode');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = `${originalName} QA`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await nextPaint();
    const renamedName = groupName();

    manager.querySelector('.pas-gm-undo-btn')?.click();
    await nextPaint();
    const undoneName = groupName();
    manager.querySelector('.pas-gm-redo-btn')?.click();
    await nextPaint();
    const redoneName = groupName();

    manager.querySelector(`[data-series-key="${CSS.escape(key)}"] .pas-gm-rename-btn`)?.click();
    const cancelInput = manager.querySelector(`[data-series-key="${CSS.escape(key)}"] .pas-gm-name-input`);
    cancelInput.value = `${redoneName} cancelled`;
    cancelInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    cancelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
    const imePreserved = Boolean(manager.querySelector(`[data-series-key="${CSS.escape(key)}"] .pas-gm-name-input`));
    cancelInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    cancelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextPaint();
    const escapeCancelled = groupName() === redoneName;

    groupManagerMount?.dispose();
    groupManagerMount = null;
    document.querySelector('.pas-harness-group-dialog')?.remove();
    return Object.freeze({
        snapshot: Object.freeze({
            before: allSnapshotsBefore.length,
            after: allSnapshotsAfter.length,
            countIncreased,
            newIdCreated,
            previousSnapshotPreserved,
            committed: snapshotCommitted,
        }),
        grouping: Object.freeze({
            originalName,
            renamedName,
            undoneName,
            redoneName,
            renamed: renamedName !== originalName,
            undone: undoneName === originalName,
            redone: redoneName === renamedName,
            imePreserved,
            escapeCancelled,
        }),
        events: Object.freeze([...operationEvents]),
        consoleErrors: Object.freeze([...consoleErrors]),
    });
}

async function exerciseDisclosures() {
    const checks = [];
    const actions = ['toggle-series', 'toggle-version', 'toggle-group'];
    const activations = ['Enter', ' ', 'click'];

    for (const action of actions) {
        const findHeader = () => [...panelRoot.querySelectorAll(`[data-action="${action}"]`)].find(isVisible) || null;
        const initialHeader = findHeader();
        if (!initialHeader) continue;
        const initialExpanded = disclosureState(initialHeader).expanded;

        for (const activation of activations) {
            const header = findHeader();
            const before = disclosureState(header);
            if (activation === 'click') header.click();
            else header.dispatchEvent(new KeyboardEvent('keydown', { key: activation, bubbles: true, cancelable: true }));
            await nextPaint();
            const after = disclosureState(findHeader());
            checks.push(Object.freeze({
                action,
                activation: activation === ' ' ? 'Space' : activation,
                changed: before.expanded !== after.expanded,
                synchronized: after.bodyHidden !== null && after.expanded === !after.bodyHidden,
            }));
        }

        const currentHeader = findHeader();
        if (currentHeader && disclosureState(currentHeader).expanded !== initialExpanded) {
            currentHeader.click();
            await nextPaint();
        }
    }

    return Object.freeze({
        passed: checks.length > 0 && checks.every(check => check.changed && check.synchronized),
        checks: Object.freeze(checks),
        audit: evaluateLayoutAudit(collectMetrics()),
    });
}

async function exerciseUnusedNativeSeries() {
    if (options.scenario !== 'ordinary' || options.view !== 'series') {
        throw new Error('Unused native series checks require the ordinary series scenario');
    }

    const marker = '未使用预设验证';
    const names = [`${marker} V1.0`, `${marker} V2.0`];
    const addedOptions = [];
    let result;

    try {
        for (const name of names) {
            if ([...nativeSelect.options].some(option => option.textContent === name)) continue;
            const option = document.createElement('option');
            option.value = String(nativeSelect.options.length);
            option.textContent = name;
            nativeSelect.append(option);
            addedOptions.push(option);
        }

        await remountProductionPanel();
        let group = [...panelRoot.querySelectorAll('.pas-series-group')]
            .find(candidate => candidate.textContent.includes(marker));
        const header = group?.querySelector(':scope > .pas-series-header');
        if (!group || !header) throw new Error('Unused native series was not rendered');
        if (header.getAttribute('aria-expanded') !== 'true') header.click();
        await nextPaint();

        group = [...panelRoot.querySelectorAll('.pas-series-group')]
            .find(candidate => candidate.textContent.includes(marker));
        const body = group?.querySelector(':scope > .pas-series-body');
        const versions = [...(body?.querySelectorAll(':scope > .pas-version-group') || [])];
        result = Object.freeze({
            expanded: group?.querySelector(':scope > .pas-series-header')?.getAttribute('aria-expanded') === 'true',
            bodyVisible: body?.hidden === false,
            renderedVersions: versions.length,
            emptyStates: versions.filter(version => version.querySelector('.pas-tag-empty')).length,
            collapsedActions: versions.filter(version => version.querySelector('.pas-version-actions')).length,
        });
    } finally {
        for (const option of addedOptions) option.remove();
        await remountProductionPanel();
    }

    if (!result.expanded || !result.bodyVisible || result.renderedVersions !== names.length
        || result.emptyStates !== names.length || result.collapsedActions !== 0) {
        throw new Error(`Unused native series hydration failed: ${JSON.stringify(result)}`);
    }
    return result;
}

async function exerciseViewSwitchPerformance() {
    if (options.scenario !== 'performance') {
        throw new Error('View-switch performance checks require the performance scenario');
    }

    const samples = [];
    const nextView = target => [...panelRoot.querySelectorAll('.pas-view-btn')]
        .find(button => button.dataset.view === target);

    // Prime both view-only markup entries before timing the common repeated
    // navigation path. Cold construction is covered by the panel-open budget.
    nextView('flat')?.click();
    await nextPaint();
    nextView('series')?.click();
    await nextPaint();

    for (const target of ['flat', 'series', 'flat', 'series', 'flat', 'series']) {
        const callbackDurations = [];
        const originalRequestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => originalRequestAnimationFrame.call(window, timestamp => {
            const startedAt = performance.now();
            try {
                return callback(timestamp);
            } finally {
                callbackDurations.push(performance.now() - startedAt);
            }
        });
        try {
            nextView(target)?.click();
            await nextPaint();
        } finally {
            window.requestAnimationFrame = originalRequestAnimationFrame;
        }
        samples.push(Object.freeze({
            target,
            renderCallbackMs: Math.max(0, ...callbackDurations),
        }));
    }

    lastViewSwitchMs = Math.max(0, ...samples.map(sample => sample.renderCallbackMs));
    return Object.freeze({
        maxRenderCallbackMs: lastViewSwitchMs,
        samples: Object.freeze(samples),
    });
}

function collectMetrics() {
    const metricsRoot = document.querySelector('.pas-harness-dialog') || app;
    const importantSelector = [
        '.pas-btn-snap', '.pas-tools-trigger', '.pas-tab', '.pas-search',
        '.pas-view-btn', '.pas-btn-diff-a', '.pas-btn-diff-b', '.pas-btn-restore', '.pas-btn-view',
        '.pas-card-tools-trigger', '.pas-btn-apply-version',
        '.pas-btn-show-more-snapshots',
        '.pas-import-confirm', '.pas-import-mode-card',
        '.pas-gm-header-actions button', '.pas-gm-rename-btn', '.pas-gm-mobile-actions button',
        '.pas-gm-search input',
    ].join(',');
    const controls = [...metricsRoot.querySelectorAll('button, summary, input, [role="button"], .pas-import-mode-card')].map(element => {
        const rect = element.getBoundingClientRect();
        return {
            selector: selectorFor(element),
            important: element.matches(importantSelector),
            visible: isVisible(element),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
        };
    });
    const hiddenFocusable = [...metricsRoot.querySelectorAll('[aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] [tabindex]')]
        .filter(element => element.tabIndex >= 0)
        .map(selectorFor);
    const requiredLabelSelector = window.innerWidth <= 460
        ? '.pas-tab > span:not(.pas-tab-badge), .pas-filter > span, .pas-primary-action .pas-control-face > span, .pas-view-btn > span, .pas-btn-clear-preset > .pas-action-label'
        : '.pas-tab > span:not(.pas-tab-badge), .pas-filter > span';
    const requiredLabels = [...metricsRoot.querySelectorAll(requiredLabelSelector)]
        .filter(element => isVisible(element.parentElement))
        .map(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const fontSize = Number.parseFloat(style.fontSize) || 16;
            const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
            const clippingRoot = element.closest('.pas-filters') || metricsRoot;
            const clippingRect = clippingRoot.getBoundingClientRect();
            const clippingStyle = getComputedStyle(clippingRoot);
            const scrollAccessible = clippingRoot.matches('.pas-filters')
                && clippingRoot.scrollWidth > clippingRoot.clientWidth
                && ['auto', 'scroll'].includes(clippingStyle.overflowX);
            const leftEdge = Math.max(0, clippingRect.left);
            const rightEdge = Math.min(window.innerWidth, clippingRect.right);
            return {
                selector: `${selectorFor(element.parentElement)} > span`,
                text: element.textContent || '',
                visible: isVisible(element),
                fullyVisible: rect.left >= leftEdge - 1 && rect.right <= rightEdge + 1,
                scrollAccessible,
                singleLine: rect.height <= lineHeight * 1.25,
            };
        });
    const disclosures = [...metricsRoot.querySelectorAll('[data-action="toggle-series"], [data-action="toggle-version"], [data-action="toggle-group"]')]
        .map(header => {
            const state = disclosureState(header);
            return {
                selector: selectorFor(header),
                ...state,
            };
        });
    const expandedSeriesContent = [...metricsRoot.querySelectorAll('.pas-series-group')]
        .map(group => {
            const header = group.querySelector(':scope > .pas-series-header');
            if (header?.getAttribute('aria-expanded') !== 'true') return null;
            const body = group.querySelector(':scope > .pas-series-body');
            const countText = header.querySelector('.pas-series-version-pill')?.textContent || '';
            return {
                selector: `[data-series-key="${group.getAttribute('data-series-key') || ''}"]`,
                declaredVersions: Number.parseInt(countText.match(/\d+/)?.[0] || '0', 10),
                renderedVersions: body?.querySelectorAll(':scope > .pas-version-group').length || 0,
                renderedChildren: body?.querySelectorAll(':scope > .pas-series-group').length || 0,
            };
        })
        .filter(Boolean);
    const historyFilterRows = new Set(
        [...metricsRoot.querySelectorAll('#pas-panel-list > .pas-toolbar > .pas-filters .pas-filter')]
            .filter(isVisible)
            .map(filter => Math.round(filter.getBoundingClientRect().top)),
    ).size;
    const historyListTop = metricsRoot.querySelector('.pas-snapshot-list')?.getBoundingClientRect().top;
    const visibleVersionHeaders = [...metricsRoot.querySelectorAll('.pas-version-header')].filter(isVisible);
    const visibleSnapshotActions = [...metricsRoot.querySelectorAll('.pas-card-actions')]
        .filter(actions => !actions.querySelector('.pas-card-tools[open]'))
        .filter(isVisible);
    const versionHeaderHeight = visibleVersionHeaders.length > 0
        ? Math.max(...visibleVersionHeaders.map(header => header.getBoundingClientRect().height))
        : null;
    const snapshotActionHeight = visibleSnapshotActions.length > 0
        ? Math.max(...visibleSnapshotActions.map(actions => actions.getBoundingClientRect().height))
        : null;
    const controlFaces = [...metricsRoot.querySelectorAll('.pas-control-face')].map(element => ({
        selector: `${selectorFor(element.parentElement)} > .pas-control-face`,
        visible: isVisible(element),
        height: Number(element.getBoundingClientRect().height.toFixed(2)),
    }));
    const versionFrames = [...metricsRoot.querySelectorAll('.pas-series-body > .pas-version-group')]
        .filter(isVisible)
        .map(element => {
            const style = getComputedStyle(element);
            return {
                selector: selectorFor(element),
                visible: true,
                borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
                    .map(value => Number.parseFloat(value)),
                radius: Number.parseFloat(style.borderTopLeftRadius),
            };
        });
    const renderedView = panelRoot?.querySelector('.pas-series-group')
        ? 'series'
        : panelRoot?.querySelector('.pas-preset-group') ? 'flat' : null;
    const selectedView = panelRoot?.querySelector('.pas-view-btn[aria-pressed="true"]')?.getAttribute('data-view') || null;
    const manageGrouping = panelRoot?.querySelector('.pas-btn-manage-grouping');
    const viewMode = renderedView ? Object.freeze({
        selected: selectedView,
        rendered: renderedView,
        manageGroupingAvailable: Boolean(manageGrouping && manageGrouping.style.display !== 'none'),
    }) : null;
    const footer = metricsRoot.querySelector('.pas-panel-footer');
    const footerStats = metricsRoot.querySelector('#pas-footer-stats');
    const footerStyle = footer ? getComputedStyle(footer) : null;
    const footerStatsStyle = footerStats ? getComputedStyle(footerStats) : null;
    const footerText = footerStyle && footerStatsStyle ? Object.freeze({
        fontSize: Number.parseFloat(footerStatsStyle.fontSize),
        contrast: Number(contrastRatio(footerStatsStyle.color, footerStyle.backgroundColor).toFixed(2)),
    }) : null;

    return Object.freeze({
        scenario: options.scenario,
        viewport: Object.freeze({ width: window.innerWidth, height: window.innerHeight }),
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, metricsRoot.scrollWidth),
        controls: Object.freeze(controls.map(Object.freeze)),
        requiredLabels: Object.freeze(requiredLabels.map(Object.freeze)),
        disclosures: Object.freeze(disclosures.map(Object.freeze)),
        expandedSeriesContent: Object.freeze(expandedSeriesContent.map(Object.freeze)),
        historyFilterRows,
        historyListTop,
        versionHeaderHeight,
        snapshotActionHeight,
        controlFaces: Object.freeze(controlFaces.map(Object.freeze)),
        versionFrames: Object.freeze(versionFrames.map(frame => Object.freeze({
            ...frame,
            borders: Object.freeze(frame.borders),
        }))),
        viewSwitchMs: lastViewSwitchMs,
        viewMode,
        footerText,
        hiddenFocusable: Object.freeze(hiddenFocusable),
        consoleErrors: Object.freeze([...consoleErrors]),
        renderMs: lastRenderMs,
    });
}

window.__PAS_HARNESS__ = Object.freeze({
    ready: true,
    scenario: options,
    render: () => panelMount.ready,
    remount: remountProductionPanel,
    dispose: () => disposeHistoryPanelMount(panelRoot),
    showSaveStatus,
    showImportPreview,
    closeImportPreview,
    showGroupManager,
    exerciseCoreOperations,
    exerciseGroupingMenus,
    exerciseGroupingLayout,
    exerciseHostileTranslations,
    exerciseDisclosures,
    exerciseUnusedNativeSeries,
    exerciseViewSwitchPerformance,
    setConfirmResult: value => { confirmResult = Boolean(value); },
    operationEvents: () => Object.freeze([...operationEvents]),
    collectMetrics,
    audit: () => evaluateLayoutAudit(collectMetrics()),
});

window.addEventListener('pagehide', () => {
    groupManagerMount?.dispose();
    disposeHistoryPanelMount(panelRoot);
    void teardownAutoSave();
}, { once: true });
