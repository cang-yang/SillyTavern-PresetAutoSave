import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');

test('panel dataset failures reach the production error state', () => {
    assert.doesNotMatch(source, /getAllSnapshots\(\)\.catch\(\(\) => \[\]\)/);
    assert.doesNotMatch(source, /listArchivedPresets\(\)\.catch\(\(\) => \[\]\)/);
    assert.match(source, /pas-panel-error[^]*?role="alert"/);
    assert.match(source, /escapeHtml\(t\('Panel Open Failed'/);
});

test('every deferred controller render is cleared by mount disposal', () => {
    assert.doesNotMatch(source, /let _panelRefreshTimer = null/);
    assert.match(source, /let _panelSearchTimer = null/);
    assert.match(source, /let _panelLogSearchTimer = null/);
    assert.match(source, /let _panelPresetRefreshTimer = null/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelSearchTimer\)/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelLogSearchTimer\)/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelPresetRefreshTimer\)/);
});
