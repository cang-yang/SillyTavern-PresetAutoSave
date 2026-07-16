import test from 'node:test';
import assert from 'node:assert/strict';

const stores = new Map();
const localforage = {
    createInstance({ storeName }) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        const store = stores.get(storeName);
        return {
            async getItem(key) { return structuredClone(store.get(key) ?? null); },
            async setItem(key, value) { store.set(key, structuredClone(value)); return value; },
            async removeItem(key) { store.delete(key); },
            async keys() { return [...store.keys()]; },
            async clear() { store.clear(); },
        };
    },
};

function snapshot(id, presetName, timestamp) {
    return {
        id,
        apiId: 'openai',
        presetName,
        timestamp,
        trigger: 'auto',
        hash: `hash-${id}`,
        size: 10,
        preset: { temperature: timestamp, prompts: [] },
    };
}

stores.set('history', new Map([
    ['openai::A', [snapshot('a', 'A', 1)]],
    ['openai::B', [snapshot('b', 'B', 2)]],
]));
stores.set('history_catalog', new Map([['catalog', {
    schemaVersion: 2,
    status: 'ready',
    generation: 1,
    updatedAt: 1,
    sourceManifest: [{ key: 'openai::A', revision: 'legacy' }],
    buckets: {
        '["openai","A"]': [snapshot('a', 'A', 1)],
    },
}]]));

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
                    getSelectedPresetName() { return 'A'; },
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
await history.initHistoryStore();

test('startup rejects a stale ready catalog and rebuilds every authoritative bucket', async () => {
    const summaries = await history.getSnapshotSummaries();

    assert.deepEqual(summaries.map(item => item.id), ['b', 'a']);
    assert.equal(history.getHistoryCatalogState().status, 'ready');
});
