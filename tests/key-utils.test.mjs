import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttr, escapeHtml, escapeTranslationHtml } from '../modules/key-utils.js';

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

test('escapeTranslationHtml preserves only plain bold emphasis from host translations', () => {
    assert.equal(
        escapeTranslationHtml('Total <b>3</b><img src=x onerror="globalThis.pwned=true">'),
        'Total <strong>3</strong>&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;',
    );
    assert.equal(
        escapeTranslationHtml('<b onclick="globalThis.pwned=true">unsafe emphasis</b>'),
        '&lt;b onclick=&quot;globalThis.pwned=true&quot;&gt;unsafe emphasis&lt;/b&gt;',
    );
});
