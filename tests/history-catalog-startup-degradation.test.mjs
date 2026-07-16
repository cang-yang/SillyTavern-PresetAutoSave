import test from 'node:test';
import assert from 'node:assert/strict';

const stores = new Map();
const localforage = {
    createInstance({ storeName }) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        const store = stores.get(storeName);
        return {
            async getItem(key) {
                if (storeName === 'history_catalog') throw new Error('derived catalog unavailable');
                return structuredClone(store.get(key) ?? null);
            },
            async setItem(key, value) {
                if (storeName === 'history_catalog') throw new Error('derived catalog unavailable');
                store.set(key, structuredClone(value));
                return value;
            },
            async removeItem(key) { store.delete(key); },
            async keys() { return [...store.keys()]; },
            async clear() { store.clear(); },
        };
    },
};

const authoritative = {
    id: 'safe',
    apiId: 'openai',
    presetName: 'Safe',
    timestamp: 1,
    trigger: 'manual',
    hash: 'safe-hash',
    size: 10,
    preset: { temperature: 0.7, prompts: [] },
};
stores.set('history', new Map([['openai::Safe', [authoritative]]]));

globalThis.SillyTavern = {
    libs: { localforage },
    getContext() {
        return {
            extensionSettings: {},
            saveSettingsDebounced() {},
            eventSource: { on() {}, off() {}, emit() {} },
            event_types: {},
            getPresetManager() {
                return {
                    savePreset() {},
                    getPresetSettings() {},
                    selectPreset() {},
                    findPreset() {},
                    getSelectedPresetName() { return 'Safe'; },
                };
            },
        };
    },
};
globalThis.window = globalThis;
globalThis.document = { querySelector() { return null; }, getElementById() { return null; } };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const compatibility = await import('../modules/compatibility.js');
compatibility.initCompatibility();
const history = await import('../modules/history-store.js');

test('derived catalog storage failure never disables authoritative history or summary browsing', async () => {
    await history.initHistoryStore();

    assert.equal((await history.getSnapshots('openai', 'Safe'))[0].preset.temperature, 0.7);
    assert.deepEqual((await history.getSnapshotSummaries()).map(item => item.id), ['safe']);
});
