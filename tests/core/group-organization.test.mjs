import test from 'node:test';
import assert from 'node:assert/strict';
import {
    updateGroupAlias, setGroupParent, removeGroupParent, selectGroupDefault,
} from '../../modules/core/group-organization.js';
import { getNodePath, normalizeSeriesKey } from '../../modules/preset-grouping.js';

test('alias updates preserve literal keys and remove normalized duplicates without mutating input', () => {
    for (const key of ['__proto__', 'constructor', 'story']) {
        const original = { other: 'Other' };
        const renamed = updateGroupAlias(original, key, 'Label', key, normalizeSeriesKey);
        assert.equal(Object.hasOwn(renamed, key), true);
        assert.equal(renamed[key], 'Label');
        assert.equal(Object.getPrototypeOf(renamed), Object.prototype);
        assert.deepEqual(updateGroupAlias(renamed, key, key, key, normalizeSeriesKey), original);
        assert.deepEqual(original, { other: 'Other' });
    }
    assert.deepEqual(updateGroupAlias({ STORY: 'Old', other: 'Other' }, 'story', 'New', 'Story', normalizeSeriesKey),
        { other: 'Other', story: 'New' });
});

test('parent edits preserve literal keys and deletion promotes children using own edges only', () => {
    const original = setGroupParent({}, '__proto__', 'root');
    const nested = setGroupParent(original, 'child', '__proto__');
    assert.deepEqual(getNodePath(nested, 'child'), ['root', '__proto__', 'child']);
    assert.deepEqual(removeGroupParent(nested, '__proto__'), { child: 'root' });
    assert.deepEqual(removeGroupParent({ child: '__proto__' }, '__proto__'), {});
    assert.equal(Object.hasOwn(original, '__proto__'), true);
    assert.deepEqual(setGroupParent(original, '__proto__', null), {});
    assert.deepEqual(getNodePath(Object.create({ child: 'fake' }), 'child'), ['child']);
});

test('default selection and toggle use literal group identity and preserve independent entries', () => {
    const original = { other: 'Other V1' };
    const selected = selectGroupDefault(original, '__proto__', 'Demo');
    assert.equal(Object.hasOwn(selected, '__proto__'), true);
    assert.equal(selected.__proto__, 'Demo');
    assert.deepEqual(selectGroupDefault(selected, '__proto__', 'Demo', { toggle: true }), original);
    assert.equal(selectGroupDefault(selected, '__proto__', 'Next', { toggle: true }).__proto__, 'Next');
    assert.deepEqual(original, { other: 'Other V1' });
});
