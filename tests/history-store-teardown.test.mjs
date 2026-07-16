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

stores.set('history', new Map([['openai::Legacy', [{
    id: 'legacy',
    apiId: 'openai',
    presetName: 'Legacy',
    timestamp: 1,
    trigger: 'auto',
    hash: 'hash',
    size: 10,
    preset: { temperature: 0.7, prompts: [] },
}]]]));

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
                    getSelectedPresetName() { return 'Legacy'; },
                };
            },
        };
    },
};
globalThis.window = globalThis;
globalThis.document = { querySelector() { return null; }, getElementById() { return null; } };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.scheduler = { yield: () => Promise.resolve() };

const compatibility = await import('../modules/compatibility.js');
compatibility.initCompatibility();
const history = await import('../modules/history-store.js');

test('history teardown cancels deferred migration before it can write', async () => {
    await history.initHistoryStore();
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    let nextTimer = 0;
    const timers = new Map();
    globalThis.setTimeout = callback => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
    };
    globalThis.clearTimeout = id => timers.delete(id);

    try {
        await history.getSnapshotSummaries();
        assert.equal(timers.size, 1, 'legacy migration should be deferred outside panel open');

        await history.teardownHistoryStore();

        assert.equal(timers.size, 0);
        assert.equal(stores.get('history_v2')?.has('openai::Legacy') ?? false, false);
        await assert.rejects(history.getSnapshotSummaries(), /not initialized/);
    } finally {
        globalThis.setTimeout = nativeSetTimeout;
        globalThis.clearTimeout = nativeClearTimeout;
    }
});
