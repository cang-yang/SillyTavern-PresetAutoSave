import test from 'node:test';
import assert from 'node:assert/strict';

const stores = new Map();
let quotaArmed = false;
let dataWriteAttempt = 0;
const quotaAttempts = new Set([1, 4]);

const localforageMock = {
    createInstance({ storeName }) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        const storage = stores.get(storeName);
        return {
            async getItem(key) { return structuredClone(storage.get(key) ?? null); },
            async setItem(key, value) {
                const isHistoryData = storeName === 'history_v2'
                    && !String(key).startsWith('__history_v2_meta__::');
                if (quotaArmed && isHistoryData) {
                    dataWriteAttempt++;
                    if (quotaAttempts.has(dataWriteAttempt)) {
                        const error = new Error(`quota failure ${dataWriteAttempt}`);
                        error.name = 'QuotaExceededError';
                        throw error;
                    }
                }
                storage.set(key, structuredClone(value));
                return value;
            },
            async removeItem(key) { storage.delete(key); },
            async keys() { return [...storage.keys()]; },
            async clear() { storage.clear(); },
        };
    },
};

const extensionSettings = {};
globalThis.SillyTavern = {
    libs: { localforage: localforageMock },
    getContext() {
        return {
            extensionSettings,
            saveSettingsDebounced() {},
            eventSource: { on() {}, off() {}, emit() {} },
            event_types: {},
            getPresetManager() {
                return {
                    savePreset() {}, getPresetSettings() {}, selectPreset() {}, findPreset() {},
                    getSelectedPresetName() { return 'quota-preservation'; },
                };
            },
        };
    },
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document = { querySelector() { return null; }, getElementById() { return null; } };
globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };

const compatibility = await import('../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ mergeWindowSec: 0, maxHistoryPerPreset: 50, skipUnchangedSave: true });
const history = await import('../modules/history-store.js');
await history.initHistoryStore();

function preset(temperature) {
    return {
        temperature,
        top_p: 0.9,
        frequency_penalty: 0,
        presence_penalty: 0,
        openai_max_tokens: 1024,
        prompts: [],
    };
}

test('quota failure preserves every previously committed recovery point', async () => {
    for (let index = 0; index < 12; index++) {
        await history.addSnapshot(
            'quota-preservation',
            'openai',
            preset(0.1 + index / 100),
            history.TRIGGER.MANUAL,
        );
    }
    const before = structuredClone(await history.getSnapshots('openai', 'quota-preservation'));
    quotaArmed = true;

    await assert.rejects(
        history.addSnapshot('quota-preservation', 'openai', preset(0.99), history.TRIGGER.MANUAL),
        /quota/i,
    );

    const after = await history.getSnapshots('openai', 'quota-preservation');
    assert.deepEqual(after, before);
    assert.equal(after.some(snapshot => snapshot.preset.temperature === 0.99), false);
});
