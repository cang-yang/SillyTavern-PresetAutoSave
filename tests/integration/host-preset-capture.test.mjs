import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';

const host = installRuntimeHost();
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const { canonicalizePreset } = await import('../../modules/core/preset-schema.js');
const { validateImportedSnapshot } = await import('../../modules/core/history-import-validation.js');

function withLive(preset, run) {
    const original = host.pm.getPresetList;
    host.pm.getPresetList = () => ({ settings: preset, presets: [preset], preset_names: ['race'] });
    try { return run(); } finally { host.pm.getPresetList = original; }
}

test('host root getters materialize once with their receiver and detach live prompt data', () => {
    for (const capture of [() => compatibility.getLivePresetSnapshot('openai'),
        () => compatibility.getPresetSnapshot('race'),
        () => compatibility.getStoredPresetSnapshot('race', { apiId: 'openai' })]) {
        const prompts = [{ identifier: 'main', content: 'live content' }];
        const order = [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }];
        const reads = new Map();
        const preset = {};
        for (const [key, value] of Object.entries({ prompts, prompt_order: order, temperature: 0.7 })) {
            Object.defineProperty(preset, key, { enumerable: true, get() {
                assert.equal(this, preset);
                reads.set(key, (reads.get(key) || 0) + 1);
                return value;
            } });
        }
        withLive(preset, () => {
            const result = capture();
            assert.deepEqual(result, { prompts, prompt_order: order, temperature: 0.7 });
            assert.deepEqual([...reads.values()], [1, 1, 1]);
            result.prompts[0].content = 'snapshot edit';
            result.prompt_order[0].order[0].enabled = false;
            assert.equal(prompts[0].content, 'live content');
            assert.equal(order[0].order[0].enabled, true);
        });
    }
});

test('excluded root getters and shadowed aliases are never invoked', () => {
    const preset = { temperature: 0.6 };
    let reads = 0;
    for (const key of ['api_key_openai', 'custom_include_headers', 'unknownRuntime', 'temp_openai']) {
        Object.defineProperty(preset, key, { enumerable: true, get() { reads++; throw new Error('DO_NOT_LOG'); } });
    }
    withLive(preset, () => assert.deepEqual(compatibility.getLivePresetSnapshot('openai'), { temperature: 0.6 }));
    assert.equal(reads, 0);
});

test('root getter materialization does not relax persisted document or import validation', () => {
    let reads = 0;
    const preset = {};
    Object.defineProperty(preset, 'prompts', { enumerable: true, get() { reads++; return []; } });
    assert.throws(() => canonicalizePreset(preset), /accessor/);
    assert.throws(() => compatibility.sanitizePresetForExport(preset), /accessor/);
    assert.throws(() => validateImportedSnapshot({ id: 'getter', timestamp: 1, preset }, 'openai'), TypeError);
    assert.equal(reads, 0);
});

test('root accessor failures are structural and do not leak thrown prompt or secret text', () => {
    const preset = {};
    Object.defineProperty(preset, 'prompts', { enumerable: true, get() { throw new Error('DO_NOT_LOG'); } });
    withLive(preset, () => assert.throws(() => compatibility.getLivePresetSnapshot('openai'), error =>
        error.code === 'PRESET_NON_JSON' && error.path === 'prompts'
        && error.valueType === 'accessor-read-failed' && !String(error.stack).includes('DO_NOT_LOG')
        && error.cause === undefined));
});

test('root getter results retain JSON validation and setter-only fields fail closed', () => {
    for (const value of [NaN, () => {}, 1n, new Date(), { get nested() { throw new Error('DO_NOT_LOG'); } }]) {
        const preset = {};
        Object.defineProperty(preset, 'extensions', { enumerable: true, get() { return value; } });
        withLive(preset, () => assert.throws(() => compatibility.getLivePresetSnapshot('openai'),
            error => error.code === 'PRESET_NON_JSON' && !error.message.includes('DO_NOT_LOG')));
    }
    const preset = {};
    Object.defineProperty(preset, 'prompts', { enumerable: true, set(_) {} });
    withLive(preset, () => assert.throws(() => compatibility.getLivePresetSnapshot('openai'),
        error => error.valueType === 'accessor'));
    const cycle = {};
    Object.defineProperty(cycle, 'extensions', { enumerable: true, get() { return cycle; } });
    withLive(cycle, () => assert.throws(() => compatibility.getLivePresetSnapshot('openai'),
        error => error.code === 'PRESET_CIRCULAR'));
});

