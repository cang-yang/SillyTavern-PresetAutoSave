import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('panel warm cache preserves strong consistency after history mutations', async () => {
    const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');

    assert.match(source, /function loadPanelDataset\(\{ allowCache = true \} = \{\}\)/);
    assert.doesNotMatch(source, /async function loadPanelDataset/);
    assert.match(source, /function invalidatePanelDataCache\(\) \{\s*_panelDataCacheGeneration\+\+/s);
    assert.match(source, /if \(generation === _panelDataCacheGeneration\)/);
    assert.match(source, /async function refreshData\(options = \{ allowCache: false \}\)/);
    assert.match(source, /async function refreshData[\s\S]*?clearTimeout\(_historyRefreshTimer\)/);
    assert.match(source, /refreshData: \(options\) => refreshData\(options\)/);
});
