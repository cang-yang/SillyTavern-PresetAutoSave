import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    INITIAL_SNAPSHOT_RENDER_LIMIT,
    BULK_SNAPSHOT_RENDER_LIMIT,
    SNAPSHOT_RENDER_INCREMENT,
    getBoundedSnapshotWindow,
    increaseSnapshotRenderLimit,
} from '../modules/core/bounded-snapshot-list.js';

test('large expanded groups render a bounded first window with a continuation count', () => {
    const snapshots = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }));
    const window = getBoundedSnapshotWindow(snapshots);

    assert.equal(INITIAL_SNAPSHOT_RENDER_LIMIT, 5);
    assert.equal(BULK_SNAPSHOT_RENDER_LIMIT, 0);
    assert.equal(window.items.length, 5);
    assert.equal(window.remaining, 15);
    assert.equal(window.total, 20);
    assert.deepEqual(window.items.map(item => item.id), [1, 2, 3, 4, 5]);
});

test('show more grows one group without exceeding its complete history', () => {
    assert.equal(SNAPSHOT_RENDER_INCREMENT, 10);
    assert.equal(increaseSnapshotRenderLimit(undefined, 20), 15);
    assert.equal(increaseSnapshotRenderLimit(15, 20), 20);
    assert.equal(increaseSnapshotRenderLimit(20, 20), 20);
});

test('series and flat renderers both consume the bounded snapshot seam', async () => {
    const source = await readFile(new URL('../modules/panel-list-render.js', import.meta.url), 'utf8');
    assert.match(source, /getBoundedSnapshotWindow\(snapshots/);
    assert.match(source, /getBoundedSnapshotWindow\(ver\.snapshots/);
    assert.match(source, /pas-btn-show-more-snapshots/);
});

test('panel search feedback is scheduled within the interaction budget', async () => {
    const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');
    assert.match(source, /const PANEL_SEARCH_DEBOUNCE_MS = 60;/);
    assert.match(source, /_state\.search = e\.target\.value\.trim\(\);\s+renderListTabImmediately\(\);\s+}, PANEL_SEARCH_DEBOUNCE_MS\);/);
});
