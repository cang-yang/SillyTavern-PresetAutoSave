import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
const languages = Object.fromEntries(await Promise.all(['en-us', 'zh-cn'].map(async code => [
    code, JSON.parse(await readFile(new URL(`../i18n/${code}.json`, import.meta.url), 'utf8')),
])));
let language = 'en-us';
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null, getElementById: () => null };
globalThis.SillyTavern = {
    getContext: () => ({ translate(key, variables = {}) {
        return Object.entries(variables).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
            languages[language][key] || key);
    } }),
};
const { initCompatibility } = await import('../modules/compatibility.js');
initCompatibility();
const { describeFieldChange, fieldLabel, formatSummaryValue, renderSummary } = await import('../modules/panel-summary.js');

test('summary string descriptors display content rather than generic object counts', () => {
    const html = describeFieldChange({
        key: 'extensions.sample.template', kind: 'scalar',
        from: { length: 6, preview: 'before' }, to: { length: 5, preview: 'after' },
    });
    assert.match(html, /before/);
    assert.match(html, /after/);
    assert.doesNotMatch(html, /对象|Object \(2/);
});

test('unknown paths remain in expandable technical details, not the default label', () => {
    const html = renderSummary({ sections: [], rawChangedPaths: ['extensions.sample.template'] });
    assert.match(html, /<details/);
    const withoutDetails = html.replace(/<details[\s\S]*?<\/details>/g, '');
    assert.doesNotMatch(withoutDetails, />extensions\.sample\.template</);
    assert.match(html, /extensions\.sample\.template/);
});

test('labels respond to language changes and official recursion limit has a friendly label', () => {
    language = 'en-us';
    const english = fieldLabel('temperature');
    assert.notEqual(fieldLabel('tool_call_recurse_limit'), 'tool_call_recurse_limit');
    assert.doesNotMatch(formatSummaryValue([1, 2]), /列表|对象/);
    language = 'zh-cn';
    assert.notEqual(fieldLabel('temperature'), english);
});
