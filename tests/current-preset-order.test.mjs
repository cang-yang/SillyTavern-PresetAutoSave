import assert from 'node:assert/strict';
import test from 'node:test';
import { currentFirst, orderPresetTree } from '../modules/core/current-preset-order.js';

test('current-first projection is stable and never mutates its input', () => {
    const entries = Object.freeze(['Zulu V3', 'Alpha', 'Zulu V1', 'Beta']);
    assert.deepEqual(currentFirst(entries, name => name === 'Zulu V1'), ['Zulu V1', 'Zulu V3', 'Alpha', 'Beta']);
    assert.deepEqual(currentFirst(entries, () => false), entries);
    assert.deepEqual(entries, ['Zulu V3', 'Alpha', 'Zulu V1', 'Beta']);
});

test('nested projection prioritizes the whole current path without changing ownership', () => {
    const nodes = [{ key: 'alpha', items: ['Alpha'], children: [] }, {
        key: 'parent', items: ['Parent'], children: [
            { key: 'beta', items: ['Beta'], children: [] },
            { key: 'zulu', items: ['Zulu V3', 'Zulu V1'], children: [] },
        ],
    }];
    const before = structuredClone(nodes);
    const ordered = orderPresetTree(nodes, 'Zulu V1');
    assert.equal(ordered[0].key, 'parent');
    assert.equal(ordered[0].containsCurrentPreset, true);
    assert.equal(ordered[0].children[0].key, 'zulu');
    assert.deepEqual(ordered[0].children[0].items, ['Zulu V1', 'Zulu V3']);
    assert.deepEqual(ordered[0].items, ['Parent']);
    assert.deepEqual(nodes, before);
    assert.deepEqual(orderPresetTree(nodes, 'zulu v1').map(node => node.key), ['alpha', 'parent']);
});
