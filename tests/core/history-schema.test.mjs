import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HISTORY_SCHEMA_VERSION,
    enrichSnapshotList,
    verifyMigratedSnapshotList,
} from '../../modules/core/history-schema.js';

function legacyList() {
    return [
        {
            id: 'new', presetName: 'Demo', apiId: 'openai', timestamp: 20,
            trigger: 'auto', preset: { temperature: 0.8, prompts: [] },
            hash: 'hash-new', size: 50, name: 'keeper', pinned: true,
        },
        {
            id: 'old', presetName: 'Demo', apiId: 'openai', timestamp: 10,
            trigger: 'manual', preset: { temperature: 0.7, prompts: [] },
            hash: 'hash-old', size: 49, name: '', pinned: false,
        },
    ];
}

test('enriches legacy snapshots without changing compatibility fields', () => {
    const legacy = legacyList();
    const migrated = enrichSnapshotList(legacy);

    assert.equal(migrated[0].schemaVersion, HISTORY_SCHEMA_VERSION);
    assert.equal(migrated[0].canonicalHash, 'hash-new');
    assert.equal(migrated[0].parentSnapshotId, 'old');
    assert.equal(migrated[1].parentSnapshotId, null);
    assert.equal(migrated[0].transactionId, 'tx:new:20');
    assert.deepEqual(migrated[0].cause, { trigger: 'auto' });
    assert.equal(migrated[0].saveStatus, 'committed');
    assert.equal(migrated[0].name, 'keeper');
    assert.equal(migrated[0].pinned, true);
    assert.deepEqual(legacy, legacyList(), 'migration must not mutate legacy records');
});

test('recomputes v2 transaction metadata when a merge window updates a snapshot', () => {
    const first = enrichSnapshotList(legacyList());
    const mergedCompatibilityList = [
        {
            ...first[0],
            timestamp: 30,
            hash: 'hash-merged',
            preset: { temperature: 0.9, prompts: [] },
        },
        first[1],
    ];

    const refreshed = enrichSnapshotList(mergedCompatibilityList);
    assert.equal(refreshed[0].canonicalHash, 'hash-merged');
    assert.equal(refreshed[0].transactionId, 'tx:new:30');
    assert.deepEqual(refreshed[0].changeSet.changedPaths, ['temperature']);
});

test('records a compact semantic change set against the parent snapshot', () => {
    const migrated = enrichSnapshotList(legacyList());
    assert.equal(migrated[0].changeSet.meaningful, true);
    assert.deepEqual(migrated[0].changeSet.changedPaths, ['temperature']);
    assert.deepEqual(migrated[0].changeSet.counts, { added: 0, removed: 0, modified: 1 });
    assert.equal(migrated[1].changeSet.meaningful, false);
});

test('verifies identity, user metadata, and hash preservation', () => {
    const legacy = legacyList();
    const migrated = enrichSnapshotList(legacy);
    assert.deepEqual(verifyMigratedSnapshotList(legacy, migrated), { valid: true, errors: [] });

    migrated[0] = { ...migrated[0], pinned: false, canonicalHash: 'wrong' };
    const verification = verifyMigratedSnapshotList(legacy, migrated);
    assert.equal(verification.valid, false);
    assert.match(verification.errors.join(' '), /pinned/);
    assert.match(verification.errors.join(' '), /hash/);
});

test('rejects a migration whose parent snapshot chain was not preserved', () => {
    const legacy = legacyList();
    const migrated = enrichSnapshotList(legacy);
    migrated[0] = { ...migrated[0], parentSnapshotId: null };

    const verification = verifyMigratedSnapshotList(legacy, migrated);
    assert.equal(verification.valid, false);
    assert.match(verification.errors.join(' '), /parentSnapshotId/);
});
