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
        stream_openai: true,
        prompts: [{ identifier: 'second' }, { identifier: 'first' }],
    });
    assert.deepEqual(result.ignored, [
        { path: 'a', reason: 'runtime-or-unknown-setting' },
        { path: 'nested', reason: 'runtime-or-unknown-setting' },
    ]);
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

test('classifies official model-list presentation controls as connection settings', () => {
    const result = canonicalizePreset({
        temperature: 1,
        group_models: true,
        sort_models: 'alphabetically',
    });

    assert.deepEqual(result.canonical, { temperature: 1 });
    assert.deepEqual(result.ignored.map(item => item.path), ['group_models', 'sort_models']);
});

test('rejects unknown OpenAI runtime trees while preserving extension-owned data', () => {
    const result = canonicalizePreset({
        temperature: 0.7,
        additional_parameters_by_source: {
            custom: { exclude_body: { transient: true, source: 'runtime' } },
        },
        extensions: { user_plugin: { enabled: true } },
    }, { apiId: 'openai' });

    assert.deepEqual(result.canonical, {
        extensions: { user_plugin: { enabled: true } },
        temperature: 0.7,
    });
    assert.deepEqual(result.ignored, [{
        path: 'additional_parameters_by_source',
        reason: 'runtime-or-unknown-setting',
    }]);
});

test('keeps unknown fields for non-OpenAI preset families without a native field contract', () => {
    const result = canonicalizePreset({ sampler_order: [6, 0, 1], temperature: 0.7 }, {
        apiId: 'textgenerationwebui',
    });
    assert.deepEqual(result.canonical, { sampler_order: [6, 0, 1], temperature: 0.7 });
    assert.deepEqual(result.ignored, []);
});

test('removes connection secrets from every preset family', () => {
    const result = canonicalizePreset({
        sampler_order: [6, 0, 1],
        api_key_openai: 'sk-must-not-be-snapshotted',
        proxy_password: 'proxy-secret',
    }, { apiId: 'textgenerationwebui' });

    assert.deepEqual(result.canonical, { sampler_order: [6, 0, 1] });
    assert.deepEqual(result.ignored, [
        { path: 'api_key_openai', reason: 'connection-setting' },
        { path: 'proxy_password', reason: 'connection-setting' },
    ]);
});
