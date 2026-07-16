import test from 'node:test';
import assert from 'node:assert/strict';

import {
    fingerprintSnapshotSummaries,
    projectSnapshotSummaries,
    projectSnapshotSummary,
} from '../../modules/core/snapshot-summary.js';

function snapshot(overrides = {}) {
    return {
        id: 'snap-1',
        apiId: 'openai',
        presetName: 'Demo V1',
        timestamp: 123,
        size: 42,
        hash: 'legacy-hash',
        canonicalHash: 'canonical-hash',
        trigger: 'manual',
        cause: { trigger: 'manual', secretContext: 'must-not-copy' },
        name: '<named & safe>',
        pinned: true,
        schemaVersion: 2,
        transactionId: 'tx:snap-1:123',
        parentSnapshotId: 'snap-0',
        saveStatus: 'committed',
        summary: {
            isFirst: false,
            sections: [{ kind: 'field', items: [{ key: 'temperature', from: 0.7, to: 0.8 }] }],
            rawChangedPaths: ['temperature'],
        },
        changeSet: { changedPaths: ['temperature'], secret: 'must-not-copy' },
        preset: {
            api_key_openai: 'sk-must-not-copy',
            prompts: [{ identifier: 'main', content: 'large private prompt' }],
        },
        api_key_openai: 'top-level-secret',
        unknownPayload: { prompt: 'must-not-copy' },
        ...overrides,
    };
}

test('projects the complete panel metadata contract without preset payloads or unknown fields', () => {
    const summary = projectSnapshotSummary(snapshot());

    assert.deepEqual(Object.keys(summary).sort(), [
        'apiId', 'canonicalHash', 'cause', 'changeSet', 'hash', 'id', 'name',
        'parentSnapshotId', 'pinned', 'presetName', 'saveStatus', 'schemaVersion',
        'size', 'summary', 'timestamp', 'transactionId', 'trigger',
    ].sort());
    assert.equal(summary.id, 'snap-1');
    assert.equal(summary.apiId, 'openai');
    assert.equal(summary.presetName, 'Demo V1');
    assert.equal(summary.name, '<named & safe>');
    assert.equal(summary.pinned, true);
    assert.deepEqual(summary.cause, { trigger: 'manual' });
    assert.deepEqual(summary.changeSet, { changedPaths: ['temperature'] });
    assert.equal('preset' in summary, false);
    assert.equal(JSON.stringify(summary).includes('sk-must-not-copy'), false);
    assert.equal(JSON.stringify(summary).includes('large private prompt'), false);
    assert.equal(JSON.stringify(summary).includes('secretContext'), false);
    assert.equal(JSON.stringify(summary).includes('unknownPayload'), false);
});

test('returns immutable independent summary metadata', () => {
    const source = snapshot();
    const summary = projectSnapshotSummary(source);

    source.summary.sections[0].items[0].to = 99;
    source.changeSet.changedPaths.push('prompts');

    assert.equal(summary.summary.sections[0].items[0].to, 0.8);
    assert.deepEqual(summary.changeSet.changedPaths, ['temperature']);
    assert.equal(Object.isFrozen(summary), true);
    assert.equal(Object.isFrozen(summary.summary), true);
    assert.equal(Object.isFrozen(summary.summary.sections), true);
});

test('supports legacy diagnostic defaults without inventing identity', () => {
    const summary = projectSnapshotSummary(snapshot({
        canonicalHash: undefined,
        schemaVersion: undefined,
        transactionId: undefined,
        parentSnapshotId: undefined,
        saveStatus: undefined,
        cause: undefined,
        changeSet: undefined,
    }));

    assert.equal(summary.canonicalHash, 'legacy-hash');
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.transactionId, '');
    assert.equal(summary.parentSnapshotId, null);
    assert.equal(summary.saveStatus, 'legacy');
    assert.deepEqual(summary.cause, { trigger: 'manual' });
    assert.deepEqual(summary.changeSet, { changedPaths: ['temperature'] });
});

test('fails closed for malformed stable identity and batch projection preserves order', () => {
    assert.throws(() => projectSnapshotSummary(snapshot({ id: '' })), /identity/i);
    assert.throws(() => projectSnapshotSummary(snapshot({ timestamp: Number.NaN })), /timestamp/i);

    const summaries = projectSnapshotSummaries([
        snapshot({ id: 'new', timestamp: 20 }),
        snapshot({ id: 'old', timestamp: 10 }),
    ]);
    assert.deepEqual(summaries.map(item => item.id), ['new', 'old']);
    assert.equal(Object.isFrozen(summaries), true);
});

test('summary fingerprints change for payload identity, labels, pins, and content hashes', () => {
    const base = [snapshot()];
    const original = fingerprintSnapshotSummaries(base);

    for (const changed of [
        snapshot({ id: 'snap-2' }),
        snapshot({ name: 'renamed' }),
        snapshot({ pinned: false }),
        snapshot({ hash: 'changed-hash' }),
    ]) {
        assert.notEqual(fingerprintSnapshotSummaries([changed]), original);
    }
    assert.equal(fingerprintSnapshotSummaries([snapshot()]), original);
});
