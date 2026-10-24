import test from 'node:test';
import assert from 'node:assert/strict';
import { initSettings, batchUpdate, getSettings } from '../modules/settings.js';
import { initHistoryStore, addSnapshot, getSnapshots, teardownHistoryStore } from '../modules/history-store.js';
import { initCompatibility } from '../modules/compatibility.js';
import { bindSettingsEvents } from '../modules/panel-settings-log.js';

const stores = new Map();
const localforage = {
    createInstance({ name, storeName }) {
        const key = `${name}::${storeName}`;
        if (!stores.has(key)) stores.set(key, new Map());
        const data = stores.get(key);
        return {
            async getItem(key) { return data.get(key) ?? null; },
            async setItem(key, value) { data.set(key, structuredClone(value)); return value; },
            async removeItem(key) { data.delete(key); },
            async keys() { return [...data.keys()]; },
            async clear() { data.clear(); },
        };
    },
};
const context = {
    mainApi: 'openai', extensionSettings: {}, saveSettingsDebounced() {},
    eventSource: { on() {}, off() {} }, event_types: {},
    getPresetManager: () => ({ savePreset() {}, getPresetSettings() {} }),
};
globalThis.SillyTavern = { libs: { localforage }, getContext: () => context };
globalThis.window = globalThis;
globalThis.confirm = () => true;
globalThis.document = { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
initCompatibility();
await initSettings();
await initHistoryStore();

test('clear all history preserves every organization setting', async () => {
    const organization = {
        groupingManualOverrides: { 'Utility V1': 'Story' },
        groupingSeriesAliases: { story: 'Creative' },
        groupingTree: { story: 'parent' },
        seriesDefaultApply: { story: 'Story V2' },
    };
    batchUpdate({ ...organization, seedSnapshotsDone: true });
    await addSnapshot('Story V2', 'openai', { temperature: 0.7 }, 'manual');
    let click;
    const button = {
        addEventListener(type, handler) { if (type === 'click') click = handler; },
        removeEventListener() {},
    };
    const root = {};
    const container = {
        querySelectorAll: () => [],
        querySelector: selector => selector === '.pas-btn-clear-all' ? button : null,
    };
    const mount = bindSettingsEvents(container, { root: () => root, refreshData: async () => {} });
    try {
        await click({});
        assert.equal((await getSnapshots('openai', 'Story V2')).length, 0);
        for (const key of Object.keys(organization)) assert.deepEqual(getSettings()[key], organization[key]);
        assert.equal(getSettings().seedSnapshotsDone, false);
    } finally {
        mount.destroy();
        await teardownHistoryStore();
    }
});
