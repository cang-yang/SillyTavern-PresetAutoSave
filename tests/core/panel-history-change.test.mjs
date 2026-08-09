import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPanelHistoryChange } from '../../modules/core/panel-history-change.js';

function snapshot(id, timestamp, overrides = {}) {
    return {
        id,
        apiId: 'openai',
        presetName: 'Mobile preset',
        timestamp,
        preset: { temperature: 0.7 },
        hash: `hash-${id}`,
        trigger: 'auto',
        ...overrides,
    };
}

test('adds one payload-free summary in newest-first order', () => {
    const current = [
        applyPanelHistoryChange([], { type: 'snapshot-added', snapshot: snapshot('old', 10) }).summaries[0],
    ];

    const result = applyPanelHistoryChange(current, {
        type: 'snapshot-added',
        snapshot: snapshot('new', 20),
    });

    assert.equal(result.handled, true);
    assert.deepEqual(result.summaries.map(item => item.id), ['new', 'old']);
    assert.equal('preset' in result.summaries[0], false);
    assert.equal(Object.isFrozen(result.summaries), true);
});

test('replaces an updated snapshot without duplicating its identity', () => {
    const first = applyPanelHistoryChange([], {
        type: 'snapshot-added',
        snapshot: snapshot('same', 10),
    }).summaries;

    const result = applyPanelHistoryChange(first, {
        type: 'snapshot-updated',
        snapshot: snapshot('same', 30, { pinned: true }),
    });

    assert.equal(result.handled, true);
    assert.equal(result.summaries.length, 1);
    assert.equal(result.summaries[0].timestamp, 30);
    assert.equal(result.summaries[0].pinned, true);
});

test('removes snapshots trimmed by the authoritative retention policy', () => {
    const current = ['oldest', 'kept'].map((id, index) => (
        applyPanelHistoryChange([], {
            type: 'snapshot-added',
            snapshot: snapshot(id, 10 + index),
        }).summaries[0]
    ));

    const result = applyPanelHistoryChange(current, {
        type: 'snapshot-added',
        snapshot: snapshot('newest', 30),
        removedIds: ['oldest'],
    });

    assert.deepEqual(result.summaries.map(item => item.id), ['newest', 'kept']);
});

test('fails closed for unsupported or malformed changes', () => {
    const current = Object.freeze([]);

    assert.deepEqual(applyPanelHistoryChange(current, {
        type: 'history-pruned',
        presetName: 'Mobile preset',
    }), { handled: false, summaries: current });
    assert.deepEqual(applyPanelHistoryChange(current, {
        type: 'snapshot-added',
        snapshot: { id: 'missing-stable-fields' },
    }), { handled: false, summaries: current });
});
