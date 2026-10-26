import test from 'node:test';
import assert from 'node:assert/strict';
import { groupNamesBySeries, normalizeSeriesKey } from '../../modules/preset-grouping.js';
import { movePresetMembership, removeGroupMembership } from '../../modules/core/group-membership.js';

const names = ['Story V1', 'Utility V1'];
const aliases = { story: 'Creative' };

test('move to an aliased group persists automatic membership, not display text', () => {
    const groups = groupNamesBySeries(names, {}, aliases);
    const overrides = {};
    const result = movePresetMembership({
        presetName: 'Utility V1', targetKey: 'story', automaticKey: 'utility',
        groups, overrides, normalize: normalizeSeriesKey, newGroupName: 'Creative',
    });
    assert.deepEqual(result, { 'Utility V1': 'Story' });
    assert.deepEqual(overrides, {});
    assert.equal(groupNamesBySeries(names, result, aliases).length, 1);
});

test('removing an aliased group clears only its canonical manual members', () => {
    const overrides = { 'Utility V1': 'Story', 'Other V1': 'Elsewhere' };
    const groups = groupNamesBySeries([...names, 'Other V1'], overrides, aliases);
    const result = removeGroupMembership({
        canonicalKey: 'story', groups, overrides, normalize: normalizeSeriesKey,
    });
    assert.deepEqual(result, { 'Other V1': 'Elsewhere' });
    assert.deepEqual(overrides, { 'Utility V1': 'Story', 'Other V1': 'Elsewhere' });
});

test('moving a prototype-shaped preset name preserves its literal canonical identity', () => {
    const result = movePresetMembership({
        presetName: '__proto__', targetKey: 'story', automaticKey: 'proto',
        groups: groupNamesBySeries(names), overrides: {},
    });
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.__proto__, 'Story');
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
});
