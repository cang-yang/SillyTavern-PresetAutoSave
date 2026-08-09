import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareRestoreBaseline } from '../../modules/core/restore-baseline.js';

test('prepares an immutable restore baseline with the verified target API', () => {
    const preset = { temperature: 0.7, prompts: [{ identifier: 'main' }] };
    const hashCalls = [];

    const result = prepareRestoreBaseline({
        apiId: 'openai',
        presetName: 'Mobile target',
        preset,
    }, {
        hashPreset(value, apiId) {
            hashCalls.push({ value, apiId });
            return 'verified-hash';
        },
    });

    assert.equal(result.apiId, 'openai');
    assert.equal(result.presetName, 'Mobile target');
    assert.equal(result.restoreHash, 'verified-hash');
    assert.equal(hashCalls.length, 1);
    assert.equal(hashCalls[0].apiId, 'openai');
    assert.notEqual(hashCalls[0].value, preset);
    assert.equal(Object.isFrozen(result), true);

    preset.temperature = 0.1;
    assert.equal(result.preset.temperature, 0.7);
});

test('rejects a restore baseline without stable identity or a usable hash', () => {
    assert.throws(() => prepareRestoreBaseline({
        apiId: '',
        presetName: 'Preset',
        preset: { temperature: 0.7 },
    }, { hashPreset: () => 'hash' }), /stable API/);

    assert.throws(() => prepareRestoreBaseline({
        apiId: 'openai',
        presetName: 'Preset',
        preset: { temperature: 0.7 },
    }, { hashPreset: () => '' }), /usable hash/);
});
