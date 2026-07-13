import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
const localforage = {
    createInstance() {
        return {
            async getItem(key) { return storage.get(key) ?? null; },
            async setItem(key, value) { storage.set(key, structuredClone(value)); return value; },
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
