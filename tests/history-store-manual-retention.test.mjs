import test from 'node:test';
import assert from 'node:assert/strict';

const stores = new Map();
const localforageMock = {
    createInstance({ storeName }) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        const storage = stores.get(storeName);
        return {
            async getItem(key) { return structuredClone(storage.get(key) ?? null); },
            async setItem(key, value) { storage.set(key, structuredClone(value)); return value; },
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
                    savePreset() {},
                    getPresetSettings() {},
                    selectPreset() {},
                    findPreset() {},
                    getSelectedPresetName() { return 'manual-retention'; },
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
settings.batchUpdate({ mergeWindowSec: 30, maxHistoryPerPreset: 50, skipUnchangedSave: true });
const history = await import('../modules/history-store.js');
const { canCoalesceSnapshotTrigger } = await import('../modules/core/snapshot-retention-policy.js');
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

test('manual snapshots never merge over an earlier recovery point', async () => {
    const first = await history.addSnapshot('manual-retention', 'openai', preset(0.7), history.TRIGGER.MANUAL);
    const preserved = structuredClone(first);
    const second = await history.addSnapshot('manual-retention', 'openai', preset(0.9), history.TRIGGER.MANUAL);
    const snapshots = await history.getSnapshots('openai', 'manual-retention');

    assert.ok(first?.id);
    assert.ok(second?.id);
    assert.notEqual(second.id, first.id);
    assert.equal(snapshots.length, 2);
    const retained = snapshots.find(snapshot => snapshot.id === first.id);
    assert.equal(retained.hash, preserved.hash);
    assert.equal(retained.timestamp, preserved.timestamp);
    assert.equal(retained.trigger, preserved.trigger);
    assert.equal(retained.name, preserved.name);
    assert.equal(retained.pinned, preserved.pinned);
    assert.deepEqual(retained.preset, preserved.preset);
    assert.equal(snapshots[0].preset.temperature, 0.9);
    assert.equal(snapshots[1].preset.temperature, 0.7);
});

test('only automatic observations are eligible for merge-window coalescing', () => {
    assert.equal(canCoalesceSnapshotTrigger(history.TRIGGER.AUTO), true);
    assert.equal(canCoalesceSnapshotTrigger(history.TRIGGER.MANUAL), false);
    assert.equal(canCoalesceSnapshotTrigger(history.TRIGGER.SWITCH_GUARD), false);
    assert.equal(canCoalesceSnapshotTrigger(history.TRIGGER.RESTORE), false);
    assert.equal(canCoalesceSnapshotTrigger('unknown'), false);
});
