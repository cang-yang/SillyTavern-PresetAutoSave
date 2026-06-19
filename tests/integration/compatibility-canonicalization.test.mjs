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
