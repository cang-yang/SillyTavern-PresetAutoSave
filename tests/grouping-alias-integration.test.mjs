import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    buildNestedGroupTree,
    findSeriesAssignment,
    groupNamesBySeries,
    groupSnapshotsBySeries,
} from '../modules/preset-grouping.js';

test('nested group rendering uses aliases while preserving canonical tree keys', () => {
    const roots = buildNestedGroupTree(
        ['Story V1', 'Story V2', 'Utility V1'],
        {},
        { story: 'utility' },
        3,
        { story: 'Creative', utility: 'Tools' },
    );

    assert.equal(roots.length, 1);
    assert.equal(roots[0].key, 'utility');
    assert.equal(roots[0].displayName, 'Tools');
    assert.equal(roots[0].children[0].key, 'story');
    assert.equal(roots[0].children[0].displayName, 'Creative');
});

test('history groups expose aliases without changing the stable series key', () => {
    const grouped = groupSnapshotsBySeries([
        { id: '1', apiId: 'openai', presetName: 'Story V1', timestamp: 1, size: 10 },
        { id: '2', apiId: 'openai', presetName: 'Story V2', timestamp: 2, size: 10 },
    ], { aliases: { story: 'Creative' } });

    const group = [...grouped.values()][0];
    assert.equal(group.canonicalKey, 'story');
    assert.equal(group.automaticName, 'Story');
    assert.equal(group.series, 'Creative');
});

test('every user-facing grouping consumer reads the alias setting', async () => {
    const files = [
        '../modules/preset-takeover.js',
        '../modules/history-panel.js',
        '../modules/panel-list-render.js',
        '../modules/panel-actions.js',
        '../modules/panel-group-manager.js',
    ];

    for (const file of files) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        assert.match(source, /groupingSeriesAliases/, `${file} must consume groupingSeriesAliases`);
    }
});

test('settings reset clears group aliases alongside manual membership overrides', async () => {
    const source = await readFile(new URL('../modules/panel-settings-log.js', import.meta.url), 'utf8');
    assert.match(source, /groupingSeriesAliases:\s*\{\}/);
});

test('import assignment displays an alias but persists the canonical automatic name', () => {
    const groups = groupNamesBySeries(['Story V1'], {}, { story: 'Creative' });
    assert.deepEqual(findSeriesAssignment('Story', groups), {
        canonicalName: 'Story',
        displayName: 'Creative',
    });
});

test('conflicting imported aliases fall back without merging unrelated groups', () => {
    const aliases = { story: 'Same', utility: 'Same' };
    const groups = groupNamesBySeries(['Story V1', 'Utility V1'], {}, aliases);
    assert.deepEqual(groups.map(group => group.series).sort(), ['Story', 'Utility']);

    const history = groupSnapshotsBySeries([
        { id: '1', apiId: 'openai', presetName: 'Story V1', timestamp: 1, size: 10 },
        { id: '2', apiId: 'openai', presetName: 'Utility V1', timestamp: 2, size: 10 },
    ], { aliases });
    assert.equal(history.size, 2);
});
