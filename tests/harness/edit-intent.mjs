const initial = { temperature: 0.5, openai_max_tokens: 1024, top_p: 0.9,
    frequency_penalty: 0, presence_penalty: 0,
    prompts: [{ identifier: 'main', content: 'original' }, { identifier: 'other', content: 'second' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'other', enabled: true }] }],
    extensions: { fixture: { active: false, unset: undefined } },
};
const live = structuredClone(initial);
const presets = [structuredClone(initial), { ...structuredClone(initial), temperature: 0.8 }];
const select = document.querySelector('select[data-preset-manager-for]');
const events = new Map();
const stores = new Map();
const writes = [];
const errors = [];
let release = null;
let held = false;
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const eventSource = {
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    off(name, fn) { events.get(name)?.delete(fn); },
    emit(name, data) { for (const fn of events.get(name) || []) fn(data); },
};
const pm = {
    select: [select], getPresetList: () => ({ settings: live, presets, preset_names: ['A', 'B'] }),
    getPresetSettings: () => ({}),
    async savePreset(name, preset) {
        const request = structuredClone(preset);
        if (held) await new Promise(resolve => { release = resolve; });
        writes.push({ name, preset: request });
        presets[['A', 'B'].indexOf(name)] = structuredClone(request);
    },
};
const context = { mainApi: 'openai', extensionSettings: {}, eventSource, event_types: {},
    saveSettingsDebounced() {}, getPresetManager: () => pm };
window.SillyTavern = { getContext: () => context, libs: { localforage: { createInstance({ storeName }) {
    if (!stores.has(storeName)) stores.set(storeName, new Map());
    const values = stores.get(storeName);
    return {
        async getItem(key) { return structuredClone(values.get(key) ?? null); },
        async setItem(key, value) { values.set(key, structuredClone(value)); return value; },
        async removeItem(key) { values.delete(key); },
        async keys() { return [...values.keys()]; }, async clear() { values.clear(); },
    };
} } } };
window.toastr = { info() {}, warning() {}, error() {}, success() {} };
const { initCompatibility } = await import('../../modules/compatibility.js');
initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ debounceMs: 100, textInputDebounce: 150, mergeWindowSec: 0, fallbackPolling: false });
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');
await history.initHistoryStore();
await auto.initAutoSave();
const changed = () => eventSource.emit('settings_updated');
const element = id => document.getElementById(id);
element('temp_openai').addEventListener('input', event => { live.temperature = Number(event.target.value); changed(); });
element('openai_max_tokens').addEventListener('input', event => { live.openai_max_tokens = Number(event.target.value); changed(); });
element('main_prompt_quick_edit_textarea').addEventListener('blur', event => {
    live.prompts.find(item => item.identifier === 'main').content = event.target.value; changed();
});
document.querySelector('.prompt-manager-toggle-action').addEventListener('click', () => {
    const item = live.prompt_order[0].order.find(item => item.identifier === 'main');
    item.enabled = !item.enabled; changed();
});
element('completion_prompt_manager_popup_entry_form_save').addEventListener('click', () => {
    live.prompts.find(item => item.identifier === 'main').content = element('edit_content').value; changed();
});
document.querySelector('.fa-chain').addEventListener('click', () => {
    live.prompt_order[0].order.unshift({ identifier: element('completion_prompt_manager_footer_append_prompt').value, enabled: false });
    changed();
});
document.querySelector('.caution').addEventListener('click', () => {
    const id = element('completion_prompt_manager_footer_append_prompt').value;
    const dialog = document.createElement('dialog');
    const text = document.createElement('p');
    text.textContent = `Delete ${id}?`;
    const ok = document.createElement('button');
    ok.className = 'popup-button-ok';
    ok.textContent = 'Confirm delete';
    const cancel = document.createElement('button');
    cancel.className = 'popup-button-cancel';
    cancel.textContent = 'Cancel';
    dialog.append(text, ok, cancel);
    document.body.append(dialog);
    dialog.showModal();
    ok.addEventListener('click', () => {
        dialog.close(); dialog.remove();
        queueMicrotask(() => { live.prompts = live.prompts.filter(item => item.identifier !== id); changed(); });
    });
    cancel.addEventListener('click', () => { dialog.close(); dialog.remove(); });
});
let dragged = null;
document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', event => { dragged = { y: event.clientY, handle }; });
});
document.addEventListener('pointerup', event => {
    if (!dragged) return;
    if (Math.abs(event.clientY - dragged.y) > 20) {
        live.prompt_order[0].order.reverse();
        // The native host sortable owns this event; the adapter also requires
        // a trusted, moved pointer gesture and a changed order before accepting.
        element('completion_prompt_manager').dispatchEvent(new Event('sortupdate', { bubbles: true }));
        changed();
    }
    dragged = null;
});
element('snapshot').addEventListener('click', () => auto.saveNowDetailed());
select.addEventListener('change', () => {
    Object.keys(live).forEach(key => delete live[key]);
    Object.assign(live, structuredClone(presets[select.selectedIndex]));
    eventSource.emit('preset_changed', { apiId: 'openai', name: select.options[select.selectedIndex].textContent });
});
window.__EDIT_INTENT__ = {
    ready: true,
    writeCount: () => writes.length,
    async state() { return { writes: structuredClone(writes), snapshotCount: (await history.getAllSnapshots()).length,
        live: structuredClone(live), tracking: auto.getCurrentTracking(), errors: [...errors] }; },
    ambient() {
        live.extensions.fixture.active = !live.extensions.fixture.active;
        changed();
        const noise = document.createElement('span');
        noise.textContent = 'render';
        element('completion_prompt_manager').append(noise); noise.remove();
    },
    hold() { held = true; },
    release() { held = false; release?.(); release = null; },
    async teardown() { await auto.teardown(); await history.teardownHistoryStore(); },
};
element('result').textContent = 'Ready';
