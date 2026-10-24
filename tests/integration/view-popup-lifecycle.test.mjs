import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';

test('reopening a snapshot viewer cannot copy a closed viewer payload', async t => {
    const host = installRuntimeHost();
    const popups = [];
    let currentPopup;
    class Popup {
        constructor(html) {
            this.html = html;
            this.instance = html.match(/data-pas-view-instance="(\d+)"/)?.[1];
            this.button = {
                dataset: {}, handlers: new Set(),
                addEventListener(type, handler) { this.handlers.add(handler); },
                removeEventListener(type, handler) { this.handlers.delete(handler); },
            };
            this.root = { querySelector: () => this.button };
            popups.push(this);
        }
        show() { currentPopup = this; return new Promise(resolve => { this.resolve = resolve; }); }
        completeCancelled() { this.resolve?.(false); }
    }
    host.context.Popup = Popup;
    host.context.POPUP_TYPE = { DISPLAY: 'display' };
    document.querySelector = selector => {
        const instance = selector.match(/data-pas-view-instance="(\d+)"/)?.[1];
        if (instance) return popups.find(popup => popup.instance === instance)?.root || null;
        return selector.includes('pas-view-copy-btn') ? currentPopup.button : null;
    };
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        clipboard: { async writeText(text) { copied.push(JSON.parse(text)); } },
    } });
    const { initCompatibility } = await import('../../modules/compatibility.js');
    initCompatibility();
    const { initSettings } = await import('../../modules/settings.js');
    await initSettings();
    const history = await import('../../modules/history-store.js');
    await history.initHistoryStore();
    const a = await history.addSnapshot('race', 'openai', { temperature: 0.3 }, 'manual');
    const b = await history.addSnapshot('race', 'openai', { temperature: 0.9 }, 'manual');
    const actions = await import('../../modules/panel-actions.js');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    const click = id => actions.handleListClick({
        preventDefault() {}, stopPropagation() {},
        target: { closest: selector => selector === '.pas-btn-action' ? {
            getAttribute: attr => attr === 'data-id' ? id : 'view',
        } : null },
    }, { state: () => ({}) });
    try {
        await click(a.id);
        popups[0].completeCancelled();
        await click(b.id);
        t.mock.timers.tick(500);
        for (const handler of popups[1].button.handlers) await handler({});
        assert.deepEqual(copied, [{ temperature: 0.9 }]);
        popups[1].completeCancelled();
        await Promise.resolve();
        assert.equal(popups[1].button.handlers.size, 0);
    } finally {
        actions.cleanupActionPopups();
        await history.teardownHistoryStore();
    }
});
