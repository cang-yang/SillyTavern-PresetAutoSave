import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisclosureExpanded } from '../modules/panel-disclosure.js';

function classList(initial) {
    const values = new Set(initial);
    return {
        toggle(name, force) { force ? values.add(name) : values.delete(name); },
        contains(name) { return values.has(name); },
    };
}

test('one disclosure operation synchronizes body, semantics, chevron and folder', () => {
    const attributes = new Map([['aria-expanded', 'false']]);
    const header = { setAttribute(name, value) { attributes.set(name, value); } };
    const chevron = { classList: classList(['fa-chevron-right']) };
    const icon = { classList: classList(['fa-folder']) };
    const matches = new Map([
        [':scope > .pas-series-header', header],
        ['.pas-series-chevron', chevron],
        ['.pas-series-icon', icon],
    ]);
    const group = { querySelector(selector) { return matches.get(selector) ?? null; } };
    const body = { hidden: true };

    setDisclosureExpanded(group, body, true, {
        headerSelector: '.pas-series-header',
        chevronSelector: '.pas-series-chevron',
        iconSelector: '.pas-series-icon',
    });

    assert.equal(body.hidden, false);
    assert.equal(attributes.get('aria-expanded'), 'true');
    assert.equal(chevron.classList.contains('fa-chevron-down'), true);
    assert.equal(chevron.classList.contains('fa-chevron-right'), false);
    assert.equal(icon.classList.contains('fa-folder-open'), true);
    assert.equal(icon.classList.contains('fa-folder'), false);
});

test('missing optional visuals do not prevent semantic collapse', () => {
    const attributes = new Map([['aria-expanded', 'true']]);
    const header = { setAttribute(name, value) { attributes.set(name, value); } };
    const group = { querySelector(selector) { return selector === ':scope > .pas-version-header' ? header : null; } };
    const body = { hidden: false };

    setDisclosureExpanded(group, body, false, { headerSelector: '.pas-version-header' });

    assert.equal(body.hidden, true);
    assert.equal(attributes.get('aria-expanded'), 'false');
});
