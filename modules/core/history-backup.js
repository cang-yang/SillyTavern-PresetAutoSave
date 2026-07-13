import { enrichSnapshotList, HISTORY_SCHEMA_VERSION } from './history-schema.js';
import { canonicalizePreset } from './preset-schema.js';
import { stableStringify } from './value-utils.js';

export const HISTORY_BACKUP_VERSION = 2;
const KEY_DELIMITER = '::';

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function parseHistoryKey(key) {
    if (typeof key !== 'string') return null;
    const index = key.indexOf(KEY_DELIMITER);
    if (index <= 0 || index === key.length - KEY_DELIMITER.length) return null;
    return {
        apiId: key.slice(0, index),
        presetName: key.slice(index + KEY_DELIMITER.length),
    };
}

function validateSnapshot(snapshot, key, identity, seenIds) {
    if (!isPlainObject(snapshot)) throw new TypeError(`History backup snapshot in ${key} must be an object`);
    if (typeof snapshot.id !== 'string' || snapshot.id.trim() === '') {
        throw new TypeError(`History backup snapshot in ${key} has an invalid id`);
    }
    if (seenIds.has(snapshot.id)) throw new TypeError(`Duplicate snapshot id: ${snapshot.id}`);
    if (!Number.isFinite(snapshot.timestamp)) {
        throw new TypeError(`History backup snapshot ${snapshot.id} has an invalid timestamp`);
    }
    if (!isPlainObject(snapshot.preset)) {
        throw new TypeError(`History backup snapshot ${snapshot.id} has an invalid preset`);
    }
    if (snapshot.apiId !== undefined && snapshot.apiId !== identity.apiId) {
        throw new TypeError(`History backup snapshot ${snapshot.id} apiId does not match key ${key}`);
    }
    if (snapshot.presetName !== undefined && snapshot.presetName !== identity.presetName) {
        throw new TypeError(`History backup snapshot ${snapshot.id} presetName does not match key ${key}`);
    }
    seenIds.add(snapshot.id);
    const sanitized = structuredClone(snapshot);
    const { canonical } = canonicalizePreset(sanitized.preset, { apiId: identity.apiId });
    sanitized.preset = canonical;
    return {
        ...sanitized,
        apiId: identity.apiId,
        presetName: identity.presetName,
    };
}

function sanitizeBackupData(data) {
    const sanitized = {};
    const seenIds = new Set();
    for (const [key, list] of Object.entries(data)) {
        const identity = parseHistoryKey(key);
        if (!identity) throw new TypeError(`Invalid history backup key: ${key}`);
        if (!Array.isArray(list)) throw new TypeError(`History backup value for ${key} must be an array`);
        sanitized[key] = list.map(snapshot => validateSnapshot(snapshot, key, identity, seenIds));
    }
    return sanitized;
}

function trimListWithPinned(list, max) {
    if (list.length <= max) return list;
    const pinned = list.filter(snapshot => snapshot?.pinned);
    const unpinned = list.filter(snapshot => !snapshot?.pinned);
    const keepUnpinned = Math.max(1, max - pinned.length);
    return [...pinned, ...unpinned.slice(0, keepUnpinned)]
        .sort((left, right) => right.timestamp - left.timestamp);
}

function normalizeList(list, max = Number.POSITIVE_INFINITY) {
    const ordered = [...list].sort((left, right) => right.timestamp - left.timestamp);
    return enrichSnapshotList(trimListWithPinned(ordered, max));
}

function snapshotIdentityContent(snapshot) {
    return stableStringify({
        apiId: snapshot?.apiId ?? '',
        presetName: snapshot?.presetName ?? '',
        timestamp: snapshot?.timestamp ?? 0,
        trigger: snapshot?.cause?.trigger ?? snapshot?.trigger ?? 'unknown',
        canonicalHash: snapshot?.canonicalHash ?? snapshot?.hash ?? '',
        preset: snapshot?.preset ?? null,
    });
}

export function createHistoryBackup(data, diagnostics = {}, now = () => Date.now()) {
    if (!isPlainObject(data)) throw new TypeError('History backup data must be an object');
    return {
        version: HISTORY_BACKUP_VERSION,
        schemaVersion: HISTORY_SCHEMA_VERSION,
        source: 'PresetAutoSave',
        exportedAt: now(),
        repository: structuredClone(diagnostics ?? {}),
        data: sanitizeBackupData(data),
    };
}

