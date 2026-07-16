import test from 'node:test';
import assert from 'node:assert/strict';

const storages = new Map();
const readTrace = [];
const localforage = {
    createInstance({ storeName }) {
        if (!storages.has(storeName)) storages.set(storeName, new Map());
        const storage = storages.get(storeName);
        return {
            async getItem(key) {
                readTrace.push({ storeName, key });
                return structuredClone(storage.get(key) ?? null);
            },
            async setItem(key, value) {
                storage.set(key, structuredClone(value));
                return value;
            },
            async removeItem(key) { storage.delete(key); },
            async keys() { return [...storage.keys()]; },
            async clear() { storage.clear(); },
        };
    },
};

globalThis.window = globalThis;
globalThis.document = {
    querySelector() { return null; },
    getElementById() { return null; },
};
globalThis.SillyTavern = {
    libs: { localforage },
    getContext: () => ({
        eventSource: { on() {}, off() {} },
        event_types: {},
        getPresetManager: () => null,
    }),
};

const compatibility = await import('../modules/compatibility.js');
compatibility.initCompatibility();
const archive = await import('../modules/archive-store.js');
await archive.initArchiveStore();

test('empty archive statistics use finite timestamp boundaries', async () => {
    const stats = await archive.getArchiveStats();
    assert.equal(stats.total, 0);
    assert.equal(stats.oldestAt, 0);
    assert.equal(stats.newestAt, 0);
    assert.equal(Number.isFinite(stats.oldestAt), true);
});

test('archive statistics summarize stored entries', async () => {
    await archive.archivePreset('openai', 'Story V1', { temperature: 1 }, 'Story');
    const stats = await archive.getArchiveStats();
    assert.equal(stats.total, 1);
    assert.deepEqual(stats.byApi, { openai: 1 });
    assert.deepEqual(stats.bySeries, { Story: 1 });
    assert.equal(stats.oldestAt, stats.newestAt);
});

test('archive summaries omit preset payloads and warm reads avoid authoritative payload entries', async () => {
    await archive.archivePreset(
        'openai',
        'Story V2',
        { prompts: [{ identifier: 'main', content: 'private archive payload' }] },
        'Story',
    );

    readTrace.length = 0;
    const first = await archive.listArchivedPresetSummaries();
    assert.deepEqual(first.map(item => item.presetName).sort(), ['Story V1', 'Story V2']);
    assert.equal(first.some(item => Object.hasOwn(item, 'data')), false);
    assert.equal(JSON.stringify(first).includes('private archive payload'), false);
    assert.equal(
        readTrace.some(entry => (
            entry.storeName === 'archived_presets'
            && !entry.key.startsWith('__archive_summary__::')
        )),
        false,
        'a cold summary read should use persisted metadata instead of complete archived presets',
    );

    readTrace.length = 0;
    const warm = await archive.listArchivedPresetSummaries();
    assert.equal(warm.length, 2);
    assert.equal(
        readTrace.some(entry => entry.storeName === 'archived_presets'),
        false,
        'a verified archive catalog must not read complete archived preset values',
    );
});

test('summary cache misses include newly archived authoritative entries', async () => {
    await archive.archivePreset('openai', 'Story V3', { temperature: 0.3 }, 'Story');
    const summaries = await archive.listArchivedPresetSummaries();

    assert.equal(summaries.some(item => item.presetName === 'Story V3'), true);
});

test('same-key rearchive refreshes warm summary metadata without persistent invalidation', async () => {
    await archive.archivePreset('openai', 'Story V4', { temperature: 0.4 }, 'Story Old', 'old-reason');
    await archive.listArchivedPresetSummaries();

    const archived = await archive.archivePreset(
        'openai',
        'Story V4',
        { temperature: 0.8 },
        'Story New',
        'new-reason',
    );
    const summary = (await archive.listArchivedPresetSummaries())
        .find(item => item.presetName === 'Story V4');

    assert.equal(archived, true);
    assert.equal(summary.seriesKey, 'Story New');
    assert.equal(summary.reason, 'new-reason');
    assert.equal(storages.has('archived_preset_catalog'), false);
});

test('obsolete persisted archive catalogs cannot override authoritative summaries', async () => {
    storages.set('archived_preset_catalog', new Map([['catalog', {
        schemaVersion: 1,
        keys: ['openai::Story V4'],
        entries: [{
            apiId: 'openai',
            presetName: 'Story V4',
            seriesKey: 'Corrupt',
            archivedAt: 1,
            reason: 'corrupt',
        }],
    }]]));
    await archive.archivePreset('openai', 'Story V5', { temperature: 0.5 }, 'Story');

    const summaries = await archive.listArchivedPresetSummaries();

    assert.equal(summaries.find(item => item.presetName === 'Story V4').seriesKey, 'Story New');
    assert.equal(summaries.some(item => item.presetName === 'Story V5'), true);
});
