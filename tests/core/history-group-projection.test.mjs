import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHistoryGroups } from '../../modules/core/history-group-projection.js';
import { groupSnapshotsBySeries } from '../../modules/preset-grouping.js';

test('native zero-snapshot versions share aliases but retain exact case-sensitive preset targets', () => {
    const groups = projectHistoryGroups({
        snapshots: [], apiId: 'openai', aliases: { story: 'Creative' },
        nativePresets: [
            { apiId: 'openai', presetName: 'Story V1' },
            { apiId: 'openai', presetName: 'story V1' },
            { apiId: 'other', presetName: 'Story V2' },
        ],
    });
    assert.deepEqual([...groups.keys()], ['story']);
    assert.equal(groups.get('story').displayName, 'Creative');
    assert.deepEqual(groups.get('story').versions.map(version => version.presetName), ['Story V1', 'story V1']);
    assert.ok(groups.get('story').versions.every(version => version.available));
});

test('history projection keeps original targets and cache unchanged when merging archives', () => {
    const snapshots = [
        { id: 'base', apiId: 'openai', presetName: 'Story', timestamp: 2, size: 10 },
        { id: 'v2', apiId: 'openai', presetName: 'Story V2', timestamp: 1, size: 20 },
    ];
    const cachedGroups = groupSnapshotsBySeries(snapshots);
    const original = structuredClone(cachedGroups);
    const groups = projectHistoryGroups({
        snapshots, cachedGroups, apiId: 'openai',
        nativePresets: [{ apiId: 'openai', presetName: 'Story V2' }],
        archives: [{ apiId: 'openai', presetName: 'Story', archivedAt: 3 }],
    });
    const versions = groups.get('story').versions;
    assert.equal(versions.find(version => version.presetName === 'Story').archived, true);
    assert.deepEqual(versions.find(version => version.presetName === 'Story').snapshots.map(snapshot => snapshot.id), ['base']);
    assert.deepEqual(versions.find(version => version.presetName === 'Story V2').snapshots.map(snapshot => snapshot.id), ['v2']);
    assert.deepEqual(cachedGroups, original);
});

test('active history filters omit empty targets without using unfiltered cached counts', () => {
    const snapshots = [
        { id: 'base', apiId: 'openai', presetName: 'Story', timestamp: 2, size: 10 },
        { id: 'v2', apiId: 'openai', presetName: 'Story V2', timestamp: 1, size: 20 },
    ];
    const groups = projectHistoryGroups({
        snapshots: snapshots.slice(0, 1), cachedGroups: groupSnapshotsBySeries(snapshots),
        apiId: 'openai', hideEmpty: true,
        nativePresets: [{ apiId: 'openai', presetName: 'Utility V1' }],
    });
    assert.equal(groups.size, 1);
    assert.equal(groups.get('story').snapshotCount, 1);
    assert.equal(groups.get('story').versions.length, 1);
});
