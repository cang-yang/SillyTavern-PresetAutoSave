import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    SillyTavern: {
        libs: {},
        getContext: () => ({}),
    },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;
globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
};

const {
    ENV,
    initCompatibility,
    getLivePresetSnapshot,
    sanitizePresetForExport,
    savePresetSafe,
} = await import('../../modules/compatibility.js');

test('snapshot sanitization uses the canonical schema without dropping preset controls', () => {
    const result = sanitizePresetForExport({
        tool_reasoning_mode: 'preserve',
        tool_call_recurse_limit: '7',
        send_if_empty: 'true',
        openai_model: 'connection-only',
        extensions: { sample: { threshold: '0.5', enabled: 'true' } },
    });

    assert.deepEqual(result, {
        extensions: { sample: { enabled: 'true', threshold: '0.5' } },
        send_if_empty: 'true',
        tool_call_recurse_limit: 7,
        tool_reasoning_mode: 'preserve',
    });
});

test('live OpenAI runtime state and native save payload converge to one snapshot schema', () => {
    const live = sanitizePresetForExport({
        temperature: '0.8',
        prompts: [{ identifier: 'main', content: 'hello' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        additional_parameters_by_source: {
            custom: { exclude_body: { transient: true, source: 'runtime' } },
        },
        bias_presets: { Default: [] },
        bias_preset_selected: 'Default (none)',
        custom_exclude_body: '- frequency_penalty',
    }, { apiId: 'openai' });
    const native = sanitizePresetForExport({
        temperature: 0.8,
        prompts: [{ identifier: 'main', content: 'hello' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    }, { apiId: 'openai' });

    assert.deepEqual(live, native);
    assert.equal('additional_parameters_by_source' in live, false);
    assert.equal('bias_preset_selected' in live, false);
});

test('savePresetSafe treats the official undefined return value as success', async () => {
    const calls = [];
    const presetManager = {
        async savePreset(...args) {
            calls.push(args);
            return undefined;
        },
    };
    globalThis.window.SillyTavern.getContext = () => ({
        getPresetManager: () => presetManager,
        eventSource: { on() {} },
        event_types: {},
    });
    globalThis.SillyTavern = globalThis.window.SillyTavern;
    initCompatibility();

    const result = await savePresetSafe('Reliable preset', { temperature: 0.7 }, {
        apiId: 'openai',
        skipUpdate: false,
    });

    assert.equal(ENV.hasGetPresetManager, true);
    assert.equal(result, true);
    assert.deepEqual(calls, [[
        'Reliable preset',
        { temperature: 0.7 },
        { skipUpdate: false },
    ]]);
});

test('savePresetSafe propagates an official write failure', async () => {
    const expected = new Error('disk full');
    globalThis.window.SillyTavern.getContext = () => ({
        getPresetManager: () => ({
            async savePreset() {
                throw expected;
            },
        }),
        eventSource: { on() {} },
        event_types: {},
    });

    await assert.rejects(
        savePresetSafe('Broken preset', {}, { apiId: 'openai' }),
        error => error === expected,
    );
});

test('live capture ignores a select that already points at the next preset', () => {
    globalThis.window.SillyTavern.getContext = () => ({
        mainApi: 'textgenerationwebui',
        getPresetManager: () => ({
            async savePreset() {},
            getPresetList: () => ({
                settings: { temperature: 0.83, extensions: { probe: { enabled: false } } },
            }),
        }),
        eventSource: { on() {} },
        event_types: {},
    });
    initCompatibility();

    assert.deepEqual(getLivePresetSnapshot('textgenerationwebui'), {
        extensions: { probe: { enabled: false } },
        temperature: 0.83,
    });
});
