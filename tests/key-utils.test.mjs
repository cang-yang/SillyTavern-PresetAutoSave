import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttr, escapeHtml } from '../modules/key-utils.js';

test('escapeHtml neutralizes every character that can break HTML text or attributes', () => {
    assert.equal(
        escapeHtml(`<script data-name="O'Reilly">a & b</script>`),
        '&lt;script data-name=&quot;O&#039;Reilly&quot;&gt;a &amp; b&lt;/script&gt;',
    );
});

test('escape helpers preserve ordinary values and handle nullish input', () => {
    assert.equal(escapeHtml('preset-01_预设'), 'preset-01_预设');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeAttr('a" onfocus="alert(1)'), 'a&quot; onfocus=&quot;alert(1)');
});
