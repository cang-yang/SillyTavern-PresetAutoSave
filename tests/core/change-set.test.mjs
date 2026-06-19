import test from 'node:test';
import assert from 'node:assert/strict';

import { createChangeSet, assertExplainableChange } from '../../modules/core/change-set.js';
import { stableStringify } from '../../modules/core/value-utils.js';

test('explains tool recurse limit changes', () => {
    const result = createChangeSet(
        { tool_call_recurse_limit: 3 },
        { tool_call_recurse_limit: 5 },
    );

    assert.deepEqual(result.changed.map(item => item.path), ['tool_call_recurse_limit']);
    assert.equal(result.meaningful, true);
    assert.equal(result.counts.modified, 1);
});

test('explains extension changes instead of producing a minor change', () => {
    const result = createChangeSet(
        { extensions: { foo: { enabled: false } } },
        { extensions: { foo: { enabled: true } } },
    );

    assert.deepEqual(result.changed.map(item => item.path), ['extensions.foo.enabled']);
});

test('reports added and removed object paths', () => {
    const result = createChangeSet(
        { old_setting: 1, stable: true },
        { new_setting: 2, stable: true },
    );

    assert.deepEqual(result.changed.map(item => [item.path, item.kind]), [
        ['new_setting', 'added'],
        ['old_setting', 'removed'],
    ]);
    assert.deepEqual(result.counts, { added: 1, removed: 1, modified: 0 });
});

test('preserves prompt identity when reporting content changes', () => {
    const result = createChangeSet(
        { prompts: [{ identifier: 'main', content: 'before' }] },
        { prompts: [{ identifier: 'main', content: 'after text' }] },
    );

    assert.deepEqual(result.changed.map(item => item.path), ['prompts[main].content']);
    assert.equal(result.changed[0].before.length, 6);
    assert.equal(result.changed[0].after.length, 10);
});

test('canonical inequality always has an explanation', () => {
    const regressionPairs = [
        [{ tool_call_recurse_limit: 3 }, { tool_call_recurse_limit: 4 }],
        [{ extensions: { a: 1 } }, { extensions: { a: 2 } }],
        [{ prompt_order: [{ order: ['a', 'b'] }] }, { prompt_order: [{ order: ['b', 'a'] }] }],
        [{ unknown_future_field: false }, { unknown_future_field: true }],
    ];

    for (const [before, after] of regressionPairs) {
        assert.notEqual(stableStringify(before), stableStringify(after));
        const changeSet = createChangeSet(before, after);
        assert.notEqual(changeSet.changed.length, 0);
        assert.doesNotThrow(() => assertExplainableChange(before, after, changeSet));
    }
});

test('invariant rejects an unexplained hash change', () => {
    assert.throws(
        () => assertExplainableChange({ a: 1 }, { a: 2 }, { changed: [] }),
        /Unexplained canonical change/,
    );
});
