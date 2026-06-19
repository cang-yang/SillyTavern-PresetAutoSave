import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { canonicalizePreset } from '../../modules/core/preset-schema.js';

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

test('all official preset fields remain part of canonical history', () => {
    const input = Object.fromEntries(contract.presetFields.map(field => [field, `probe:${field}`]));
    const { canonical, ignored } = canonicalizePreset(input, { apiId: 'openai' });

    assert.deepEqual(ignored, []);
    assert.deepEqual(Object.keys(canonical).sort(), [...contract.presetFields].sort(), contract.source);
});
