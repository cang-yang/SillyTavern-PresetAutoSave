import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel catalog refresh preserves consistency without warming complete payloads', async () => {
    const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');

    assert.match(source, /getSnapshotSummaries/);
    assert.doesNotMatch(source, /getAllSnapshots/);
    assert.doesNotMatch(source, /PANEL_DATA_CACHE_TTL_MS/);
    assert.doesNotMatch(source, /warmupPanelData/);
    assert.match(source, /async function refreshData\(/);
    assert.match(source, /async function refreshData[\s\S]*?clearTimeout\(_historyRefreshTimer\)/);
    assert.match(source, /refreshData: \(options\) => refreshData\(options\)/);
});

test('panel prepares the series projection even when it opens in flat view', async () => {
    const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');
    const cacheAssignment = source.indexOf('_state._cachedSeriesMap = seriesMap;');
    const seriesOnlyExpansion = source.indexOf("if (_state.viewMode === 'series')");

    assert.notEqual(cacheAssignment, -1, 'series projection should be cached');
    assert.notEqual(seriesOnlyExpansion, -1, 'series-only expansion policy should remain explicit');
    assert.ok(
        cacheAssignment < seriesOnlyExpansion,
        'series projection must be prepared before the series-only expansion branch',
    );
});
