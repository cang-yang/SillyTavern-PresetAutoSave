import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditIntentOwner, editScopeChanged } from '../../modules/core/edit-intent.js';

const target = { apiId: 'openai', presetName: 'A' };
const before = { temperature: 0.5, extensions: { background: false } };
test('only changed owned scopes create immutable target-bound edit requests', () => {
    const owner = createEditIntentOwner();
    const scope = { kind: 'field', key: 'temperature' };
    assert.equal(owner.record({ target, before, after: { ...before, extensions: { background: true } }, scope }), null);
    const after = { ...before, temperature: 0.8 };
    const edit = owner.record({ target, before, after, scope, source: 'input' });
    after.temperature = 0.9;
    assert.equal(edit.preset.temperature, 0.8);
    assert.equal(owner.peek({ ...target, apiId: 'kobold' }), null);
    assert.throws(() => { edit.preset.temperature = 1; }, TypeError);
});

test('acknowledging an old edit cannot discard a newer one or authorize ambient retries', () => {
    const owner = createEditIntentOwner();
    const event = { target, before, scope: { kind: 'field', key: 'temperature' } };
    const first = owner.record({ ...event, after: { temperature: 0.6 } });
    owner.submitted(first);
    assert.equal(owner.peek(target), null);
    const next = owner.record({ ...event, after: { temperature: 0.7 } });
    owner.acknowledge(first);
    assert.equal(owner.peek(target).editRevision, next.editRevision);
    owner.acknowledge(next);
    assert.equal(owner.peek(target), null);
    owner.clear();
    assert.equal(owner.has(target), false);
});

test('scopes keep prompt identity, content fields and order membership separate', () => {
    const a = { prompts: [{ identifier: 'a', content: 'a', name: 'old' }, { identifier: 'b', content: 'b' }],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] }] };
    const b = structuredClone(a);
    b.prompts[0].name = 'new';
    b.prompts[1].content = 'changed';
    b.prompt_order[0].order[1].enabled = false;
    assert.equal(editScopeChanged(a, b, { kind: 'prompt', identifier: 'a', fields: ['content'] }), false);
    assert.equal(editScopeChanged(a, b, { kind: 'prompt', identifier: 'b' }), true);
    assert.equal(editScopeChanged(a, b, { kind: 'order', identifier: 'a' }), false);
    assert.equal(editScopeChanged(a, b, { kind: 'order', identifier: 'b' }), true);
    assert.equal(editScopeChanged(a, b, { kind: 'unknown' }), false);
});
