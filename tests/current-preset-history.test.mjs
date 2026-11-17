import assert from 'node:assert/strict';
import test from 'node:test';
import { installRuntimeHost } from './fixtures/runtime-host.mjs';
import { initSettings, batchUpdate } from '../modules/settings.js';
import { initCompatibility } from '../modules/compatibility.js';
import { renderSeriesView, renderFlatView } from '../modules/panel-list-render.js';

const host = installRuntimeHost();
const select = host.pm.select[0];
select.options = ['Alpha V1', 'Zulu V3', 'Zulu V1', 'Parent V1', 'Beta V1'].map((textContent, i) => ({ textContent, value: String(i) }));
select.selectedIndex = 2;
select.isConnected = true;
select.getAttribute = () => 'openai';
document.querySelectorAll = () => [select];
initCompatibility();
await initSettings();
const state = { filter: 'all', search: '', expandedSeries: new Set(['alpha', 'zulu', 'parent', 'beta']),
    expandedVersions: new Set(), expandedPresets: new Set(), snapshotRenderLimits: new Map() };
const ctx = { state: () => state, archivedCache: () => [] };
const records = select.options.map((option, i) => ({ id: String(i), apiId: 'openai', presetName: option.textContent,
    timestamp: 100 - i, size: 1, pinned: false }));
const versionNames = html => [...html.matchAll(/data-version-key="openai::([^"]+)"/g)].map(match => match[1]);

test('history puts the current group and older current version before newer alternatives', () => {
    batchUpdate({ nestingEnabled: false, groupingTree: {} });
    const before = structuredClone(records);
    const html = renderSeriesView(records, ctx);
    assert.equal(html.match(/data-series-key="([^"]+)"/)[1], 'zulu');
    assert.deepEqual(versionNames(html).slice(0, 2), ['Zulu V1', 'Zulu V3']);
    assert.deepEqual(records, before);
});

test('nested history puts current ancestors and branch ahead of parent-owned versions', () => {
    batchUpdate({ nestingEnabled: true, groupingTree: { zulu: 'parent', beta: 'parent' } });
    const html = renderSeriesView(records, ctx);
    assert.equal(html.match(/data-series-key="([^"]+)"/)[1], 'parent');
    assert.equal(versionNames(html)[0], 'Zulu V1');
    assert.ok(html.indexOf('data-series-key="zulu"') < html.indexOf('data-series-key="beta"'));
});

test('flat history prioritizes the exact active target, then retains recency order', () => {
    const html = renderFlatView([...records, { ...records[2], id: 'other-api', apiId: 'novel', timestamp: 999 }], ctx);
    const names = [...html.matchAll(/data-preset-key="openai::([^"]+)"/g)].map(match => match[1]);
    assert.equal(names[0], 'Zulu V1');
    assert.doesNotMatch(html, /novel::/);
    select.selectedIndex = 4;
    assert.equal(renderFlatView(records, ctx).match(/data-preset-key="openai::([^"]+)"/)[1], 'Beta V1');
    select.selectedIndex = 2;
});
