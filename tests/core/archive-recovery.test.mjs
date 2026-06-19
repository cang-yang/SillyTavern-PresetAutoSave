import test from 'node:test';
import assert from 'node:assert/strict';

import { restoreArchiveEntries } from '../../modules/core/archive-recovery.js';

function entry(overrides = {}) {
    return {
        apiId: 'openai',
        presetName: 'Preset A',
        data: { temperature: 0.5 },
        ...overrides,
    };
}

test('archive recovery writes the newest valid snapshot and removes recovery data afterwards', async () => {
    const order = [];
    const result = await restoreArchiveEntries([entry()], {
        getSnapshots: async () => [
            { id: 'older', timestamp: 10, preset: { temperature: 0.6 } },
            { id: 'newest', timestamp: 30, preset: { temperature: 0.9 } },
            { id: 'invalid', timestamp: 50, preset: null },
        ],
        persistPreset: async (archive, preset) => {
            order.push(['persist', archive.presetName, preset]);
        },
        removeArchive: async archive => {
            order.push(['remove', archive.presetName]);
            return true;
        },
    });

    assert.deepEqual(order, [
        ['persist', 'Preset A', { temperature: 0.9 }],
        ['remove', 'Preset A'],
    ]);
    assert.deepEqual(result, {
        restored: 1,
        failed: 0,
        cleanupFailed: 0,
        fromSnapshot: 1,
        fromArchive: 0,
    });
});

test('archive recovery keeps recovery data when the preset write rejects', async () => {
    let removed = false;
    const result = await restoreArchiveEntries([entry()], {
        getSnapshots: async () => [],
        persistPreset: async () => { throw new Error('write rejected'); },
        removeArchive: async () => { removed = true; return true; },
    });

    assert.equal(removed, false);
    assert.deepEqual(result, {
        restored: 0,
        failed: 1,
        cleanupFailed: 0,
        fromSnapshot: 0,
        fromArchive: 0,
    });
});

test('archive recovery reports cleanup failure without pretending the write failed', async () => {
    const result = await restoreArchiveEntries([entry()], {
        getSnapshots: async () => [],
        persistPreset: async () => undefined,
        removeArchive: async () => false,
    });

    assert.deepEqual(result, {
        restored: 1,
        failed: 0,
        cleanupFailed: 1,
        fromSnapshot: 0,
        fromArchive: 1,
    });
});

test('archive recovery rejects malformed entries without invoking dependencies', async () => {
    let invoked = false;
    const result = await restoreArchiveEntries([null, entry({ presetName: '' })], {
        getSnapshots: async () => { invoked = true; return []; },
        persistPreset: async () => { invoked = true; },
        removeArchive: async () => { invoked = true; return true; },
    });

    assert.equal(invoked, false);
    assert.equal(result.failed, 2);
    assert.equal(result.restored, 0);
});

test('archive recovery falls back to archived content when snapshot lookup fails', async () => {
    let restoredPreset;
    const result = await restoreArchiveEntries([entry({ data: { top_p: 0.8 } })], {
        getSnapshots: async () => { throw new Error('history unavailable'); },
        persistPreset: async (_archive, preset) => { restoredPreset = preset; },
        removeArchive: async () => true,
    });

    assert.deepEqual(restoredPreset, { top_p: 0.8 });
    assert.equal(result.fromArchive, 1);
    assert.equal(result.failed, 0);
});