test('host capture omits unset object properties and preserves array positions without mutating live data', () => {
    const preset = {
        temperature: 0.7, assistant_prefill: undefined,
        prompts: [{ identifier: 'custom', content: 'user text', injection_depth: undefined }],
        extensions: { custom: { optional: undefined, values: [false, undefined, , 'kept'] } },
    };
    const expected = {
        temperature: 0.7, prompts: [{ identifier: 'custom', content: 'user text' }],
        extensions: { custom: { values: [false, null, null, 'kept'] } },
    };
    withLive(preset, () => {
        assert.deepEqual(compatibility.getPresetSnapshot('race'), expected);
        assert.deepEqual(compatibility.getLivePresetSnapshot('openai'), expected);
        assert.deepEqual(compatibility.getStoredPresetSnapshot('race', { apiId: 'openai' }), expected);
    });
    assert.ok(Object.hasOwn(preset.prompts[0], 'injection_depth'));
    assert.ok(Object.hasOwn(preset, 'assistant_prefill'));
    assert.equal(preset.extensions.custom.values.length, 4);
    assert.equal(Object.hasOwn(preset.extensions.custom.values, 2), false);
});

test('host capture rejects unsupported owned values instead of JSON-fallback coercion', () => {
    const values = [
        [() => 'DO_NOT_LOG', 'function'],
        [Number.NaN, 'non-finite-number'],
        [Infinity, 'non-finite-number'],
        [1n, 'bigint'],
        [Symbol('DO_NOT_LOG'), 'symbol'],
        [new Date('2026-01-01'), 'non-plain-object'],
        [new Map([['secret', 'DO_NOT_LOG']]), 'non-plain-object'],
    ];
    for (const [value, valueType] of values) {
        const preset = {
            temperature: 0.7,
            unrelatedRuntimeCallback: () => {},
            extensions: { custom: { nested: value } },
        };
        withLive(preset, () => assert.throws(
            () => compatibility.getPresetSnapshot('race'),
            error => error.code === 'PRESET_NON_JSON'
                && error.path === 'extensions.custom.nested'
                && error.valueType === valueType
                && !error.message.includes('DO_NOT_LOG'),
            `must reject ${valueType} with structural diagnostics`,
        ));
    }
});

test('host capture filters excluded connection/runtime data before inspecting owned JSON', () => {
    const cycle = {};
    cycle.self = cycle;
    const preset = {
        temperature: 0.7,
        custom_include_headers: cycle,
        unrelatedRuntimeCallback: () => {},
        extensions: { custom: { api_key: cycle, enabled: false, note: 'user data' } },
    };
    withLive(preset, () => assert.deepEqual(compatibility.getPresetSnapshot('race'), {
        temperature: 0.7,
        extensions: { custom: { enabled: false, note: 'user data' } },
    }));
});

test('host capture identifies owned cycles without exposing values', () => {
    const extension = { text: 'DO_NOT_LOG' };
    extension.self = extension;
    withLive({ extensions: { custom: extension } }, () => assert.throws(
        () => compatibility.getPresetSnapshot('race'),
        error => error.code === 'PRESET_CIRCULAR'
            && error.path === 'extensions.custom.self'
            && !error.message.includes('DO_NOT_LOG'),
    ));
});

test('host capture refuses owned accessors without running them', () => {
    let calls = 0;
    const extension = {};
    Object.defineProperty(extension, 'computed', {
        enumerable: true,
        get() { calls++; return 'DO_NOT_LOG'; },
    });
    withLive({ extensions: { custom: extension } }, () => assert.throws(
        () => compatibility.getPresetSnapshot('race'),
        error => error.code === 'PRESET_NON_JSON' && error.valueType === 'accessor',
    ));
    assert.equal(calls, 0);
});

