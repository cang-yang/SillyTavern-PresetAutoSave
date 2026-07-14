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
let lastRenderMs = 0;

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
    let output = typeof translations[key] === 'string' ? translations[key] : String(key);
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
    Popup: { show: async () => null },
};
window.SillyTavern = { version: '1.13.4-harness', getContext: () => context, libs: {} };
window.main_api = scenario.currentApiId;
window.toastr = { success() {}, info() {}, warning() {}, error() {} };

const [{ initCompatibility }, { initSettings, batchUpdate }, historyPanel] = await Promise.all([
    import('../../modules/compatibility.js'),
    import('../../modules/settings.js'),
    import('../../modules/history-panel.js'),
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
    takeoverEnabled: false,
    autoSeedOnTakeover: false,
});

const app = document.querySelector('#pas-harness-app');
const scenarioLabel = document.querySelector('#pas-harness-scenario');
scenarioLabel.textContent = `${options.scenario} · ${options.theme} · ${options.view}`;
const { mountHistoryPanel, renderHistoryPanelShell, disposeHistoryPanelMount } = historyPanel;
let panelRoot = null;
let panelMount = null;

function loadHarnessDataset() {
    if (options.scenario === 'loading') return new Promise(() => {});
    if (options.scenario === 'error') {
        return Promise.reject(new Error('HARNESS_EXPECTED_STORAGE_FAILURE'));
    }
    return Promise.resolve({ snapshots: scenario.records, archives: [] });
}

async function mountProductionPanel({ waitUntilReady = options.scenario !== 'loading' } = {}) {
    panelRoot = renderHistoryPanelShell(app);
    const started = performance.now();
    panelMount = mountHistoryPanel(panelRoot, { loadDataset: loadHarnessDataset });
    if (waitUntilReady) await panelMount.ready;
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

async function showGroupManager({ withUndo = true } = {}) {
    document.querySelector('.pas-harness-dialog')?.remove();
    const { renderModernGroupingHTML } = await import('../../modules/panel-group-manager.js');
    const nodes = [
        {
            key: 'primary-writing',
            displayName: '这是一个很长但仍应完整可读的中文创作预设分组名称 🦊',
            automaticName: 'primary-writing',
            customized: true,
            depth: 0,
            items: [
                { presetName: 'Story Alpha v7.1', manualOverride: false },
                { presetName: 'Story Mobile', manualOverride: true },
            ],
        },
        {
            key: 'nested-tools',
            displayName: '嵌套工具组',
            automaticName: 'nested-tools',
            customized: false,
            depth: 1,
            parentName: '创作预设',
            items: [{ presetName: 'Summarizer', manualOverride: false }],
        },
    ];
    const host = document.createElement('div');
    host.className = 'pas-harness-dialog pas-harness-group-dialog';
    host.innerHTML = renderModernGroupingHTML(nodes);
    document.body.append(host);
    const undo = host.querySelector('.pas-gm-undo-btn');
    const status = host.querySelector('.pas-gm-history-status');
    if (withUndo && undo && status) {
        undo.disabled = false;
        undo.title = translate('Grouping Undo Action', { action: translate('Grouping Action Move Preset') });
        status.hidden = false;
        status.textContent = translate('Grouping Change Saved', { action: translate('Grouping Action Move Preset') });
    }
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

function collectMetrics() {
    const metricsRoot = document.querySelector('.pas-harness-dialog') || app;
    const importantSelector = [
        '.pas-btn-snap', '.pas-tools-trigger', '.pas-tab', '.pas-search',
        '.pas-view-btn', '.pas-filter', '.pas-btn-restore', '.pas-btn-apply-version',
        '.pas-import-confirm', '.pas-import-mode-card',
        '.pas-gm-header-actions button', '.pas-gm-rename-btn', '.pas-gm-mobile-actions button',
    ].join(',');
    const controls = [...metricsRoot.querySelectorAll('button, input, [role="button"], .pas-import-mode-card')].map(element => {
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
    const requiredLabels = [...metricsRoot.querySelectorAll('.pas-tab > span:not(.pas-tab-badge), .pas-filter > span')]
        .map(element => ({
            selector: `${selectorFor(element.parentElement)} > span`,
            text: element.textContent || '',
            visible: isVisible(element),
        }));
    const disclosures = [...metricsRoot.querySelectorAll('[data-action="toggle-series"], [data-action="toggle-version"], [data-action="toggle-group"]')]
        .map(header => {
            const state = disclosureState(header);
            return {
                selector: selectorFor(header),
                ...state,
            };
        });

    return Object.freeze({
        scenario: options.scenario,
        viewport: Object.freeze({ width: window.innerWidth, height: window.innerHeight }),
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, metricsRoot.scrollWidth),
        controls: Object.freeze(controls.map(Object.freeze)),
        requiredLabels: Object.freeze(requiredLabels.map(Object.freeze)),
        disclosures: Object.freeze(disclosures.map(Object.freeze)),
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
    exerciseDisclosures,
    collectMetrics,
    audit: () => evaluateLayoutAudit(collectMetrics()),
});
