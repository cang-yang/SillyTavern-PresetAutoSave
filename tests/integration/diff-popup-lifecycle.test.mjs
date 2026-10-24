import assert from 'node:assert/strict';
import { test } from 'node:test';

test('closing then reopening diff cannot bind delayed listeners to another popup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const popups = [];
    let currentRoot;
    class Popup {
        constructor(html) {
            this.html = html;
            this.root = {
                listeners: new Map(),
                querySelector: () => null,
                addEventListener(type, handler) {
                    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
                    this.listeners.get(type).add(handler);
                },
                removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); },
            };
            popups.push(this);
        }
        show() {
            currentRoot = this.root;
            return new Promise(resolve => { this.resolve = resolve; });
        }
        completeCancelled() { this.resolve?.(false); }
    }
    globalThis.window = globalThis;
    globalThis.document = {
        querySelector: selector => selector.includes('pas-diff') ? currentRoot : null,
        getElementById: () => null,
    };
    globalThis.SillyTavern = {
        getContext: () => ({ Popup, POPUP_TYPE: { DISPLAY: 'display' } }),
    };
    const { initCompatibility } = await import('../../modules/compatibility.js');
    initCompatibility();
    const viewer = await import('../../modules/diff-viewer.js');
    const a = { id: 'a', apiId: 'openai', preset: { temperature: 0.5 } };
    const b = { ...a, id: 'b', preset: { temperature: 0.7 } };
    await viewer.showDiffPopup(a, b);
    popups[0].completeCancelled();
    await viewer.showDiffPopup(a, b);
    t.mock.timers.tick(500);
    assert.equal(popups[1].root.listeners.get('click')?.size, 1);
    popups[1].completeCancelled();
    await Promise.resolve();
    assert.equal(popups[1].root.listeners.get('click')?.size || 0, 0);
});
