import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    SillyTavern: {
        libs: {},
        getContext: () => ({}),
    },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;

const { computeChangeSummary, hashPreset, stableStringify } = await import('../../modules/history-store.js');

test('stable history serialization observes in-place object mutations', () => {
    const value = { extensions: { sample: { enabled: false } } };
    const before = stableStringify(value);
    value.extensions.sample.enabled = true;
    const after = stableStringify(value);

    assert.notEqual(before, after);
});

test('history hashing preserves extension-owned nested value types', () => {
    assert.notEqual(
        hashPreset({ extensions: { sample: { threshold: '0.5', enabled: 'true' } } }),
        hashPreset({ extensions: { sample: { threshold: 0.5, enabled: true } } }),
    );
});

test('OpenAI history hash is stable across arbitrary runtime-state churn', () => {
    const baseline = {
        temperature: 0.8,
        top_p: 0.95,
        prompts: [{ identifier: 'main', content: 'hello' }],
    };
    const expected = hashPreset(baseline, 'openai');

    for (let index = 0; index < 100; index++) {
        const withRuntimeState = {
            ...baseline,
            additional_parameters_by_source: {
                custom: {
                    exclude_body: {
                        revision: index,
                        enabled: index % 2 === 0,
                    },
                },
            },
            transient_ui_cache: { selected: `row-${index}` },
        };
        assert.equal(hashPreset(withRuntimeState, 'openai'), expected);
    }

    assert.notEqual(hashPreset({ ...baseline, temperature: 0.9 }, 'openai'), expected);
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

test('history summary quarantines runtime-only OpenAI mutations', () => {
    const summary = computeChangeSummary(
        {
            temperature: 0.8,
            additional_parameters_by_source: { custom: { exclude_body: { a: 1, b: 2 } } },
        },
        {
            temperature: 0.8,
            additional_parameters_by_source: { custom: { exclude_body: { a: 2, b: 2 } } },
        },
        'openai',
    );

    assert.deepEqual(summary.rawChangedPaths, []);
    assert.deepEqual(summary.ignoredPaths, ['additional_parameters_by_source.custom.exclude_body.a']);
    assert.equal(summary.unchanged, true);
    assert.equal(summary.counts.fieldChanged, 0);
    assert.deepEqual(summary.sections, []);
});
