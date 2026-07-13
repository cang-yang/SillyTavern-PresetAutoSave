import { fingerprintStorageKey } from './storage-integrity.js';

export class HistoryBucketReadError extends AggregateError {
    constructor(failures, totalCount) {
        super(
            failures.map(({ error }) => error),
            `History read failed for ${failures.length} of ${totalCount} buckets`,
        );
        this.name = 'HistoryBucketReadError';
        this.code = 'HISTORY_BUCKET_READ_FAILED';
        this.failedCount = failures.length;
        this.totalCount = totalCount;
        this.failures = failures.map(({ key, error }) => ({
            keyFingerprint: fingerprintStorageKey(key),
            code: error?.code || 'HISTORY_BUCKET_UNREADABLE',
        }));
    }
}

function malformedBucketError(key) {
    const error = new TypeError(`History bucket has an invalid shape (${fingerprintStorageKey(key)})`);
    error.code = 'HISTORY_BUCKET_MALFORMED';
    return error;
}

export async function readOptionalHistoryBucket(store, key) {
    let value;
    try {
        value = await store.getItem(key);
    } catch (error) {
        throw new HistoryBucketReadError([{ key, error }], 1);
    }
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) {
        throw new HistoryBucketReadError([{ key, error: malformedBucketError(key) }], 1);
    }
    return value;
}

export async function readHistoryBuckets(store, keys) {
    const settled = await Promise.allSettled(keys.map((key) => store.getItem(key)));
    const failures = [];
    const lists = settled.map((result, index) => {
        if (result.status === 'rejected') {
            failures.push({ key: keys[index], error: result.reason });
            return null;
        }
        if (result.value === null || result.value === undefined) return [];
        if (!Array.isArray(result.value)) {
            failures.push({ key: keys[index], error: malformedBucketError(keys[index]) });
            return null;
        }
        return result.value;
    });

    if (failures.length > 0) throw new HistoryBucketReadError(failures, keys.length);
    return lists;
}

export async function readHistoryBucket(store, key) {
    return (await readOptionalHistoryBucket(store, key)) ?? [];
}
