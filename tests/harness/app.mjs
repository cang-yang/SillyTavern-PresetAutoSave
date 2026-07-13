import { buildPanelHTML } from '../../modules/panel-shell.js';
import { captureFocusAnchor, restoreFocusAnchor } from '../../modules/core/focus-anchor.js';
import { applyStatusIndicatorPresentation } from '../../modules/core/status-indicator.js';
import { saveStatusLabelKey, setSaveStatus } from '../../modules/core/save-status.js';
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
    consoleErrors.push(args.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(' '));
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

const [{ initCompatibility }, { initSettings, batchUpdate }, listRenderer, grouping] = await Promise.all([
    import('../../modules/compatibility.js'),
    import('../../modules/settings.js'),
    import('../../modules/panel-list-render.js'),
    import('../../modules/preset-grouping.js'),
]);
initCompatibility();
await initSettings();
batchUpdate({
    groupingEnabled: true,
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

const state = {
    filter: 'all',
    search: '',
    viewMode: options.view,
    expandedSeries: new Set([
        ...Object.values(scenario.overrides),
        ...Object.keys(scenario.tree),
        ...Object.values(scenario.tree),
    ]),
    expandedVersions: new Set(scenario.records.map(record => `${record.apiId}::${record.presetName}`)),
    expandedPresets: new Set(scenario.records.map(record => `${record.apiId}::${record.presetName}`)),
    diffSel: { a: null, b: null },
};
const panelContext = {
    state: () => state,
    archivedCache: () => [],
};
const cachedSeriesMap = grouping.groupSnapshotsBySeries(scenario.records, {
    overrides: scenario.overrides,
    aliases: {},
});

const app = document.querySelector('#pas-harness-app');
app.innerHTML = buildPanelHTML({ t: translate, escapeHtml, escapeAttr });
const scenarioLabel = document.querySelector('#pas-harness-scenario');
scenarioLabel.textContent = `${options.scenario} · ${options.theme} · ${options.view}`;

if (options.scenario === 'loading' || options.scenario === 'error') {
    const note = document.createElement('div');
    note.className = 'pas-harness-state-note';
    note.dataset.harnessState = options.scenario;
    note.textContent = options.scenario === 'loading'
        ? '测试主机正在模拟历史记录加载中；当前产品尚无专用结构化加载状态。'
        : '测试主机正在模拟存储不可用；当前产品尚无专用可恢复错误状态。';
    app.prepend(note);
}

function filteredRecords() {
    return listRenderer.applyFiltersAndSearch(scenario.records, panelContext);
}

function renderList() {
    const started = performance.now();
    const list = app.querySelector('.pas-snapshot-list');
    const focusAnchor = captureFocusAnchor(list);
    list.toggleAttribute('aria-busy', options.scenario === 'loading');

    if (options.scenario === 'loading' || options.scenario === 'error' || scenario.records.length === 0) {
        list.innerHTML = listRenderer.renderEmptyState(panelContext);
    } else {
        const records = filteredRecords();
        list.innerHTML = state.viewMode === 'flat'
            ? listRenderer.renderFlatView(records, panelContext)
            : listRenderer.renderSeriesView(records, panelContext, cachedSeriesMap);
    }

    const visibleRecords = filteredRecords().length;
    app.querySelector('#pas-list-badge').textContent = String(visibleRecords);
    app.querySelector('#pas-panel-stats').textContent = `${visibleRecords} 条快照`;
    app.querySelector('#pas-footer-stats').textContent = `${visibleRecords} 条快照`;
    restoreFocusAnchor(list, focusAnchor, app.querySelector('.pas-search'));
    lastRenderMs = performance.now() - started;
    return lastRenderMs;
}

function toggleInSet(set, key) {
    if (set.has(key)) set.delete(key);
    else set.add(key);
    renderList();
}

function activateTab(tabName) {
    for (const tab of app.querySelectorAll('[role="tab"]')) {
        const active = tab.dataset.tab === tabName;
        tab.classList.toggle('pas-tab-active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of app.querySelectorAll('[role="tabpanel"]')) {
        const active = panel.dataset.content === tabName;
        panel.hidden = !active;
        panel.classList.toggle('pas-tab-content-active', active);
    }
}

app.addEventListener('click', event => {
    const target = event.target.closest('button, [data-action]');
    if (!target || !app.contains(target)) return;

    if (target.matches('[role="tab"]')) {
        activateTab(target.dataset.tab);
        return;
    }
    if (target.matches('.pas-tools-trigger')) {
        const menu = app.querySelector('#pas-tools-menu');
        const open = menu.hidden;
        menu.hidden = !open;
        target.setAttribute('aria-expanded', String(open));
        if (open) menu.querySelector('[role="menuitem"]')?.focus();
        return;
    }
    if (target.matches('.pas-view-btn')) {
        state.viewMode = target.dataset.view;
        for (const button of app.querySelectorAll('.pas-view-btn')) {
            const active = button === target;
            button.classList.toggle('pas-view-btn-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        renderList();
        return;
    }
    if (target.matches('.pas-filter')) {
        state.filter = target.dataset.filter;
        for (const button of app.querySelectorAll('.pas-filter')) {
            const active = button === target;
            button.classList.toggle('pas-filter-active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        renderList();
        return;
    }

    const action = target.dataset.action;
    if (action === 'toggle-series') toggleInSet(state.expandedSeries, target.closest('[data-series-key]')?.dataset.seriesKey);
    if (action === 'toggle-version') {
        const group = target.closest('[data-api-id][data-preset-name]');
        if (group) toggleInSet(state.expandedVersions, `${group.dataset.apiId}::${group.dataset.presetName}`);
    }
    if (action === 'toggle-group') toggleInSet(state.expandedPresets, target.closest('[data-preset-key]')?.dataset.presetKey);
});

app.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-action]')) {
        event.preventDefault();
        event.target.click();
    }
    if (event.key === 'Escape') {
        const menu = app.querySelector('#pas-tools-menu');
        if (!menu.hidden) {
            menu.hidden = true;
            const trigger = app.querySelector('.pas-tools-trigger');
            trigger.setAttribute('aria-expanded', 'false');
            trigger.focus();
        }
    }
});

app.querySelector('.pas-search').addEventListener('input', event => {
    state.search = event.target.value.trim();
    renderList();
});

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

function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function collectMetrics() {
    const importantSelector = [
        '.pas-btn-snap', '.pas-tools-trigger', '.pas-tab', '.pas-search',
        '.pas-view-btn', '.pas-filter', '.pas-btn-restore', '.pas-btn-apply-version',
    ].join(',');
    const controls = [...app.querySelectorAll('button, input, [role="button"]')].map(element => {
        const rect = element.getBoundingClientRect();
        return {
            selector: selectorFor(element),
            important: element.matches(importantSelector),
            visible: isVisible(element),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
        };
    });
    const hiddenFocusable = [...app.querySelectorAll('[aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] [tabindex]')]
        .filter(element => element.tabIndex >= 0)
        .map(selectorFor);
    const requiredLabels = [...app.querySelectorAll('.pas-tab > span:not(.pas-tab-badge), .pas-filter > span')]
        .map(element => ({
            selector: `${selectorFor(element.parentElement)} > span`,
            text: element.textContent || '',
            visible: isVisible(element),
        }));

    return Object.freeze({
        scenario: options.scenario,
        viewport: Object.freeze({ width: window.innerWidth, height: window.innerHeight }),
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, app.scrollWidth),
        controls: Object.freeze(controls.map(Object.freeze)),
        requiredLabels: Object.freeze(requiredLabels.map(Object.freeze)),
        hiddenFocusable: Object.freeze(hiddenFocusable),
        consoleErrors: Object.freeze([...consoleErrors]),
        renderMs: lastRenderMs,
    });
}

renderList();
window.__PAS_HARNESS__ = Object.freeze({
    ready: true,
    scenario: options,
    render: renderList,
    showSaveStatus,
    collectMetrics,
    audit: () => evaluateLayoutAudit(collectMetrics()),
});
