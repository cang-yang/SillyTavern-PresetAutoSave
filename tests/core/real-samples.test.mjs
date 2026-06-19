import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { canonicalizePreset } from '../../modules/core/preset-schema.js';
import { createChangeSet, assertExplainableChange } from '../../modules/core/change-set.js';
import { stableStringify } from '../../modules/core/value-utils.js';

const fixture = JSON.parse(await readFile(
    new URL('../fixtures/chat-completion-structure.json', import.meta.url),
    'utf8',
));

function mutate(value) {
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'string') return `${value}__changed`;
    if (Array.isArray(value)) return [...value, { fixture_added: true }];
    if (value && typeof value === 'object') return { ...value, fixture_added: true };
    return 'changed';
}

test('every observed preset field mutation is ignored explicitly or explained', () => {
    for (const key of Object.keys(fixture)) {
        const changedInput = structuredClone(fixture);
        changedInput[key] = mutate(changedInput[key]);
        const before = canonicalizePreset(fixture);
        const after = canonicalizePreset(changedInput);

        if (stableStringify(before.canonical) === stableStringify(after.canonical)) {
            assert.ok(after.ignored.some(item => item.path === key), `${key} changed without an ignored reason`);
            continue;
        }

        const changeSet = createChangeSet(before.canonical, after.canonical);
        assertExplainableChange(before.canonical, after.canonical, changeSet);
        assert.ok(
            changeSet.changed.some(item => item.path === key || item.path.startsWith(`${key}.`) || item.path.startsWith(`${key}[`)),
            `${key} changed without a matching path`,
        );
    }
});
