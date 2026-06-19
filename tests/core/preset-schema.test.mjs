import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizePreset } from '../../modules/core/preset-schema.js';

test('preserves user preset fields and explains ignored connection fields', () => {
    const result = canonicalizePreset({
        temperature: '1.0',
        tool_call_recurse_limit: '5',
        reverse_proxy: 'https://secret.example',
    }, { apiId: 'openai' });

    assert.deepEqual(result.canonical, {
        temperature: 1,
        tool_call_recurse_limit: 5,
    });
    assert.deepEqual(result.ignored, [
        { path: 'reverse_proxy', reason: 'connection-setting' },
    ]);
});

test('normalizes nested values without changing semantic array order', () => {
    const input = {
        stream_openai: 'true',
        a: '02',
        nested: { z: '3.5', a: '' },
        prompts: [{ identifier: 'second' }, { identifier: 'first' }],
    };

    const result = canonicalizePreset(input);

    assert.deepEqual(result.canonical, {
        a: '02',
        stream_openai: true,
        nested: { a: '', z: '3.5' },
        prompts: [{ identifier: 'second' }, { identifier: 'first' }],
    });
    assert.equal(input.stream_openai, 'true');
    assert.equal(input.nested.z, '3.5');
});

test('never coerces prompt or extension text that resembles a scalar', () => {
    const result = canonicalizePreset({
        prompts: [{ identifier: 'main', content: 'true', name: '0.5' }],
        extensions: { sample: { template: 'false', label: '1' } },
        temperature: '0.5',
    });

    assert.equal(result.canonical.prompts[0].content, 'true');
    assert.equal(result.canonical.prompts[0].name, '0.5');
    assert.equal(result.canonical.extensions.sample.template, 'false');
    assert.equal(result.canonical.extensions.sample.label, '1');
    assert.equal(result.canonical.temperature, 0.5);
});

test('rejects invalid preset roots', () => {
    assert.throws(() => canonicalizePreset(null), /plain object/);
    assert.throws(() => canonicalizePreset([]), /plain object/);
});

test('classifies provider and custom connection settings as ignored', () => {
    const result = canonicalizePreset({
        openai_model: 'gpt-example',
        custom_include_headers: 'Authorization: secret',
        temperature: 0.8,
    });

    assert.deepEqual(result.canonical, { temperature: 0.8 });
    assert.deepEqual(result.ignored, [
        { path: 'custom_include_headers', reason: 'connection-setting' },
        { path: 'openai_model', reason: 'connection-setting' },
    ]);
});
