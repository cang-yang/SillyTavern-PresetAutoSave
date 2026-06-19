import test from 'node:test';
import assert from 'node:assert/strict';

import { runDeleteRecovery } from '../../modules/core/lifecycle-recovery.js';

test('delete recovery clears stores only after every restore succeeds', async () => {
    const order = [];
    const result = await runDeleteRecovery({
        restoreArchives: async () => {
            order.push('restore-archives');
            return { failed: 0, cleanupFailed: 0 };
        },
        writeBackSnapshots: async () => {
            order.push('write-snapshots');
            return { written: 2, skipped: 1, failed: 0 };
        },
        clearSnapshots: async () => { order.push('clear-snapshots'); },
        clearArchives: async () => { order.push('clear-archives'); return true; },
    });

    assert.deepEqual(order, [
        'restore-archives',
        'write-snapshots',
        'clear-snapshots',
        'clear-archives',
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.snapshotsCleared, true);
    assert.equal(result.archivesCleared, true);
});

test('delete recovery preserves both stores when archive restoration is incomplete', async () => {
    let clears = 0;
    const result = await runDeleteRecovery({
        restoreArchives: async () => ({ failed: 1, cleanupFailed: 0 }),
        writeBackSnapshots: async () => ({ written: 0, skipped: 0, failed: 0 }),
        clearSnapshots: async () => { clears++; },
        clearArchives: async () => { clears++; return true; },
    });

    assert.equal(clears, 0);
    assert.equal(result.complete, false);
    assert.equal(result.snapshotsCleared, false);
    assert.equal(result.archivesCleared, false);
});

test('delete recovery preserves snapshots when any snapshot writeback fails', async () => {
    let snapshotsCleared = false;
    const result = await runDeleteRecovery({
        restoreArchives: async () => ({ failed: 0, cleanupFailed: 0 }),
        writeBackSnapshots: async () => ({ written: 1, skipped: 0, failed: 1 }),
        clearSnapshots: async () => { snapshotsCleared = true; },
        clearArchives: async () => true,
    });

    assert.equal(snapshotsCleared, false);
    assert.equal(result.archivesCleared, true);
    assert.equal(result.complete, false);
});

test('delete recovery treats rejected or unconfirmed cleanup as incomplete', async () => {
    const result = await runDeleteRecovery({
        restoreArchives: async () => ({ failed: 0, cleanupFailed: 0 }),
        writeBackSnapshots: async () => ({ written: 1, skipped: 0, failed: 0 }),
        clearSnapshots: async () => { throw new Error('indexeddb unavailable'); },
        clearArchives: async () => false,
    });

    assert.equal(result.complete, false);
    assert.equal(result.snapshotsCleared, false);
    assert.equal(result.archivesCleared, false);
    assert.match(result.errors.snapshots, /indexeddb unavailable/);
    assert.match(result.errors.archives, /not confirmed/);
});

test('delete recovery converts thrown restore operations into safe failure results', async () => {
    let clears = 0;
    const result = await runDeleteRecovery({
        restoreArchives: async () => { throw new Error('archive db failed'); },
        writeBackSnapshots: async () => { throw new Error('history db failed'); },
        clearSnapshots: async () => { clears++; },
        clearArchives: async () => { clears++; return true; },
    });

    assert.equal(clears, 0);
    assert.equal(result.complete, false);
    assert.equal(result.archive.failed, 1);
    assert.equal(result.snapshots.failed, 1);
});
