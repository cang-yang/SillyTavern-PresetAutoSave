import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    SillyTavern: {
        libs: {},
        getContext: () => ({}),
    },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;

const { sanitizePresetForExport } = await import('../../modules/compatibility.js');

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
