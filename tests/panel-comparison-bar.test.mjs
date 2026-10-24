import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateDiffBar } from '../modules/panel-actions.js';

function fixture(diffSel) {
    const start = { setAttribute() {}, removeAttribute() {} };
    const clear = { setAttribute() {}, removeAttribute() {} };
    const search = { focus() { ownerDocument.activeElement = search; } };
    const ownerDocument = { activeElement: clear };
    const bar = { hidden: false, ownerDocument, contains: element => element === clear };
    const slot = () => {
        const text = { textContent: '', title: '' };
        return { text, classList: { add() {}, remove() {} }, querySelector: () => text };
    };
    const a = slot();
    const b = slot();
    const nodes = {
        '#pas-diff-slot-a': a, '#pas-diff-slot-b': b, '#pas-diff-bar': bar,
        '.pas-btn-start-diff': start, '.pas-btn-clear-diff': clear, '.pas-search': search,
    };
    return {
        a, b, bar, search, ownerDocument,
        context: {
            root: () => ({ querySelector: selector => nodes[selector] }),
            state: () => ({
                diffSel,
                snapshots: [
                    { id: 'a', name: '<unsafe & long label> A', timestamp: 0 },
                    { id: 'b', name: 'B full selection label', timestamp: 0 },
                ],
            }),
        },
    };
}

test('comparison selection exposes full literal labels through text and native titles', () => {
    const view = fixture({ a: 'a', b: 'b' });
    updateDiffBar(view.context);
    assert.equal(view.a.text.title, '<unsafe & long label> A');
    assert.equal(view.a.text.textContent, view.a.text.title);
    assert.equal(view.b.text.title, 'B full selection label');
    assert.equal(view.bar.hidden, false);
});

test('clearing a focused comparison shelf returns focus to search when hiding controls', () => {
    const view = fixture({ a: null, b: null });
    updateDiffBar(view.context);
    assert.equal(view.bar.hidden, true);
    assert.equal(view.ownerDocument.activeElement, view.search);
    view.ownerDocument.activeElement = {};
    const previous = view.ownerDocument.activeElement;
    updateDiffBar(view.context);
    assert.equal(view.ownerDocument.activeElement, previous);
});
