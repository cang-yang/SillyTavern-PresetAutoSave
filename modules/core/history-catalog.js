import { SerialTaskQueue } from './serial-task-queue.js';
import {
    fingerprintSnapshotSummaries,
    projectSnapshotSummaries,
} from './snapshot-summary.js';

const CATALOG_DOCUMENT_KEY = 'catalog';
const CATALOG_SCHEMA_VERSION = 2;

function stableBucketKey(apiId, presetName) {
    return JSON.stringify([apiId, presetName]);
}

function cloneBuckets(buckets) {
    return structuredClone(buckets);
}

function flattenBuckets(buckets) {
    const summaries = Object.values(buckets).flat();
    summaries.sort((a, b) => {
        const time = (b.timestamp || 0) - (a.timestamp || 0);
        return time || String(a.id).localeCompare(String(b.id), 'en');
    });
    return summaries;
}

function normalizeSourceManifest(sourceManifest) {
    if (!Array.isArray(sourceManifest)) return null;
    const normalized = sourceManifest.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        if (typeof entry.key !== 'string' || entry.key === '') return null;
        if (typeof entry.revision !== 'string' || entry.revision === '') return null;
        return { key: entry.key, revision: entry.revision };
    });
    if (normalized.some(entry => entry === null)) return null;
    normalized.sort((left, right) => left.key.localeCompare(right.key, 'en'));
    if (normalized.some((entry, index) => index > 0 && entry.key === normalized[index - 1].key)) {
        return null;
    }
    return normalized;
}

function manifestsEqual(left, right) {
    const normalizedLeft = normalizeSourceManifest(left);
    const normalizedRight = normalizeSourceManifest(right);
    if (!normalizedLeft || !normalizedRight || normalizedLeft.length !== normalizedRight.length) return false;
    return normalizedLeft.every((entry, index) => (
        entry.key === normalizedRight[index].key
        && entry.revision === normalizedRight[index].revision
    ));
}

function projectBucket(snapshots, expected = null) {
    const summaries = projectSnapshotSummaries(snapshots);
    if (summaries.length === 0) return summaries;
    const apiId = expected?.apiId ?? summaries[0].apiId;
    const presetName = expected?.presetName ?? summaries[0].presetName;
    if (summaries.some(item => item.apiId !== apiId || item.presetName !== presetName)) {
        throw new TypeError('Catalog bucket contains mixed stable preset identities');
    }
    return summaries;
}

function decodeDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
    if (document.schemaVersion !== CATALOG_SCHEMA_VERSION) return null;
    if (document.status !== 'ready' && document.status !== 'dirty') return null;
    if (!document.buckets || typeof document.buckets !== 'object' || Array.isArray(document.buckets)) return null;
    const sourceManifest = normalizeSourceManifest(document.sourceManifest);
    if (!sourceManifest) return null;

    const buckets = {};
    for (const value of Object.values(document.buckets)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        const summaries = projectBucket(value);
        buckets[stableBucketKey(summaries[0].apiId, summaries[0].presetName)] = [...summaries];
    }
    return {
        status: document.status,
        generation: Number.isInteger(document.generation) && document.generation >= 0
            ? document.generation
            : 0,
        buckets,
        sourceManifest,
    };
}

function abortError() {
    const error = new Error('Catalog rebuild aborted');
    error.name = 'AbortError';
    return error;
}

