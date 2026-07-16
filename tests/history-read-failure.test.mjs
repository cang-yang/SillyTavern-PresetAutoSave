import test from 'node:test';
import assert from 'node:assert/strict';

const stores = {
    history: new Map(),
    history_v2: new Map([
        ['openai::healthy', [{ id: 'healthy', timestamp: 2, preset: { a: 1, b: 2, c: 3, d: 4, e: 5 } }]],
        ['openai::private broken', [{ id: 'broken' }]],
    ]),
};
let writes = 0;

const localforage = {
    createInstance({ storeName }) {
        const data = stores[storeName] ??= new Map();
        return {
            async getItem(key) {
                if (storeName === 'history_v2' && key === 'openai::private broken') {
                    throw new Error('IndexedDB read rejected');
                }
                return data.get(key) ?? null;
            },
            async setItem(key, value) { writes++; data.set(key, value); return value; },
            async removeItem(key) { writes++; data.delete(key); },
            async keys() { return [...data.keys()]; },
        };
    },
};

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
                    getSelectedPresetName() { return 'healthy'; },
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
const historyStore = await import('../modules/history-store.js');
const { HistoryBucketReadError } = await import('../modules/core/history-bucket-reader.js');
await historyStore.initHistoryStore();

test('queries report an unreadable bucket instead of returning incomplete data', async () => {
    await assert.rejects(historyStore.getAllSnapshots(), HistoryBucketReadError);
    await assert.rejects(historyStore.getPresetList(), HistoryBucketReadError);
    await assert.rejects(historyStore.getStats(), HistoryBucketReadError);
});

test('maintenance performs no writes when any bucket cannot be read', async () => {
    writes = 0;
    await assert.rejects(historyStore.cleanCorruptSnapshots(), HistoryBucketReadError);
    assert.equal(writes, 0);
});
