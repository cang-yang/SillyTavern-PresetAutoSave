import test from 'node:test';
import assert from 'node:assert/strict';

import { HistoryRepository, migrationMarkerKey } from '../../modules/core/history-repository.js';

class MemoryStore {
    constructor(entries = {}, { failSet = false, failSetKeyOnce = null, failRemove = false } = {}) {
        this.map = new Map(Object.entries(structuredClone(entries)));
        this.failSet = failSet;
        this.failSetKeyOnce = failSetKeyOnce;
        this.failRemove = failRemove;
    }
    async getItem(key) { return structuredClone(this.map.get(key) ?? null); }
    async setItem(key, value) {
        if (this.failSet) throw new Error('write failed');
        if (key === this.failSetKeyOnce) {
            this.failSetKeyOnce = null;
            throw new Error('targeted write failed');
        }
        this.map.set(key, structuredClone(value));
        return value;
    }
    async removeItem(key) {
        if (this.failRemove) throw new Error('remove failed');
        this.map.delete(key);
    }
    async keys() { return [...this.map.keys()]; }
    async clear() { this.map.clear(); }
}

function legacySnapshot(overrides = {}) {
    return {
        id: 'snap-1', presetName: 'Demo', apiId: 'openai', timestamp: 10,
        trigger: 'auto', preset: { temperature: 0.7, prompts: [] },
        hash: 'abc', size: 42, name: 'important', pinned: true,
        ...overrides,
    };
}

test('lazily migrates, verifies, and then prefers v2 data', async () => {
    const key = 'openai::Demo';
    const legacy = new MemoryStore({ [key]: [legacySnapshot()] });
    const v2 = new MemoryStore();
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });

    const first = await repository.getItem(key);
    assert.equal(first[0].schemaVersion, 2);
    assert.equal(first[0].name, 'important');
    assert.equal((await v2.getItem(migrationMarkerKey(key))).status, 'migrated');
    assert.deepEqual(await legacy.getItem(key), [legacySnapshot()], 'legacy data remains untouched');

    legacy.map.get(key)[0].name = 'legacy changed later';
    const second = await repository.getItem(key);
    assert.equal(second[0].name, 'important');
});

test('failed migration remains retryable and falls back to legacy data', async () => {
    const key = 'openai::Demo';
    const legacy = new MemoryStore({ [key]: [legacySnapshot()] });
    const v2 = new MemoryStore({}, { failSet: true });
    const errors = [];
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2, onError: e => errors.push(e) });

    const result = await repository.getItem(key);
    assert.deepEqual(result, [legacySnapshot()]);
    assert.equal(await v2.getItem(migrationMarkerKey(key)), null);
    assert.equal(errors.length, 1);
});

test('writes v2 envelopes and deterministic parent links', async () => {
    const key = 'openai::Demo';
    const legacy = new MemoryStore();
    const v2 = new MemoryStore();
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });
    const list = [
        legacySnapshot({ id: 'new', timestamp: 20, hash: 'new-hash', preset: { temperature: 0.8 } }),
        legacySnapshot({ id: 'old', timestamp: 10, hash: 'old-hash' }),
    ];

    await repository.setItem(key, list);
    const stored = await v2.getItem(key);
    assert.equal(stored[0].parentSnapshotId, 'old');
    assert.equal(stored[1].parentSnapshotId, null);
    assert.equal(stored[0].canonicalHash, 'new-hash');
    assert.equal((await repository.getItem(key))[0].schemaVersion, 2);
});

test('restores the previous committed bucket when publishing its marker fails', async () => {
    const key = 'openai::Demo';
    const markerKey = migrationMarkerKey(key);
    const previous = [legacySnapshot({ id: 'previous', name: 'must survive' })];
    const previousMarker = {
        status: 'active', schemaVersion: 2, count: 1, migratedAt: 5,
    };
    const v2 = new MemoryStore({
        [key]: previous,
        [markerKey]: previousMarker,
    }, { failSetKeyOnce: markerKey });
    const repository = new HistoryRepository({ legacyStore: new MemoryStore(), v2Store: v2 });

    await assert.rejects(
        repository.setItem(key, [legacySnapshot({ id: 'replacement', name: 'must roll back' })]),
        /targeted write failed/,
    );
    assert.deepEqual(await v2.getItem(key), previous);
    assert.deepEqual(await v2.getItem(markerKey), previousMarker);
});

test('lists the union of stores while filtering metadata and tombstoned legacy keys', async () => {
    const removed = 'openai::Removed';
    const legacy = new MemoryStore({
        'openai::Legacy': [legacySnapshot()],
        [removed]: [legacySnapshot({ presetName: 'Removed' })],
    });
    const v2 = new MemoryStore({ 'kobold::V2': [legacySnapshot({ apiId: 'kobold', presetName: 'V2' })] });
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });
    await repository.removeItem(removed);

    assert.deepEqual((await repository.keys()).sort(), ['kobold::V2', 'openai::Legacy']);
    assert.notEqual(await legacy.getItem(removed), null, 'remove must not delete rollback data');
    assert.equal(await repository.getItem(removed), null);
});

test('clear tombstones every visible key without deleting legacy rollback data', async () => {
    const legacy = new MemoryStore({ 'openai::A': [legacySnapshot({ presetName: 'A' })] });
    const v2 = new MemoryStore({ 'openai::B': [legacySnapshot({ presetName: 'B' })] });
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });

    await repository.clear();
    assert.deepEqual(await repository.keys(), []);
    assert.notEqual(await legacy.getItem('openai::A'), null);
    assert.equal((await v2.getItem(migrationMarkerKey('openai::A'))).status, 'deleted');
});

test('a failed physical delete cannot resurrect legacy history', async () => {
    const key = 'openai::Demo';
    const legacy = new MemoryStore({ [key]: [legacySnapshot()] });
    const v2 = new MemoryStore({ [key]: [legacySnapshot()] }, { failRemove: true });
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });

    await assert.rejects(repository.removeItem(key), /remove failed/);
    assert.equal((await v2.getItem(migrationMarkerKey(key))).status, 'deleted');
    assert.equal(await repository.getItem(key), null);
    assert.deepEqual(await repository.keys(), []);
});

test('reports repository marker state and migration counters', async () => {
    const legacy = new MemoryStore({ 'openai::Legacy': [legacySnapshot()] });
    const v2 = new MemoryStore({ 'openai::Current': [legacySnapshot({ presetName: 'Current' })] });
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });

    await repository.getItem('openai::Legacy');
    await repository.removeItem('openai::Current');
    const diagnostics = await repository.getDiagnostics();

    assert.equal(diagnostics.schemaVersion, 2);
    assert.equal(diagnostics.legacyKeyCount, 1);
    assert.equal(diagnostics.v2KeyCount, 1);
    assert.deepEqual(diagnostics.markers, { active: 0, migrated: 1, deleted: 1, other: 0 });
    assert.deepEqual(diagnostics.migration, { attempted: 1, succeeded: 1, failed: 0 });
});

test('failed migrations are counted without making diagnostics throw', async () => {
    const legacy = new MemoryStore({ 'openai::Demo': [legacySnapshot()] });
    const v2 = new MemoryStore({}, { failSet: true });
    const repository = new HistoryRepository({ legacyStore: legacy, v2Store: v2 });

    await repository.getItem('openai::Demo');
    const diagnostics = await repository.getDiagnostics();
    assert.deepEqual(diagnostics.migration, { attempted: 1, succeeded: 0, failed: 1 });
    assert.equal(diagnostics.legacyKeyCount, 1);
});
