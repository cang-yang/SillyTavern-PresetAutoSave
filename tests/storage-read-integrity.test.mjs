import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, StorageReadError } from '../modules/compatibility.js';
import {
    HistoryBucketReadError,
    readHistoryBucket,
    readHistoryBuckets,
} from '../modules/core/history-bucket-reader.js';
import { HistoryRepository } from '../modules/core/history-repository.js';

function installLocalStorage(entries = {}) {
    const values = new Map(Object.entries(entries));
    globalThis.localStorage = {
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] ?? null; },
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    };
}

test('localStorage corruption throws a diagnosable error without exposing the storage key', async () => {
    installLocalStorage({ 'audit_store:private preset': '{not json' });
    const storage = createStorage('audit', 'store');

    await assert.rejects(storage.getItem('private preset'), (error) => {
        assert.ok(error instanceof StorageReadError);
        assert.equal(error.code, 'STORAGE_VALUE_CORRUPT');
        assert.match(error.keyFingerprint, /^key-[0-9a-f]{8}$/);
        assert.doesNotMatch(error.message, /private preset/);
        return true;
    });
});

test('a missing bucket is empty but a malformed bucket fails closed', async () => {
    const missingStore = { async getItem() { return null; } };
    const malformedStore = { async getItem() { return { unexpected: true }; } };

    assert.deepEqual(await readHistoryBucket(missingStore, 'missing'), []);
    await assert.rejects(readHistoryBucket(malformedStore, 'private malformed'), (error) => {
        assert.ok(error instanceof HistoryBucketReadError);
        assert.equal(error.failedCount, 1);
        assert.doesNotMatch(error.message, /private malformed/);
        return true;
    });
});

test('cross-bucket reads never return a partial success', async () => {
    const store = {
        async getItem(key) {
            if (key === 'broken private bucket') throw new Error('IndexedDB unavailable');
            return [{ id: key }];
        },
    };

    await assert.rejects(
        readHistoryBuckets(store, ['healthy', 'broken private bucket', 'also-healthy']),
        (error) => {
            assert.ok(error instanceof HistoryBucketReadError);
            assert.equal(error.failedCount, 1);
            assert.equal(error.totalCount, 3);
            assert.doesNotMatch(error.message, /broken private bucket/);
            return true;
        },
    );
});

test('repository refuses to overwrite a malformed current v2 bucket', async () => {
    let writes = 0;
    const v2Store = {
        async getItem(key) { return key.startsWith('__history_v2_meta__') ? null : { malformed: true }; },
        async setItem() { writes++; },
        async removeItem() { writes++; },
    };
    const legacyStore = { async getItem() { return [{ id: 'legacy' }]; } };
    const repository = new HistoryRepository({ legacyStore, v2Store });

    await assert.rejects(repository.getItem('private preset'), HistoryBucketReadError);
    await assert.rejects(repository.setItem('private preset', [{ id: 'replacement' }]), HistoryBucketReadError);
    assert.equal(writes, 0);
});
