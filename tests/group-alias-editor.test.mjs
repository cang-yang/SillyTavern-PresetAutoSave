import test from 'node:test';
import assert from 'node:assert/strict';

import { createGroupAliasEditor } from '../modules/core/group-alias-editor.js';

function setup(validate = value => ({ ok: true, value: value.trim() })) {
    const events = [];
    const editor = createGroupAliasEditor({
        validate,
        save: value => events.push(['save', value]),
        cancel: () => events.push(['cancel']),
        invalid: reason => events.push(['invalid', reason]),
    });
    return { editor, events };
}

test('Enter saves a valid trimmed alias', async () => {
    const { editor, events } = setup();
    await editor.handleKeyDown({ key: 'Enter', isComposing: false }, '  Creative  ');
    assert.deepEqual(events, [['save', 'Creative']]);
});

test('explicit confirm saves through the same validation path', async () => {
    const { editor, events } = setup();
    assert.equal(await editor.commit('  Mobile name  '), true);
    assert.deepEqual(events, [['save', 'Mobile name']]);
});

test('Escape cancels without saving', async () => {
    const { editor, events } = setup();
    await editor.handleKeyDown({ key: 'Escape', isComposing: false }, 'Changed');
    assert.deepEqual(events, [['cancel']]);
});

test('composition Enter does not interrupt an IME candidate', async () => {
    const { editor, events } = setup();
    const handled = await editor.handleKeyDown({ key: 'Enter', isComposing: true }, '创作');
    assert.equal(handled, false);
    assert.deepEqual(events, []);
});

test('blur saves valid input but keeps invalid input active', async () => {
    const valid = setup();
    assert.equal(await valid.editor.handleBlur('  Tools  '), true);
    assert.deepEqual(valid.events, [['save', 'Tools']]);

    const invalid = setup(() => ({ ok: false, reason: 'duplicate' }));
    assert.equal(await invalid.editor.handleBlur('Tools'), false);
    assert.deepEqual(invalid.events, [['invalid', 'duplicate']]);
});
