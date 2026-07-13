import { createChangeSet } from './change-set.js';

export const HISTORY_SCHEMA_VERSION = 2;

function compactChangeSet(parentPreset, preset) {
    if (!parentPreset) {
        return {
            meaningful: false,
            changedPaths: [],
            counts: { added: 0, removed: 0, modified: 0 },
        };
    }
    const changeSet = createChangeSet(parentPreset, preset);
    return {
        meaningful: changeSet.meaningful,
        changedPaths: changeSet.changed.map(item => item.path),
        counts: { ...changeSet.counts },
    };
}

export function enrichSnapshotList(list) {
    if (!Array.isArray(list)) return [];

    return list.map((snapshot, index) => {
        const parent = list[index + 1] ?? null;
        const id = snapshot?.id ?? '';
        return {
            ...structuredClone(snapshot),
            schemaVersion: HISTORY_SCHEMA_VERSION,
            canonicalHash: snapshot?.hash ?? snapshot?.canonicalHash ?? '',
            changeSet: compactChangeSet(parent?.preset, snapshot?.preset),
            cause: { ...(snapshot?.cause ?? {}), trigger: snapshot?.trigger ?? snapshot?.cause?.trigger ?? 'unknown' },
            transactionId: `tx:${id}:${snapshot?.timestamp ?? 0}`,
            parentSnapshotId: parent?.id ?? null,
            saveStatus: snapshot?.saveStatus ?? 'committed',
        };
    });
}

export function verifyMigratedSnapshotList(legacy, migrated) {
    const errors = [];
    if (!Array.isArray(legacy) || !Array.isArray(migrated)) {
        return { valid: false, errors: ['snapshot list is not an array'] };
    }
    if (legacy.length !== migrated.length) {
        errors.push(`count mismatch: ${legacy.length} != ${migrated.length}`);
    }

    const count = Math.min(legacy.length, migrated.length);
    for (let index = 0; index < count; index++) {
        const before = legacy[index] ?? {};
        const after = migrated[index] ?? {};
        const label = before.id || `index ${index}`;
        if (before.id !== after.id) errors.push(`${label}: id mismatch`);
        if (before.apiId !== after.apiId) errors.push(`${label}: apiId mismatch`);
        if (before.presetName !== after.presetName) errors.push(`${label}: presetName mismatch`);
        if ((before.name ?? '') !== (after.name ?? '')) errors.push(`${label}: name mismatch`);
        if (Boolean(before.pinned) !== Boolean(after.pinned)) errors.push(`${label}: pinned mismatch`);
        if ((before.hash ?? '') !== (after.canonicalHash ?? after.hash ?? '')) errors.push(`${label}: hash mismatch`);
        const expectedParentId = legacy[index + 1]?.id ?? null;
        if ((after.parentSnapshotId ?? null) !== expectedParentId) {
            errors.push(`${label}: parentSnapshotId mismatch`);
        }
        if (after.schemaVersion !== HISTORY_SCHEMA_VERSION) errors.push(`${label}: schema version mismatch`);
    }
    return { valid: errors.length === 0, errors };
}
