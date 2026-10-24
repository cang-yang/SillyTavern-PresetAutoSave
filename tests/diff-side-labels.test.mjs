import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDiffPopupHTML } from '../modules/diff-viewer.js';
import { ENV } from '../modules/compatibility.js';

const translations = JSON.parse(readFileSync(new URL('../i18n/en-us.json', import.meta.url), 'utf8'));
globalThis.SillyTavern = { getContext: () => ({ translate: key => translations[key] || key }) };
ENV.hasTranslate = true;

const snapshot = (id, content, timestamp, extra = []) => ({
    id, name: id, apiId: 'openai', presetName: 'demo', timestamp,
    preset: { prompts: [{ identifier: 'main', name: 'Main', content }, ...extra] },
});
const cells = html => [...html.matchAll(/<div class="pas-diff-cline-([ab])[^"]*"[^>]*data-diff-side="([AB])"[^>]*data-diff-status="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g)]
    .map(match => ({ side: match[2], status: match[3], html: match[0], body: match[4] }));

test('prompt line sides have visible state labels and accessible A-to-B direction', () => {
    const html = buildDiffPopupHTML(snapshot('newer A', 'shared\nnew value', 20), snapshot('older B', 'shared\nold value', 10));
    const rendered = cells(html);
    assert.ok(rendered.length >= 4, 'both unchanged and changed sides must have labels');
    for (const cell of rendered) {
        assert.match(cell.html, /role="group" aria-label="[^"]+A[^"]+B[^"]*"/);
        assert.match(cell.html, new RegExp(`aria-label="${cell.side}, line \\d+, (?:Removed|Added|Unchanged) in comparison A to B"`));
        assert.match(cell.body, /class="pas-diff-line-label">[AB] [+=-] /);
    }
    assert.ok(rendered.some(cell => cell.side === 'A' && cell.status === 'removed' && cell.body.includes('new')));
    assert.ok(rendered.some(cell => cell.side === 'B' && cell.status === 'added' && cell.body.includes('old')));
    assert.ok(rendered.some(cell => cell.side === 'A' && cell.status === 'unchanged'));
});

test('reversing explicit selections reverses side and change meaning regardless of timestamps', () => {
    const a = snapshot('newer', 'unique-A', 20);
    const b = snapshot('older', 'unique-B', 10);
    for (const [left, right] of [[a, b], [b, a]]) {
        const rendered = cells(buildDiffPopupHTML(left, right));
        assert.ok(rendered.some(cell => cell.side === 'A' && cell.status === 'removed' && cell.body.includes(left.preset.prompts[0].content)));
        assert.ok(rendered.some(cell => cell.side === 'B' && cell.status === 'added' && cell.body.includes(right.preset.prompts[0].content)));
    }
});

test('whole-prompt additions and removals identify their side including blank content', () => {
    const prompt = (identifier, content) => ({ identifier, name: identifier, content });
    const html = buildDiffPopupHTML(
        snapshot('a', 'shared', 1, [prompt('gone', 'removed-only'), prompt('blank-gone', '')]),
        snapshot('b', 'shared', 2, [prompt('new', 'added-only'), prompt('blank-new', '')]),
    );
    const rendered = cells(html);
    assert.ok(rendered.some(cell => cell.side === 'A' && cell.status === 'removed' && cell.body.includes('removed-only')));
    assert.ok(rendered.some(cell => cell.side === 'B' && cell.status === 'added' && cell.body.includes('added-only')));
    assert.equal(rendered.filter(cell => cell.body.includes('(no content)')).length, 2);
    assert.match(html, /class="pas-diff-cline-[ab]" aria-hidden="true"><\/div>/);
});

test('line markers never make hostile prompt text or translations executable', () => {
    const previous = translations['Diff Line Removed'];
    translations['Diff Line Removed'] = '<img src=x onerror=alert(2)> "$&';
    try {
        const html = buildDiffPopupHTML(snapshot('a', '<img src=x onerror=alert(1)>', 1), snapshot('b', '<script>evil()</script>', 2));
        assert.doesNotMatch(html, /<(?:img|script)\b/);
        assert.match(html, /&lt;(?:img|script)/);
        assert.match(html, /\$&amp;/);
        assert.equal(cells(html).length, 2);
    } finally {
        translations['Diff Line Removed'] = previous;
    }
});

test('line identity and status are meaningful in both bundled languages', () => {
    for (const locale of ['en-us', 'zh-cn']) {
        const dictionary = JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8'));
        globalThis.SillyTavern = { getContext: () => ({ translate: key => dictionary[key] || key }) };
        const rendered = cells(buildDiffPopupHTML(snapshot('a', 'AAA', 2), snapshot('b', 'BBB', 1)));
        assert.ok(rendered.some(cell => cell.body.includes(dictionary['Diff Line Removed'])));
        assert.ok(rendered.some(cell => cell.body.includes(dictionary['Diff Line Added'])));
        assert.ok(rendered.every(cell => !cell.html.includes('{{')));
        for (const cell of rendered) {
            const expectedStatus = dictionary[cell.status === 'removed' ? 'Diff Line Removed' : 'Diff Line Added'];
            const expectedName = dictionary['Diff Line Accessible']
                .replace('{{side}}', cell.side).replace('{{line}}', '1').replace('{{status}}', expectedStatus);
            assert.ok(cell.html.includes(`aria-label="${expectedName}"`));
        }
    }
    globalThis.SillyTavern = { getContext: () => ({ translate: key => translations[key] || key }) };
});
