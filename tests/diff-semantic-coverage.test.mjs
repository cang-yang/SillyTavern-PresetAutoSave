import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiffPopupHTML } from '../modules/diff-viewer.js';

const base = {
    temperature: 0.7,
    prompts: [{ identifier: 'main', name: 'Main', content: 'hello', injection_trigger: ['normal'] }],
    prompt_order: [
        { character_id: 1, order: [{ identifier: 'main', enabled: true }] },
        { character_id: 2, order: [{ identifier: 'main', enabled: false }] },
    ],
    extensions: { sample: { template: 'before' } },
};
const snapshot = preset => ({ id: 'id', apiId: 'openai', presetName: 'demo', preset, timestamp: 1 });

for (const [label, mutate] of [
    ['new prompt field', value => { value.prompts[0].injection_trigger = ['continue']; }],
    ['non-first order group', value => { value.prompt_order[1].order[0].enabled = true; }],
    ['extension text', value => { value.extensions.sample.template = 'after'; }],
]) {
    test(`detailed comparison explains ${label}`, () => {
        const changed = structuredClone(base);
        mutate(changed);
        const html = buildDiffPopupHTML(snapshot(base), snapshot(changed));
        assert.doesNotMatch(html, /pas-diff-no-changes/);
        assert.match(html, /pas-diff-section/);
    });
}

test('detailed comparison ignores connection-only changes consistently with history', () => {
    const a = { ...base, openai_model: 'model-before' };
    const b = { ...base, openai_model: 'model-after' };
    assert.match(buildDiffPopupHTML(snapshot(a), snapshot(b)), /pas-diff-no-changes/);
});

test('diff section toggles are native controls with expanded state', () => {
    const html = buildDiffPopupHTML(snapshot(base), snapshot({ ...base, temperature: 0.9 }));
    assert.match(html, /<button[^>]+pas-diff-section-toggle[^>]+aria-expanded="true"/);
});

test('unnamed prompt identifier is available in details instead of becoming its visible name', () => {
    const identifier = '7a10a144-53ce-4492-aa7b-1b216c87b411';
    const before = { prompts: [{ identifier, content: 'before' }] };
    const after = { prompts: [{ identifier, content: 'after' }] };
    const html = buildDiffPopupHTML(snapshot(before), snapshot(after));
    const name = html.match(/class="pas-diff-prompt-name">([^<]*)</)?.[1];
    assert.equal(name, 'Unnamed Prompt');
    assert.match(html, /<details[^>]*>[\s\S]*7a10a144-53ce-4492-aa7b-1b216c87b411/);
});
