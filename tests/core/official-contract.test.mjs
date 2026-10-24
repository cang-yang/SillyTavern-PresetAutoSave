import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { canonicalizePreset, OPENAI_HISTORY_EXCLUDED_FIELDS } from '../../modules/core/preset-schema.js';

const contract = JSON.parse(await readFile(
    new URL('../fixtures/openai-settings-contract.json', import.meta.url),
    'utf8',
));

test('all official connection fields are explicitly excluded from preset history', () => {
    const input = Object.fromEntries(contract.connectionFields.map(field => [field, `probe:${field}`]));
    const { canonical, ignored } = canonicalizePreset(input, { apiId: 'openai' });

    assert.deepEqual(canonical, {});
    assert.deepEqual(ignored.map(entry => entry.path).sort(), [...contract.connectionFields].sort(), contract.source);
});

test('official preset controls are retained except the documented separate global library selector', () => {
    const input = Object.fromEntries(contract.presetFields.map(field => [field, `probe:${field}`]));
    const { canonical, ignored } = canonicalizePreset(input, { apiId: 'openai' });

    const excluded = contract.presetFields.filter(field => OPENAI_HISTORY_EXCLUDED_FIELDS.has(field));
    assert.deepEqual(ignored.map(item => item.path).sort(), excluded.sort());
    assert.deepEqual(Object.keys(canonical).sort(),
        contract.presetFields.filter(field => !OPENAI_HISTORY_EXCLUDED_FIELDS.has(field)).sort(), contract.source);
});
