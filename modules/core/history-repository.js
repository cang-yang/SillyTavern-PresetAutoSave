import { enrichSnapshotList, verifyMigratedSnapshotList, HISTORY_SCHEMA_VERSION } from './history-schema.js';

const META_PREFIX = '__history_v2_meta__::';

export function migrationMarkerKey(key) {
    return `${META_PREFIX}${encodeURIComponent(key)}`;
}

function isDataKey(key) {
    return typeof key === 'string' && !key.startsWith(META_PREFIX);
}

export class HistoryRepository {
    constructor({ legacyStore, v2Store, now = () => Date.now(), onError = () => {} } = {}) {
        if (!legacyStore || !v2Store) throw new TypeError('HistoryRepository requires legacyStore and v2Store');
        this.legacyStore = legacyStore;
        this.v2Store = v2Store;
        this.now = now;
        this.onError = onError;
        this.migrations = new Map();
    }

    async getItem(key) {
        const current = await this.v2Store.getItem(key);
        if (Array.isArray(current)) return current;

        const marker = await this.v2Store.getItem(migrationMarkerKey(key));
        if (marker?.status === 'deleted') return null;

        const legacy = await this.legacyStore.getItem(key);
        if (!Array.isArray(legacy)) return null;
        return this.#migrate(key, legacy);
    }

    async #migrate(key, legacy) {
        if (this.migrations.has(key)) return this.migrations.get(key);
        const operation = (async () => {
            try {
                return await this.#writeVerified(key, legacy, 'migrated');
            } catch (error) {
                this.onError(error, { operation: 'migrate', key });
                return legacy;
            } finally {
                this.migrations.delete(key);
            }
        })();
        this.migrations.set(key, operation);
        return operation;
    }

    async #writeVerified(key, input, status = 'active') {
        const enriched = enrichSnapshotList(input);
        try {
            await this.v2Store.setItem(key, enriched);
            const readBack = await this.v2Store.getItem(key);
            const verification = verifyMigratedSnapshotList(input, readBack);
            if (!verification.valid) {
                throw new Error(`History v2 verification failed for ${key}: ${verification.errors.join('; ')}`);
            }
            await this.v2Store.setItem(migrationMarkerKey(key), {
                status,
                schemaVersion: HISTORY_SCHEMA_VERSION,
                count: enriched.length,
                migratedAt: this.now(),
            });
            return readBack;
        } catch (error) {
            try { await this.v2Store.removeItem(key); } catch (_) {}
            throw error;
        }
    }

    async setItem(key, value) {
        if (!Array.isArray(value)) throw new TypeError('HistoryRepository values must be snapshot arrays');
        return this.#writeVerified(key, value, 'active');
    }

    async removeItem(key) {
        await this.v2Store.removeItem(key);
        await this.v2Store.setItem(migrationMarkerKey(key), {
            status: 'deleted',
            schemaVersion: HISTORY_SCHEMA_VERSION,
            deletedAt: this.now(),
        });
    }

    async keys() {
        const [legacyKeys, v2Keys] = await Promise.all([
            this.legacyStore.keys(),
            this.v2Store.keys(),
        ]);
        const candidates = new Set([
            ...(legacyKeys ?? []).filter(isDataKey),
            ...(v2Keys ?? []).filter(isDataKey),
        ]);
        const result = [];
        for (const key of candidates) {
            const marker = await this.v2Store.getItem(migrationMarkerKey(key));
            if (marker?.status !== 'deleted') result.push(key);
        }
        return result;
    }

    async clear() {
        const keys = await this.keys();
        for (const key of keys) await this.removeItem(key);
    }
}
