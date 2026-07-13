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
        this.migrationStats = { attempted: 0, succeeded: 0, failed: 0 };
    }

    async getItem(key) {
        const marker = await this.v2Store.getItem(migrationMarkerKey(key));
        if (marker?.status === 'deleted') return null;

        const current = await this.v2Store.getItem(key);
        if (Array.isArray(current)) return current;

        const legacy = await this.legacyStore.getItem(key);
        if (!Array.isArray(legacy)) return null;
        return this.#migrate(key, legacy);
    }

    async #migrate(key, legacy) {
        if (this.migrations.has(key)) return this.migrations.get(key);
        const operation = (async () => {
            this.migrationStats.attempted++;
            try {
                const migrated = await this.#writeVerified(key, legacy, 'migrated');
                this.migrationStats.succeeded++;
                return migrated;
            } catch (error) {
                this.migrationStats.failed++;
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
        const markerKey = migrationMarkerKey(key);
        const [previousData, previousMarker] = await Promise.all([
            this.v2Store.getItem(key),
            this.v2Store.getItem(markerKey),
        ]);
        try {
            await this.v2Store.setItem(key, enriched);
            const readBack = await this.v2Store.getItem(key);
            const verification = verifyMigratedSnapshotList(input, readBack);
            if (!verification.valid) {
                throw new Error(`History v2 verification failed for ${key}: ${verification.errors.join('; ')}`);
            }
            await this.v2Store.setItem(markerKey, {
                status,
                schemaVersion: HISTORY_SCHEMA_VERSION,
                count: enriched.length,
                migratedAt: this.now(),
            });
            return readBack;
        } catch (error) {
            const rollbackErrors = [];
            for (const [rollbackKey, previousValue] of [
                [key, previousData],
                [markerKey, previousMarker],
            ]) {
                try {
                    if (previousValue === null || previousValue === undefined) {
                        await this.v2Store.removeItem(rollbackKey);
                    } else {
                        await this.v2Store.setItem(rollbackKey, previousValue);
                    }
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    `History write failed and rollback could not be completed for ${key}`,
                );
            }
            throw error;
        }
    }

    async setItem(key, value) {
        if (!Array.isArray(value)) throw new TypeError('HistoryRepository values must be snapshot arrays');
        return this.#writeVerified(key, value, 'active');
    }

    async removeItem(key) {
        const markerKey = migrationMarkerKey(key);
        const tombstone = {
            status: 'deleted',
            schemaVersion: HISTORY_SCHEMA_VERSION,
            deletedAt: this.now(),
        };
        // Publish and verify the tombstone first. If the following physical
        // cleanup fails, readers must still never fall back to legacy data.
        await this.v2Store.setItem(markerKey, tombstone);
        const storedMarker = await this.v2Store.getItem(markerKey);
        if (storedMarker?.status !== 'deleted') {
            throw new Error(`History v2 tombstone verification failed for ${key}`);
        }
        await this.v2Store.removeItem(key);
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

    async getDiagnostics() {
        const diagnostics = {
            schemaVersion: HISTORY_SCHEMA_VERSION,
            legacyKeyCount: 0,
            v2KeyCount: 0,
            markers: { active: 0, migrated: 0, deleted: 0, other: 0 },
            migration: { ...this.migrationStats },
            diagnosticErrors: 0,
        };

        let legacyKeys = [];
        let v2Keys = [];
        try { legacyKeys = (await this.legacyStore.keys()) ?? []; } catch (_) { diagnostics.diagnosticErrors++; }
        try { v2Keys = (await this.v2Store.keys()) ?? []; } catch (_) { diagnostics.diagnosticErrors++; }
        diagnostics.legacyKeyCount = legacyKeys.filter(isDataKey).length;
        diagnostics.v2KeyCount = v2Keys.filter(isDataKey).length;

        for (const key of v2Keys.filter(key => typeof key === 'string' && key.startsWith(META_PREFIX))) {
            try {
                const marker = await this.v2Store.getItem(key);
                const status = marker?.status;
                if (Object.hasOwn(diagnostics.markers, status)) diagnostics.markers[status]++;
                else diagnostics.markers.other++;
            } catch (_) {
                diagnostics.diagnosticErrors++;
            }
        }
        return diagnostics;
    }
}
