import test from 'node:test';
import assert from 'node:assert/strict';

import { projectSnapshotSummary } from '../modules/core/snapshot-summary.js';

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

function snapshot(id, timestamp, temperature) {
    return {
        id,
        apiId: 'openai',
        presetName: 'Legacy',
        timestamp,
        trigger: 'manual',
        hash: `hash-${id}`,
        size: 10,
        preset: { temperature, prompts: [] },
    };
}

const stale = snapshot('stale', 1, 0.1);
const authoritative = snapshot('authoritative', 2, 0.9);
stores.set('history', new Map([['openai::Legacy', [authoritative]]]));
stores.set('history_catalog', new Map([['catalog', {
    schemaVersion: 2,
    status: 'ready',
    generation: 1,
    updatedAt: 1,
    sourceManifest: [{ key: 'openai::Legacy', revision: 'legacy' }],
    buckets: {
        '["openai","Legacy"]': [projectSnapshotSummary(stale)],
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
                    getSelectedPresetName() { return 'Legacy'; },
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

test('legacy content changes under the same key invalidate the catalog without panel-path writes', async () => {
    await history.initHistoryStore();

    assert.deepEqual((await history.getSnapshotSummaries()).map(item => item.id), ['authoritative']);
    assert.equal(stores.get('history_v2').has('openai::Legacy'), false);
    assert.equal(history.getHistoryCatalogState().status, 'ready');
});
