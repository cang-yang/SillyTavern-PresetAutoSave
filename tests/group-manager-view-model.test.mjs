import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildGroupManagerSummary,
    filterGroupingNodes,
} from '../modules/core/group-manager-view-model.js';

const groups = [
    {
        key: 'story',
        displayName: 'Story Models',
        items: [
            { presetName: 'Story Alpha', manualOverride: false },
            { presetName: 'Custom Beta', manualOverride: true },
        ],
        depth: 0,
    },
    {
        key: 'utility',
        displayName: 'Utility',
        items: [{ presetName: 'Summarizer', manualOverride: false }],
        depth: 0,
    },
];

test('builds compact group, preset and manual override totals', () => {
    assert.deepEqual(buildGroupManagerSummary(groups), {
        groups: 2,
        presets: 3,
        manual: 1,
    });
});

test('group-name matches keep all items while preset matches keep matching rows only', () => {
    assert.equal(filterGroupingNodes(groups, 'story')[0].items.length, 2);

    const filtered = filterGroupingNodes(groups, 'custom beta');
    assert.equal(filtered.length, 1);
    assert.deepEqual(filtered[0].items.map(item => item.presetName), ['Custom Beta']);
});

test('filtering is case-insensitive and does not mutate source nodes', () => {
    const filtered = filterGroupingNodes(groups, 'SUMMARIZER');
    assert.equal(filtered[0].displayName, 'Utility');
    assert.equal(groups[1].items.length, 1);
    assert.notEqual(filtered[0], groups[1]);
});
