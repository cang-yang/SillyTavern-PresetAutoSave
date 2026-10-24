import test from 'node:test';
import assert from 'node:assert/strict';
import { initSettings, getSettings, updateSetting } from '../modules/settings.js';
import { bindSettingsEvents, disposeSettingsMount, onImport } from '../modules/panel-settings-log.js';

const context = { extensionSettings: {}, saveSettingsDebounced() {} };
globalThis.SillyTavern = { getContext: () => context };
globalThis.window = { confirm: () => true };
await initSettings();

class Control {
    constructor(value = '') { this.value = value; this.listeners = new Map(); this.style = {}; }
    getAttribute() { return 'debounceMs'; }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    async emit(type) {
        for (const handler of [...(this.listeners.get(type) || [])]) await handler({ target: this });
    }
    click() {}
    remove() { this.removed = true; }
}
function fixture() {
    const number = new Control('900');
    const reset = new Control();
    const container = {
        querySelectorAll: selector => selector.includes('number') ? [number] : [],
        querySelector: selector => selector === '.pas-btn-reset' ? reset : null,
    };
    const root = { querySelector: () => null, contains: element => element === container };
    const panelCtx = { root: () => root };
    return { number, reset, container, panelCtx };
}

test('reset cancels pending numeric edits before replacing the settings surface', async () => {
    const { number, reset, container, panelCtx } = fixture();
    updateSetting('debounceMs', 800);
    bindSettingsEvents(container, panelCtx);
    await number.emit('input');
    await reset.emit('click');
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(getSettings().debounceMs, 800);
});

test('binding replacement and disposal own numeric timers and listeners', async () => {
    const { number, container, panelCtx } = fixture();
    updateSetting('debounceMs', 800);
    const first = bindSettingsEvents(container, panelCtx);
    await number.emit('input');
    const second = bindSettingsEvents(container, panelCtx);
    assert.equal(number.listeners.get('input').size, 1);
    assert.equal(typeof first?.destroy, 'function');
    second.destroy();
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(getSettings().debounceMs, 800);
    assert.equal(number.listeners.get('input').size, 0);
});

test('cancelling a file picker removes its injected input', async () => {
    let input;
    globalThis.document = {
        createElement() { input = new Control(); return input; },
        body: { appendChild() {} },
    };
    await onImport({ root: () => ({}) });
    await input.emit('cancel');
    assert.equal(input.removed, true);
});

test('closing the panel cancels numeric work and a pending file read', async () => {
    const { number, container, panelCtx } = fixture();
    updateSetting('debounceMs', 800);
    bindSettingsEvents(container, panelCtx);
    await number.emit('input');
    let input;
    let completeRead;
    let refreshes = 0;
    globalThis.document = {
        createElement() { input = new Control(); return input; },
        body: { appendChild() {} },
    };
    await onImport({ ...panelCtx, refreshData() { refreshes++; } });
    input.files = [{ text: () => new Promise(resolve => { completeRead = resolve; }) }];
    const reading = input.emit('change');
    disposeSettingsMount(panelCtx.root());
    completeRead('not parsed after disposal');
    await reading;
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(getSettings().debounceMs, 800);
    assert.equal(number.listeners.get('input').size, 0);
    assert.equal(input.removed, true);
    assert.equal(refreshes, 0);
});
