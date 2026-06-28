import assert from 'node:assert/strict';

const storage = new Map();
const writes = { set: 0, remove: 0 };

const localforageMock = {
    createInstance() {
        return {
            async getItem(key) { return storage.get(key) ?? null; },
            async setItem(key, value) { writes.set++; storage.set(key, value); return value; },
            async removeItem(key) { writes.remove++; storage.delete(key); },
            async keys() { return Array.from(storage.keys()); },
            async clear() { storage.clear(); },
        };
    },
};

globalThis.SillyTavern = {
    libs: { localforage: localforageMock },
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
                    getSelectedPresetName() { return 'demo'; },
                };
            },
        };
    },
};

globalThis.toastr = {
    info() {},
    success() {},
    warning() {},
    error() {},
};

globalThis.window = globalThis;

globalThis.localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
};

globalThis.document = {
    querySelector() { return null; },
    getElementById() { return null; },
};

const compat = await import('../modules/compatibility.js');
compat.initCompatibility();

const mod = await import('../modules/history-store.js');
await mod.initHistoryStore();

function snap(id, timestamp, pinned = false) {
    return { id, timestamp, pinned, apiId: 'openai', presetName: 'demo', preset: { prompts: [] } };
}

storage.set('openai::demo', [
    snap('oldest', 100),
    snap('pinned-old', 200, true),
    snap('newest', 400),
    snap('old', 300),
]);
writes.set = 0;
writes.remove = 0;

let result = await mod.deleteOldSnapshotsForPreset('openai', 'demo', { keepNewest: 1 });
assert.deepEqual(result, { deleted: 2, kept: 2, total: 4 });
assert.ok(writes.set <= 3, `non-force batch delete should use constant writes, got ${writes.set}`);
assert.equal(writes.remove, 0);
assert.deepEqual(storage.get('openai::demo').map(s => s.id), ['newest', 'pinned-old']);

storage.set('openai::demo', [
    snap('oldest', 100),
    snap('pinned-old', 200, true),
    snap('newest', 400),
    snap('old', 300),
]);
writes.set = 0;
writes.remove = 0;

result = await mod.deleteOldSnapshotsForPreset('openai', 'demo', { keepNewest: 1, force: true });
assert.deepEqual(result, { deleted: 3, kept: 1, total: 4 });
assert.ok(writes.set <= 3, `force batch delete should use constant writes, got ${writes.set}`);
assert.equal(writes.remove, 0);
assert.deepEqual(storage.get('openai::demo').map(s => s.id), ['newest']);

storage.set('openai::demo', [
    snap('newest', 1000),
    ...Array.from({ length: 40 }, (_, i) => snap(`old-${i}`, i)),
]);
writes.set = 0;
writes.remove = 0;

result = await mod.deleteOldSnapshotsForPreset('openai', 'demo', { keepNewest: 1, force: true });
assert.deepEqual(result, { deleted: 40, kept: 1, total: 41 });
assert.ok(writes.set <= 3, `40 old snapshots should still use constant writes, got ${writes.set}`);
assert.deepEqual(storage.get('openai::demo').map(s => s.id), ['newest']);

storage.set('openai::demo', [snap('only', 100)]);
writes.set = 0;
writes.remove = 0;

result = await mod.deleteOldSnapshotsForPreset('openai', 'demo', { keepNewest: 0, force: true });
assert.deepEqual(result, { deleted: 1, kept: 0, total: 1 });
assert.ok(writes.set <= 3, `empty-bucket delete should use constant writes, got ${writes.set}`);
assert.ok(writes.remove <= 3, `empty-bucket delete should use constant removes, got ${writes.remove}`);
assert.equal(storage.has('openai::demo'), false);

console.log('history-store batch delete smoke passed');
