import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const panelSource = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');
const actionSource = await readFile(new URL('../modules/panel-actions.js', import.meta.url), 'utf8');

test('history panel opens from summary catalog instead of complete snapshot payloads', () => {
    assert.match(panelSource, /getSnapshotSummaries/);
    assert.doesNotMatch(panelSource, /\bgetAllSnapshots\b/);
    assert.match(panelSource, /Promise\.all\(\[\s*getSnapshotSummaries\(\{ onProgress \}\)/s);
    assert.match(panelSource, /listArchivedPresetSummaries\(\)/);
    assert.doesNotMatch(panelSource, /\blistArchivedPresets\b/);
});

test('panel open no longer owns a full-payload TTL cache or background warmup', () => {
    assert.doesNotMatch(panelSource, /PANEL_DATA_CACHE_TTL_MS/);
    assert.doesNotMatch(panelSource, /warmupPanelData/);
    assert.doesNotMatch(panelSource, /_panelDataWarmupPromise/);
});

test('payload-dependent card actions retain authoritative lazy lookup', () => {
    for (const action of ['onView', '_onRestoreImpl', 'onExportPreset', 'onStartDiff']) {
        const start = actionSource.indexOf(`function ${action}`);
        assert.notEqual(start, -1, `missing ${action}`);
        assert.match(actionSource.slice(start, start + 3500), /getSnapshotById\(/);
    }
});
