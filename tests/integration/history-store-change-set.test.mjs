import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    SillyTavern: {
        libs: {},
        getContext: () => ({}),
    },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;

const { computeChangeSummary, hashPreset } = await import('../../modules/history-store.js');

test('history hashing preserves unknown nested value types', () => {
    assert.notEqual(
        hashPreset({ extensions: { sample: { threshold: '0.5', enabled: 'true' } } }),
        hashPreset({ extensions: { sample: { threshold: 0.5, enabled: true } } }),
    );
});

test('history summary explains a newly changed official preset field', () => {
    const summary = computeChangeSummary(
        { temperature: 1, tool_call_recurse_limit: 3 },
        { temperature: 1, tool_call_recurse_limit: 5 },
    );

    assert.deepEqual(summary.rawChangedPaths, ['tool_call_recurse_limit']);
    assert.ok(summary.sections.some(section =>
        section.kind === 'field' && section.items.some(item => item.key === 'tool_call_recurse_limit')
    ));
});

test('history summary explains extension data changes', () => {
    const summary = computeChangeSummary(
        { extensions: { foo: { enabled: false } } },
        { extensions: { foo: { enabled: true } } },
    );

    assert.deepEqual(summary.rawChangedPaths, ['extensions.foo.enabled']);
    assert.ok(summary.sections.some(section =>
        section.kind === 'field' && section.items.some(item => item.key === 'extensions.foo.enabled')
    ));
});