export function validateHistoryBackup(payload) {
    if (!isPlainObject(payload)) throw new TypeError('Invalid history backup payload');
    const sourceVersion = payload.version === undefined ? 1 : payload.version;
    if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > HISTORY_BACKUP_VERSION) {
        throw new TypeError(`Unsupported history backup version: ${String(sourceVersion)}`);
    }
    if (!isPlainObject(payload.data)) throw new TypeError('History backup data must be an object');

    const data = new Map();
    const seenIds = new Set();
    for (const [key, list] of Object.entries(payload.data)) {
        const identity = parseHistoryKey(key);
        if (!identity) throw new TypeError(`Invalid history backup key: ${key}`);
        if (!Array.isArray(list)) throw new TypeError(`History backup value for ${key} must be an array`);
        const validated = list.map(snapshot => validateSnapshot(snapshot, key, identity, seenIds));
        data.set(key, normalizeList(validated));
    }

    return { sourceVersion, data };
}

export function buildHistoryImportPlan(payload, existingByKey = new Map(), { mode = 'merge', max = 50 } = {}) {
    if (mode !== 'merge' && mode !== 'replace') throw new TypeError(`Invalid history import mode: ${mode}`);
    if (!Number.isInteger(max) || max < 1) throw new TypeError(`Invalid history limit: ${max}`);
    if (!(existingByKey instanceof Map)) throw new TypeError('Existing history image must be a Map');

    const validated = validateHistoryBackup(payload);
    const data = mode === 'replace'
        ? new Map()
        : new Map([...existingByKey].map(([key, list]) => [key, structuredClone(list)]));
    let imported = 0;

    for (const [key, incoming] of validated.data) {
        const existing = mode === 'merge' && Array.isArray(data.get(key)) ? data.get(key) : [];
        const existingIds = new Set(existing.map(snapshot => snapshot?.id).filter(Boolean));
        const existingById = new Map(existing.map(snapshot => [snapshot?.id, snapshot]));
        for (const snapshot of incoming) {
            const current = existingById.get(snapshot.id);
            if (current && snapshotIdentityContent(current) !== snapshotIdentityContent(snapshot)) {
                throw new TypeError(`Conflicting snapshot id ${snapshot.id} in ${key}`);
            }
        }
        const incomingById = new Map(incoming.map(snapshot => [snapshot.id, snapshot]));
        const merged = mode === 'merge'
            ? [...existing, ...incoming.filter(snapshot => !existingIds.has(snapshot.id))]
            : incoming;
        const finalList = normalizeList(merged, max);
        data.set(key, finalList);

        imported += finalList.filter(snapshot => {
            if (!incomingById.has(snapshot.id)) return false;
            return mode === 'replace' || !existingIds.has(snapshot.id);
        }).length;
    }

    return { mode, sourceVersion: validated.sourceVersion, data, imported };
}

export async function captureHistoryImage(repository) {
    if (!repository || typeof repository.keys !== 'function' || typeof repository.getItem !== 'function') {
        throw new TypeError('History repository does not support image capture');
    }
    const keys = await repository.keys();
    const values = await Promise.all(keys.map(key => repository.getItem(key)));
    const image = new Map();
    for (let index = 0; index < keys.length; index++) {
        if (Array.isArray(values[index])) image.set(keys[index], structuredClone(values[index]));
    }
    return image;
}

async function writeHistoryImage(repository, image) {
    const currentKeys = await repository.keys();
    for (const key of currentKeys) {
        if (!image.has(key)) await repository.removeItem(key);
    }
    for (const [key, list] of image) await repository.setItem(key, structuredClone(list));
}

export async function applyHistoryImportPlan(repository, plan, backup = null) {
    if (!(plan?.data instanceof Map)) throw new TypeError('Invalid history import plan');
    const original = backup instanceof Map ? structuredClone(backup) : await captureHistoryImage(repository);
    try {
        await writeHistoryImage(repository, plan.data);
        return plan.imported;
    } catch (importError) {
        try {
            const partialKeys = await repository.keys();
            for (const key of partialKeys) await repository.removeItem(key);
            await writeHistoryImage(repository, original);
        } catch (rollbackError) {
            throw new AggregateError(
                [importError, rollbackError],
                'History import failed and rollback could not be completed',
            );
        }
        throw new Error(`History import failed and was rolled back: ${importError.message}`, { cause: importError });
    }
}
