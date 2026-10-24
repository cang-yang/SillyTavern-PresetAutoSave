import assert from 'node:assert/strict';
import test from 'node:test';
import {
    groupNamesBySeries,
    groupSnapshotsBySeries,
} from '../modules/preset-grouping.js';
import { applyFiltersAndSearch } from '../modules/panel-list-model.js';
import { renderSeriesView } from '../modules/panel-list-render.js';
import { initSettings, batchUpdate } from '../modules/settings.js';

const context = { mainApi: 'openai', extensionSettings: {}, saveSettingsDebounced() {} };
const select = { options: [{ textContent: 'Story V1', value: '0' }], selectedIndex: 0 };
globalThis.SillyTavern = { getContext: () => context };
globalThis.window = { presetManagers: { openai: { select: { 0: select } } } };
globalThis.document = { querySelectorAll: () => [] };
await initSettings();

function snapshot(presetName, index = 0) {
    return {
        id: `s-${index}`, apiId: 'openai', presetName, timestamp: index + 1,
        size: 10, trigger: 'auto', preset: { temperature: 1 },
    };
}

function panelState(overrides = {}) {
    return {
        filter: 'all', search: '', viewMode: 'series',
        expandedSeries: new Set(['Story', 'story']),
        expandedVersions: new Set(['openai::Story', 'openai::Story V2']),
        snapshotRenderLimits: new Map(), diffSel: { a: null, b: null },
        ...overrides,
    };
}

test('history maps use canonical keys independent of aliases', () => {
    const snapshots = [snapshot('Story V1')];
    const before = groupSnapshotsBySeries(snapshots);
    const after = groupSnapshotsBySeries(snapshots, { aliases: { story: 'Creative' } });
    assert.deepEqual([...before.keys()], ['story']);
    assert.deepEqual([...after.keys()], ['story']);
    assert.equal(after.get('story').displayName, 'Creative');
    assert.equal(after.get('story').versions[0].presetName, 'Story V1');
});

test('cascading alias conflicts never merge canonical groups or ambiguous labels', () => {
    const names = ['Story V1', 'Utility V1', 'Other V1'];
    const aliases = { story: 'Utility', utility: 'Tools', other: 'Tools' };
    const groups = groupNamesBySeries(names, {}, aliases);
    assert.equal(new Set(groups.map(group => group.displayName)).size, 3);
    const history = groupSnapshotsBySeries(names.map(snapshot), { aliases });
    assert.equal(history.size, 3);
    for (const group of history.values()) assert.equal(group.versions.length, 1);
});

test('current group filtering shares normalized canonical membership', () => {
    batchUpdate({ groupingManualOverrides: { 'Utility V1': 'Story' }, groupingSeriesAliases: { story: 'Creative' } });
    const records = ['Story V1', 'story V2', 'Utility V1'].map(snapshot);
    const result = applyFiltersAndSearch(records, { state: () => panelState({ filter: 'current' }) });
    assert.deepEqual(result.map(item => item.presetName), records.map(item => item.presetName));
});

test('search includes aliases and manually assigned group names without changing snapshot ownership', () => {
    batchUpdate({ groupingManualOverrides: { 'Utility V1': 'Story' }, groupingSeriesAliases: { story: 'Creative' } });
    const records = ['Story V1', 'Utility V1'].map(snapshot);
    for (const search of ['Creative', 'Story']) {
        const result = applyFiltersAndSearch(records, { state: () => panelState({ search }) });
        assert.deepEqual(result.map(item => item.presetName), records.map(item => item.presetName));
    }
});

test('orphan base-name history stays under its original preset target', () => {
    batchUpdate({ groupingManualOverrides: {}, groupingSeriesAliases: {}, groupingTree: {}, nestingEnabled: false });
    const records = ['Story', 'Story V2'].map(snapshot);
    const state = panelState();
    const html = renderSeriesView(records, { state: () => state, archivedCache: () => [] });
    assert.match(html, /data-version-key="openai::Story"/);
    const groups = html.split(/(?=<div class="pas-version-group )/);
    const base = groups.find(group => group.includes('data-version-key="openai::Story"'));
    const version = groups.find(group => group.includes('data-version-key="openai::Story V2"'));
    assert.match(base, /data-snapshot-id="s-0"/);
    assert.doesNotMatch(version, /data-snapshot-id="s-0"/);
    assert.deepEqual(records.map(item => item.presetName), ['Story', 'Story V2']);
});
