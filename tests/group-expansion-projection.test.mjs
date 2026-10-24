import assert from 'node:assert/strict';
import test from 'node:test';
import { installRuntimeHost } from './fixtures/runtime-host.mjs';
import { initSettings, batchUpdate } from '../modules/settings.js';
import { resolveSeriesExpansion } from '../modules/panel-list-model.js';
import { renderSeriesView } from '../modules/panel-list-render.js';
import { initCompatibility } from '../modules/compatibility.js';

const host = installRuntimeHost();
const manager = host.context.getPresetManager();
manager.select[0].options = [
    { textContent: 'Story V2', value: '0' },
    { textContent: 'Unused V1', value: '1' },
];
manager.select[0].isConnected = true;
manager.select[0].getAttribute = () => 'openai';
document.querySelectorAll = () => [manager.select[0]];
initCompatibility();
await initSettings();
batchUpdate({
    nestingEnabled: true,
    groupingTree: { story: 'empty parent', unused: 'empty parent' },
    groupingSeriesAliases: { story: 'Creative' },
});
const state = {
    filter: 'all', search: '', expandedSeries: new Set(), expandedVersions: new Set(),
    snapshotRenderLimits: new Map(), diffSel: { a: null, b: null },
};
const panelCtx = { state: () => state, archivedCache: () => [] };

test('expand-all includes native zero-history groups and their empty canonical ancestors', () => {
    const result = resolveSeriesExpansion([], panelCtx);
    assert.deepEqual([...result.seriesKeys].sort(), ['empty parent', 'story', 'unused']);
    assert.deepEqual([...result.versionKeys].sort(), ['openai::Story V2', 'openai::Unused V1']);
    state.expandedSeries = result.seriesKeys;
    state.expandedVersions = result.versionKeys;
    const html = renderSeriesView([], panelCtx);
    assert.match(html, /data-version-key="openai::Unused V1"/);
    assert.match(html, /data-series-key="empty parent"/);
    assert.doesNotMatch(html, /data-series-key="Creative"/);
});

test('current-only expansion reaches a zero-history target through its canonical ancestors', () => {
    const result = resolveSeriesExpansion([], panelCtx, { currentOnly: true });
    assert.deepEqual([...result.seriesKeys].sort(), ['empty parent', 'story']);
    assert.deepEqual([...result.versionKeys], ['openai::Story V2']);
});

test('search and current-group views can find native presets before their first snapshot', () => {
    state.search = 'Creative';
    let html = renderSeriesView([], panelCtx);
    assert.match(html, /data-version-key="openai::Story V2"/);
    assert.doesNotMatch(html, /data-version-key="openai::Unused V1"/);
    state.search = '';
    state.filter = 'current';
    html = renderSeriesView([], panelCtx);
    assert.match(html, /data-version-key="openai::Story V2"/);
    assert.doesNotMatch(html, /data-version-key="openai::Unused V1"/);
    state.filter = 'pinned';
    assert.doesNotMatch(renderSeriesView([], panelCtx), /data-version-key=/);
    state.filter = 'all';
});

test('depth-limited tree rows preserve versions flattened into a parent with its own preset', () => {
    batchUpdate({ nestingMaxDepth: 1, groupingTree: { unused: 'story' } });
    state.search = '';
    state.filter = 'all';
    state.expandedSeries = new Set(['story', 'unused']);
    const html = renderSeriesView([], panelCtx);
    assert.match(html, /data-version-key="openai::Story V2"/);
    assert.match(html, /data-version-key="openai::Unused V1"/);
});
