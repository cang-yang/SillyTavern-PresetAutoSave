import test from 'node:test';
import assert from 'node:assert/strict';

const stores = new Map();
const readTrace = [];
let catalogWritesFail = false;
const localforageMock = {
    createInstance({ storeName }) {
        if (!stores.has(storeName)) stores.set(storeName, new Map());
        const storage = stores.get(storeName);
        return {
            async getItem(key) {
                readTrace.push({ storeName, key });
                return structuredClone(storage.get(key) ?? null);
            },
            async setItem(key, value) {
                if (storeName === 'history_catalog' && catalogWritesFail) {
                    throw new Error('catalog write rejected');
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
                    savePreset() {},
                    getPresetSettings() {},
                    selectPreset() {},
                    findPreset() {},
                    getSelectedPresetName() { return 'Catalog Demo'; },
                };
            },
        };
    },
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.document = { querySelector() { return null; }, getElementById() { return null; } };
globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };

const legacyBucket = [
    {
        id: 'legacy-new',
        apiId: 'openai',
        presetName: 'Catalog Demo',
        timestamp: 20,
        trigger: 'auto',
        hash: 'new-hash',
        size: 2_000_000,
        name: 'new',
        pinned: true,
        summary: { isFirst: false, sections: [], rawChangedPaths: ['temperature'] },
        preset: {
            temperature: 0.8,
            top_p: 0.9,
            frequency_penalty: 0,
            presence_penalty: 0,
            openai_max_tokens: 1024,
            prompts: [{ identifier: 'main', content: 'x'.repeat(200_000) }],
        },
    },
    {
        id: 'legacy-old',
        apiId: 'openai',
        presetName: 'Catalog Demo',
        timestamp: 10,
        trigger: 'manual',
        hash: 'old-hash',
        size: 1_000_000,
        name: 'old',
        pinned: false,
        summary: { isFirst: true, sections: [] },
        preset: {
            temperature: 0.7,
            top_p: 0.9,
            frequency_penalty: 0,
            presence_penalty: 0,
            openai_max_tokens: 1024,
            prompts: [{ identifier: 'main', content: 'private-old-prompt' }],
        },
    },
];
stores.set('history', new Map([
    ['openai::Catalog Demo', structuredClone(legacyBucket)],
    ['kobold::Unrelated Large History', [{
        id: 'unrelated-snapshot',
        apiId: 'kobold',
        presetName: 'Unrelated Large History',
        timestamp: 5,
        trigger: 'auto',
        hash: 'unrelated-hash',
        size: 4_000_000,
        preset: { prompts: [{ identifier: 'main', content: 'unrelated-private-payload' }] },
    }]],
]));

const compatibility = await import('../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../modules/settings.js');
await settings.initSettings();
const history = await import('../modules/history-store.js');
await history.initHistoryStore();

test('catalog rebuild reads legacy history without migration writes or preset payload leakage', async () => {
    readTrace.length = 0;

    const summaries = await history.getSnapshotSummaries();
    const diagnostics = await history.getRepositoryDiagnostics();

    assert.deepEqual(summaries.map(item => item.id), ['legacy-new', 'legacy-old', 'unrelated-snapshot']);
    assert.equal(summaries[0].pinned, true);
    assert.equal(summaries[0].parentSnapshotId, null);
    assert.equal(summaries.some(item => Object.hasOwn(item, 'preset')), false);
    assert.equal(JSON.stringify(summaries).includes('private-old-prompt'), false);
    assert.deepEqual(diagnostics.migration, { attempted: 0, succeeded: 0, failed: 0 });
    assert.equal(stores.get('history_v2')?.has('openai::Catalog Demo') ?? false, false);
    assert.ok(stores.get('history_catalog')?.has('catalog'));
    const persistedCatalog = JSON.stringify(stores.get('history_catalog').get('catalog'));
    assert.equal(persistedCatalog.includes('"preset":'), false);
    assert.equal(persistedCatalog.includes('private-old-prompt'), false);
});

test('explicit snapshot lookup remains authoritative and loads the full payload on demand', async () => {
    readTrace.length = 0;
    const snapshot = await history.getSnapshotById('legacy-old');

    assert.equal(snapshot.preset.prompts[0].content, 'private-old-prompt');
    assert.equal(
        readTrace.some(entry => entry.key === 'kobold::Unrelated Large History'),
        false,
        'catalog-directed lookup must not read unrelated preset payload buckets',
    );
});

function validPreset(temperature) {
    return {
        temperature,
        top_p: 0.9,
        frequency_penalty: 0,
        presence_penalty: 0,
        openai_max_tokens: 1024,
        prompts: [],
    };
}

test('successful bucket mutations keep the ready catalog consistent', async () => {
    const added = await history.addSnapshot(
        'Catalog Demo',
        'openai',
        validPreset(0.95),
        history.TRIGGER.MANUAL,
    );
    assert.ok(added?.id);
    assert.ok((await history.getSnapshotSummaries()).some(item => item.id === added.id));

    assert.equal(await history.renameSnapshot(added.id, 'renamed summary'), true);
    assert.equal(
        (await history.getSnapshotSummaries()).find(item => item.id === added.id)?.name,
        'renamed summary',
    );

    assert.equal(await history.togglePinSnapshot(added.id, true), true);
    assert.equal(
        (await history.getSnapshotSummaries()).find(item => item.id === added.id)?.pinned,
        true,
    );

    assert.equal(await history.deleteSnapshot(added.id, { force: true }), true);
    assert.equal((await history.getSnapshotSummaries()).some(item => item.id === added.id), false);

    await history.clearPresetHistory('openai', 'Catalog Demo');
    assert.equal(
        (await history.getSnapshotSummaries()).some(item => item.presetName === 'Catalog Demo'),
        false,
    );
});

test('catalog persistence failure never reverses an authoritative snapshot commit', async () => {
    catalogWritesFail = true;
    const committed = await history.addSnapshot(
        'Catalog Failure Demo',
        'openai',
        validPreset(0.6),
        history.TRIGGER.MANUAL,
    );
    catalogWritesFail = false;

    assert.ok(committed?.id);
    assert.ok((await history.getSnapshots('openai', 'Catalog Failure Demo')).some(item => item.id === committed.id));
    assert.equal(history.getHistoryCatalogState().status, 'dirty');
});
