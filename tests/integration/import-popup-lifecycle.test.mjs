import assert from 'node:assert/strict';
import { test } from 'node:test';

test('overlapping import previews bind their own controls and cancel with their owner', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const popups = [];
    class Popup {
        constructor(html) {
            this.instance = html.match(/data-pas-import-instance="(\d+)"/)?.[1];
            this.button = {
                handlers: new Set(), classList: { toggle() {} }, querySelector: () => null,
                addEventListener(type, handler) { this.handlers.add(handler); },
                removeEventListener(type, handler) { this.handlers.delete(handler); },
            };
            this.root = {
                querySelector: selector => selector === '[data-import-confirm]' ? this.button : { value: 'merge' },
                querySelectorAll: () => [],
            };
            popups.push(this);
        }
        show() { return new Promise(resolve => { this.resolve = resolve; }); }
        completeCancelled() { this.closed = true; this.resolve?.(false); }
    }
    globalThis.window = globalThis;
    globalThis.document = {
        querySelectorAll: () => popups.map(popup => popup.root),
        querySelector: selector => {
            const instance = selector.match(/data-pas-import-instance="(\d+)"/)?.[1];
            return popups.find(popup => popup.instance === instance)?.root || null;
        },
        getElementById: () => null,
    };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    globalThis.SillyTavern = { getContext: () => ({ Popup, POPUP_TYPE: { DISPLAY: 'display' } }) };
    const { initCompatibility } = await import('../../modules/compatibility.js');
    initCompatibility();
    const { chooseHistoryImportMode } = await import('../../modules/import-preview.js');
    const abort = new AbortController();
    const preview = { modes: { merge: { available: true }, replace: {} } };
    const first = chooseHistoryImportMode(preview, { signal: abort.signal });
    const second = chooseHistoryImportMode(preview);
    try {
        for (let i = 0; i < 4; i++) { t.mock.timers.tick(100); await Promise.resolve(); }
        assert.equal(popups[0].button.handlers.size, 1);
        assert.equal(popups[1].button.handlers.size, 1);
        assert.notEqual(popups[0].instance, popups[1].instance);
        abort.abort();
        await Promise.resolve();
        assert.equal(popups[0].closed, true);
        assert.equal(popups[0].button.handlers.size, 0);
        assert.equal(popups[1].button.handlers.size, 1);
    } finally {
        popups.forEach(popup => popup.completeCancelled());
        for (let i = 0; i < 4; i++) { t.mock.timers.tick(100); await Promise.resolve(); }
        await Promise.all([first, second]);
    }
});
