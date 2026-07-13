import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { renderHistoryImportPreview } from '../modules/import-preview.js';

const identity = value => String(value);

function preview(overrides = {}) {
    return {
        sourceVersion: 2,
        schemaVersion: 2,
        presetCount: 3,
        snapshotCount: 18,
        overlappingPresetCount: 1,
        duplicateSnapshotCount: 2,
        conflictCount: 0,
        conflicts: [],
        modes: {
            merge: {
                available: true,
                importedSnapshotCount: 16,
                finalPresetCount: 5,
                finalSnapshotCount: 31,
                removedPresetCount: 0,
            },
            replace: {
                available: true,
                importedSnapshotCount: 18,
                finalPresetCount: 3,
                finalSnapshotCount: 18,
                removedPresetCount: 2,
            },
        },
        ...overrides,
    };
}

test('renders an understandable import preview with merge selected by default', () => {
    const html = renderHistoryImportPreview(preview(), {
        t: (key, vars = {}) => `${key}${vars.count === undefined ? '' : `:${vars.count}`}`,
        escapeHtml: identity,
    });

    assert.match(html, /class="pas-import-preview"/);
    assert.match(html, /Import Preview Presets[^<]*3/);
    assert.match(html, /Import Preview Snapshots[^<]*18/);
    assert.match(html, /name="pas-import-mode" value="merge" checked/);
    assert.match(html, /name="pas-import-mode" value="replace"/);
    assert.match(html, /data-import-confirm/);
    assert.match(html, /Import Preview Replace Removes:2/);
});

test('requires an explicit destructive choice when merge conflicts exist', () => {
    const value = preview({
        conflictCount: 1,
        conflicts: [{ key: 'openai::Demo', snapshotId: 'collision' }],
        modes: {
            ...preview().modes,
            merge: { ...preview().modes.merge, available: false },
        },
    });
    const html = renderHistoryImportPreview(value, { t: identity, escapeHtml: identity });

    assert.match(html, /value="merge" disabled/);
    assert.doesNotMatch(html, /value="replace" checked/);
    assert.match(html, /data-import-confirm[^>]*disabled/);
    assert.match(html, /Import Preview Conflict Detail/);
});

test('settings import flow previews before applying the selected mode', async () => {
    const source = await readFile(new URL('../modules/panel-settings-log.js', import.meta.url), 'utf8');
    const previewAt = source.indexOf('previewImportAll(data)');
    const chooseAt = source.indexOf('chooseHistoryImportMode(preview)');
    const importAt = source.indexOf('importAll(data, mode)');

    assert.ok(previewAt >= 0);
    assert.ok(chooseAt > previewAt);
    assert.ok(importAt > chooseAt);
});

test('dialog styles are part of the production stylesheet stack', async () => {
    const styles = await readFile(new URL('../styles/index.css', import.meta.url), 'utf8');
    assert.match(styles, /@import url\('\.\/dialogs\.css'\)/);
});
