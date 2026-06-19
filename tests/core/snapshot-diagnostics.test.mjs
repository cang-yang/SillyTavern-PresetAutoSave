import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getSnapshotDiagnostics,
    getSnapshotSummary,
} from '../../modules/core/snapshot-diagnostics.js';

test('projects legacy snapshot evidence with safe fallbacks', () => {
    const snapshot = { hash: 'legacy-hash', trigger: 'manual', summary: { isFirst: true } };
    assert.deepEqual(getSnapshotDiagnostics(snapshot), {
        schemaVersion: 1,
        canonicalHash: 'legacy-hash',
        transactionId: '',
        parentSnapshotId: null,
        saveStatus: 'legacy',
        trigger: 'manual',
        changedPaths: [],
    });
    assert.deepEqual(getSnapshotSummary(snapshot), { isFirst: true });
});

test('projects v2 transaction fields and unique changed paths', () => {
    const snapshot = {
        schemaVersion: 2,
        canonicalHash: 'canonical',
        transactionId: 'tx:1',
        parentSnapshotId: 'parent',
        saveStatus: 'committed',
        cause: { trigger: 'switch_guard' },
        changeSet: { changedPaths: ['temperature', 'prompts[0].content', 'temperature'] },
    };
    assert.deepEqual(getSnapshotDiagnostics(snapshot), {
        schemaVersion: 2,
        canonicalHash: 'canonical',
        transactionId: 'tx:1',
        parentSnapshotId: 'parent',
        saveStatus: 'committed',
        trigger: 'switch_guard',
        changedPaths: ['temperature', 'prompts[0].content'],
    });
});

test('adds v2 changed paths to an otherwise empty legacy summary', () => {
    const snapshot = {
        summary: { isFirst: false, sections: [] },
        changeSet: { changedPaths: ['tool_choice', 'extensions.foo'] },
    };
    assert.deepEqual(getSnapshotSummary(snapshot), {
        isFirst: false,
        sections: [],
        rawChangedPaths: ['tool_choice', 'extensions.foo'],
    });
    assert.equal(snapshot.summary.rawChangedPaths, undefined, 'projection must not mutate stored snapshots');
});