export function createHistoryCatalog({
    store,
    yieldControl = () => Promise.resolve(),
    yieldEvery = 1,
    now = () => Date.now(),
} = {}) {
    if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function') {
        throw new TypeError('History catalog requires an async key-value store');
    }
    if (typeof yieldControl !== 'function') throw new TypeError('yieldControl must be a function');
    if (!Number.isInteger(yieldEvery) || yieldEvery < 1) throw new TypeError('yieldEvery must be a positive integer');
    if (typeof now !== 'function') throw new TypeError('now must be a function');

    const writes = new SerialTaskQueue();
    let status = 'missing';
    let generation = 0;
    let verifiedBuckets = {};
    let verifiedSourceManifest = [];
    let progress = { completed: 0, total: 0 };
    let errorCode = '';

    function read() {
        return {
            status,
            summaries: structuredClone(flattenBuckets(verifiedBuckets)),
            progress: { ...progress },
            generation,
            errorCode,
        };
    }

    function documentFor(nextBuckets, nextSourceManifest, nextGeneration, nextStatus = 'ready') {
        return {
            schemaVersion: CATALOG_SCHEMA_VERSION,
            status: nextStatus,
            generation: nextGeneration,
            updatedAt: now(),
            sourceManifest: structuredClone(nextSourceManifest),
            buckets: cloneBuckets(nextBuckets),
        };
    }

    async function publish(
        nextBuckets,
        nextSourceManifest,
        nextStatus = 'ready',
        { allowTransient = false } = {},
    ) {
        const nextGeneration = generation + 1;
        let persistenceError = null;
        try {
            await store.setItem(
                CATALOG_DOCUMENT_KEY,
                documentFor(nextBuckets, nextSourceManifest, nextGeneration, nextStatus),
            );
        } catch (error) {
            if (!allowTransient) throw error;
            persistenceError = error;
        }
        verifiedBuckets = cloneBuckets(nextBuckets);
        verifiedSourceManifest = structuredClone(nextSourceManifest);
        generation = nextGeneration;
        status = nextStatus;
        errorCode = persistenceError ? 'CATALOG_PERSISTENCE_UNAVAILABLE' : '';
        return read();
    }

    return Object.freeze({
        load() {
            return writes.run(async () => {
                let stored;
                try {
                    stored = await store.getItem(CATALOG_DOCUMENT_KEY);
                } catch (error) {
                    status = 'error';
                    errorCode = 'CATALOG_READ_FAILED';
                    throw error;
                }
                if (stored === null || stored === undefined) {
                    status = 'missing';
                    generation = 0;
                    verifiedBuckets = {};
                    verifiedSourceManifest = [];
                    progress = { completed: 0, total: 0 };
                    errorCode = '';
                    return read();
                }
                let decoded = null;
                try { decoded = decodeDocument(stored); } catch (_) {}
                if (!decoded) {
                    status = 'dirty';
                    generation = 0;
                    verifiedBuckets = {};
                    verifiedSourceManifest = [];
                    progress = { completed: 0, total: 0 };
                    errorCode = 'CATALOG_CORRUPT';
                    return read();
                }
                status = decoded.status;
                generation = decoded.generation;
                verifiedBuckets = decoded.buckets;
                verifiedSourceManifest = decoded.sourceManifest;
                progress = { completed: 0, total: 0 };
                errorCode = '';
                return read();
            });
        },

        read,

        matchesSourceManifest(sourceManifest) {
            const normalized = normalizeSourceManifest(sourceManifest);
            return status === 'ready'
                && normalized !== null
                && normalized.every(entry => entry.revision !== 'legacy')
                && manifestsEqual(verifiedSourceManifest, normalized);
        },

        replaceBucket(apiId, presetName, snapshots) {
            return writes.run(async () => {
                const projected = projectBucket(snapshots, { apiId, presetName });
                const nextBuckets = cloneBuckets(verifiedBuckets);
                const key = stableBucketKey(apiId, presetName);
                const sourceKey = `${apiId}::${presetName}`;
                const nextSourceManifest = verifiedSourceManifest
                    .filter(entry => entry.key !== sourceKey);
                if (projected.length > 0) nextBuckets[key] = [...projected];
                else delete nextBuckets[key];
                if (projected.length > 0) {
                    nextSourceManifest.push({
                        key: sourceKey,
                        revision: fingerprintSnapshotSummaries(snapshots),
                    });
                    nextSourceManifest.sort((left, right) => left.key.localeCompare(right.key, 'en'));
                }
                try {
                    return await publish(
                        nextBuckets,
                        nextSourceManifest,
                        status === 'ready' ? 'ready' : 'dirty',
                    );
                } catch (error) {
                    status = 'error';
                    errorCode = 'CATALOG_WRITE_FAILED';
                    throw error;
                }
            });
        },

        removeBucket(apiId, presetName) {
            return writes.run(async () => {
                const nextBuckets = cloneBuckets(verifiedBuckets);
                delete nextBuckets[stableBucketKey(apiId, presetName)];
                const sourceKey = `${apiId}::${presetName}`;
                const nextSourceManifest = verifiedSourceManifest
                    .filter(entry => entry.key !== sourceKey);
                try {
                    return await publish(
                        nextBuckets,
                        nextSourceManifest,
                        status === 'ready' ? 'ready' : 'dirty',
                    );
                } catch (error) {
                    status = 'error';
                    errorCode = 'CATALOG_WRITE_FAILED';
                    throw error;
                }
            });
        },

        rebuild({
            keys,
            sourceManifest = null,
            resolveSourceManifest = null,
            readBucket,
            onProgress = () => {},
            signal,
        } = {}) {
            return writes.run(async () => {
                if (!Array.isArray(keys)) throw new TypeError('Catalog rebuild requires a key array');
                if (typeof readBucket !== 'function') throw new TypeError('Catalog rebuild requires readBucket');
                if (resolveSourceManifest !== null && typeof resolveSourceManifest !== 'function') {
                    throw new TypeError('resolveSourceManifest must be a function');
                }
                const suppliedManifest = sourceManifest === null
                    ? null
                    : normalizeSourceManifest(sourceManifest);
                if (sourceManifest !== null && !suppliedManifest) {
                    throw new TypeError('Catalog rebuild requires a valid source manifest');
                }
                if (suppliedManifest) {
                    const manifestKeys = suppliedManifest.map(entry => entry.key);
                    const rebuildKeys = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
                    if (
                        manifestKeys.length !== rebuildKeys.length
                        || manifestKeys.some((key, index) => key !== rebuildKeys[index])
                    ) {
                        throw new TypeError('Catalog source manifest must match rebuild keys');
                    }
                }
                status = 'building';
                errorCode = '';
                progress = { completed: 0, total: keys.length };
                onProgress({ ...progress });
                const nextBuckets = {};
                const derivedManifest = [];
                try {
                    for (const key of keys) {
                        if (signal?.aborted) throw abortError();
                        const snapshots = await readBucket(key);
                        if (signal?.aborted) throw abortError();
                        const projected = projectBucket(snapshots);
                        if (projected.length > 0) {
                            nextBuckets[stableBucketKey(projected[0].apiId, projected[0].presetName)] = [...projected];
                        }
                        derivedManifest.push({
                            key,
                            revision: fingerprintSnapshotSummaries(snapshots),
                        });
                        progress = { completed: progress.completed + 1, total: keys.length };
                        onProgress({ ...progress });
                        if (progress.completed % yieldEvery === 0) {
                            await yieldControl();
                        }
                    }
                    if (signal?.aborted) throw abortError();
                    const resolvedManifest = suppliedManifest
                        ?? (resolveSourceManifest
                            ? normalizeSourceManifest(await resolveSourceManifest())
                            : derivedManifest);
                    if (!resolvedManifest) {
                        throw new TypeError('Catalog rebuild resolved an invalid source manifest');
                    }
                    const resolvedKeys = resolvedManifest.map(entry => entry.key);
                    const rebuildKeys = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
                    if (
                        resolvedKeys.length !== rebuildKeys.length
                        || resolvedKeys.some((key, index) => key !== rebuildKeys[index])
                    ) {
                        throw new TypeError('Catalog resolved source manifest must match rebuild keys');
                    }
                    return await publish(
                        nextBuckets,
                        resolvedManifest,
                        'ready',
                        { allowTransient: true },
                    );
                } catch (error) {
                    if (error?.name === 'AbortError') {
                        status = 'dirty';
                        errorCode = 'CATALOG_REBUILD_ABORTED';
                    } else {
                        status = 'error';
                        errorCode = 'CATALOG_REBUILD_FAILED';
                    }
                    throw error;
                }
            });
        },

        markDirty(reason = 'CATALOG_DIRTY') {
            return writes.run(async () => {
                status = 'dirty';
                errorCode = String(reason || 'CATALOG_DIRTY');
                try {
                    await store.setItem(
                        CATALOG_DOCUMENT_KEY,
                        documentFor(verifiedBuckets, verifiedSourceManifest, generation, 'dirty'),
                    );
                } catch (_) {
                    // The in-memory state remains safely dirty even if the
                    // derived persistence layer is unavailable.
                }
                return read();
            });
        },
    });
}

export { CATALOG_DOCUMENT_KEY, CATALOG_SCHEMA_VERSION };
