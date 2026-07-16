import { getSnapshotDiagnostics, getSnapshotSummary } from './snapshot-diagnostics.js';

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

function requireIdentity(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('Snapshot summary requires an object with stable identity');
    }
    for (const field of ['id', 'apiId', 'presetName']) {
        if (typeof snapshot[field] !== 'string' || snapshot[field].trim() === '') {
            throw new TypeError(`Snapshot summary requires stable identity field: ${field}`);
        }
    }
    if (!Number.isFinite(snapshot.timestamp)) {
        throw new TypeError('Snapshot summary requires a finite timestamp');
    }
}

export function projectSnapshotSummary(snapshot) {
    requireIdentity(snapshot);
    const diagnostics = getSnapshotDiagnostics(snapshot);
    const displaySummary = getSnapshotSummary(snapshot);
    const trigger = diagnostics.trigger || 'unknown';
    const projected = {
        id: snapshot.id,
        apiId: snapshot.apiId,
        presetName: snapshot.presetName,
        timestamp: snapshot.timestamp,
        size: Number.isFinite(snapshot.size) && snapshot.size >= 0 ? snapshot.size : 0,
        hash: typeof snapshot.hash === 'string' ? snapshot.hash : '',
        canonicalHash: diagnostics.canonicalHash,
        trigger,
        cause: { trigger },
        name: typeof snapshot.name === 'string' ? snapshot.name : '',
        pinned: snapshot.pinned === true,
        schemaVersion: diagnostics.schemaVersion,
        transactionId: diagnostics.transactionId,
        parentSnapshotId: diagnostics.parentSnapshotId,
        saveStatus: diagnostics.saveStatus,
        summary: displaySummary,
        changeSet: { changedPaths: [...diagnostics.changedPaths] },
    };
    return deepFreeze(projected);
}

export function projectSnapshotSummaries(snapshots) {
    if (!Array.isArray(snapshots)) {
        throw new TypeError('Snapshot summary projection requires an array');
    }
    return Object.freeze(snapshots.map(projectSnapshotSummary));
}

export function fingerprintSnapshotSummaries(snapshots) {
    const summaries = projectSnapshotSummaries(snapshots);
    const serialized = JSON.stringify(summaries);
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index++) {
        hash ^= serialized.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${summaries.length}:${hash.toString(16).padStart(8, '0')}`;
}
