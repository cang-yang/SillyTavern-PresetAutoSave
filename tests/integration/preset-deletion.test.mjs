import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const stores = new Map();
const messages = [];
let deletionMode = 'false';
let selected = 'current';
let currentApi = 'openai';
class Popup {
    async show() { return '1'; }
}
Popup.show = { confirm: async () => true };
const manager = {
    select: [{ options: [{ textContent: 'current', value: '0' }], selectedIndex: 0 }],
    getSelectedPresetName: () => selected,
    getPresetList: () => ({ settings: { temperature: 0.7 }, presets: [{ temperature: 0.7 }], preset_names: [selected] }),
    getPresetSettings: () => ({}),
    async savePreset() {},
    async deletePreset() {
        if (deletionMode === 'throw') throw new Error('Synthetic host deletion failure');
        return deletionMode === 'success';
    },
};
const context = {
    get mainApi() { return currentApi; },
    extensionSettings: {}, saveSettingsDebounced() {},
    eventSource: { on() {}, off() {}, emit() {} }, event_types: {},
    getPresetManager: () => manager,
    Popup, POPUP_TYPE: { DISPLAY: 'display', INPUT: 'input' },
};
globalThis.window = globalThis;
globalThis.SillyTavern = {
    getContext: () => context,
    libs: { localforage: { createInstance({ name, storeName }) {
        const id = `${name}::${storeName}`;
        if (!stores.has(id)) stores.set(id, new Map());
        const map = stores.get(id);
        return {
            async getItem(key) { return structuredClone(map.get(key) ?? null); },
            async setItem(key, value) { map.set(key, structuredClone(value)); return value; },
            async removeItem(key) { map.delete(key); },
            async keys() { return [...map.keys()]; },
            async clear() { map.clear(); },
        };
    } } },
};
globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    body: { addEventListener() {}, removeEventListener() {}, classList: { toggle() {}, remove() {} } },
    documentElement: {}, addEventListener() {}, removeEventListener() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.toastr = Object.fromEntries(['info', 'warning', 'error', 'success']
    .map(level => [level, message => messages.push({ level, message })]));
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');
const archive = await import('../../modules/archive-store.js');
await history.initHistoryStore();
await archive.initArchiveStore();
const actions = await import('../../modules/panel-actions.js');
const auto = await import('../../modules/auto-save.js');
await auto.initAutoSave();
after(async () => { await auto.teardown(); await history.teardownHistoryStore(); });

const payload = {
    temperature: 0.7, top_p: 1, openai_max_tokens: 100,
    openai_max_context: 4096, prompts: [],
};

for (const mode of ['false', 'throw']) {
    for (const kind of ['single', 'batch']) {
        test(`${kind} deletion preserves history and recovery when host returns ${mode}`, async () => {
            deletionMode = mode;
            const name = `preserved-${kind}-${mode}`;
            await history.addSnapshot(name, 'openai', payload, 'manual');
            await archive.archivePreset('openai', name, payload, 'group');
            const before = await history.getSnapshots('openai', name);
            messages.length = 0;
            const result = kind === 'single'
                ? await actions.onDeletePreset(name, 'openai')
                : await actions.onBatchDeletePresets([name], 'openai');
            assert.deepEqual(await history.getSnapshots('openai', name), before);
            assert.ok(await archive.getArchivedPreset('openai', name));
            assert.equal(Boolean(result), false);
            assert.equal(messages.some(item => item.level === 'success'), false);
        });
    }
}

test('successful deletion preserves global organization membership for same-named other API targets', async () => {
    deletionMode = 'success';
    const name = 'shared-name';
    settings.batchUpdate({ groupingManualOverrides: { [name]: 'my-series' } });
    await history.addSnapshot(name, 'openai', payload, 'manual');
    await history.addSnapshot(name, 'textgenerationwebui', { ...payload, temperature: 0.9 }, 'manual');
    assert.equal(await actions.onDeletePreset(name, 'openai'), true);
    assert.equal((await history.getSnapshots('openai', name)).length, 0);
    assert.equal((await history.getSnapshots('textgenerationwebui', name)).length, 1);
    assert.equal(settings.getSettings().groupingManualOverrides[name], 'my-series');
});