test('context fallback does not swallow malformed live data and silently use stale settings', () => {
    const originalList = host.pm.getPresetList;
    const originalSettings = host.pm.getPresetSettings;
    host.pm.getPresetList = () => ({});
    host.pm.getPresetSettings = () => ({ temperature: 0.1 });
    host.context.chatCompletionSettings = { temperature: Number.NaN };
    try {
        assert.throws(() => compatibility.getPresetSnapshot('race'), error =>
            error.code === 'PRESET_NON_JSON' && error.path === 'temperature');
    } finally {
        host.pm.getPresetList = originalList;
        host.pm.getPresetSettings = originalSettings;
        delete host.context.chatCompletionSettings;
    }
});

test('non-current fallback does not swallow malformed stored data and try another payload', () => {
    const originalList = host.pm.getPresetList;
    const originalSettings = host.pm.getPresetSettings;
    host.pm.getPresetList = () => ({
        settings: { temperature: 0.1 },
        presets: [{ temperature: Infinity }], preset_names: ['other'],
    });
    host.pm.getPresetSettings = () => ({ temperature: 0.1 });
    try {
        assert.throws(() => compatibility.getPresetSnapshot('other'), error =>
            error.code === 'PRESET_NON_JSON' && error.path === 'temperature');
    } finally {
        host.pm.getPresetList = originalList;
        host.pm.getPresetSettings = originalSettings;
    }
});

test('stored JSON and external import contracts remain strict about unset fields', () => {
    const preset = { prompts: [{ identifier: 'custom', content: 'kept', injection_depth: undefined }] };
    assert.throws(() => canonicalizePreset(preset), TypeError);
    assert.throws(() => compatibility.sanitizePresetForExport(preset), TypeError);
    assert.throws(() => validateImportedSnapshot({ id: 'a', timestamp: 1, preset }, 'openai'), TypeError);
});

test('host capture does not silently discard enumerable non-JSON array properties', () => {
    const values = ['kept'];
    values.extra = 'would otherwise disappear';
    withLive({ extensions: { custom: { values } } }, () => assert.throws(
        () => compatibility.getPresetSnapshot('race'),
        error => error.code === 'PRESET_NON_JSON' && error.valueType === 'array-property',
    ));
});

test('host capture keeps alias precedence and produces the same JSON contract as a native payload', () => {
    const preset = {
        temp_openai: '0.8', temperature: 0.5, streaming: 'false',
        prompts: [{ identifier: 'custom-id', content: 'not a runtime blacklist entry', position: undefined }],
        extensions: { custom: { enabled: false, count: 0, text: '' } },
    };
    withLive(preset, () => {
        const captured = compatibility.getPresetSnapshot('race');
        assert.deepEqual(captured, compatibility.sanitizePresetForExport(JSON.parse(JSON.stringify(preset))));
        assert.equal(captured.temperature, 0.5);
        assert.equal(captured.stream_openai, false);
        captured.extensions.custom.enabled = true;
        assert.equal(preset.extensions.custom.enabled, false);
    });
});

test('a non-OpenAI fallback never captures the context Chat Completion settings', () => {
    const originalList = host.pm.getPresetList;
    const originalSettings = host.pm.getPresetSettings;
    host.context.mainApi = 'textgenerationwebui';
    host.context.chatCompletionSettings = { temperature: 0.9, prompts: [{ content: 'wrong API' }] };
    host.pm.getPresetList = () => ({});
    host.pm.getPresetSettings = () => ({ temperature: 0.2, top_k: 17 });
    try {
        assert.deepEqual(compatibility.getPresetSnapshot('race', { apiId: 'textgenerationwebui' }), {
            temperature: 0.2, top_k: 17,
        });
    } finally {
        host.context.mainApi = 'openai';
        delete host.context.chatCompletionSettings;
        host.pm.getPresetList = originalList;
        host.pm.getPresetSettings = originalSettings;
    }
});
