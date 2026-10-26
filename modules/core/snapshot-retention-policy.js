const COALESCIBLE_TRIGGERS = new Set(['auto']);

/**
 * Only bursty automatic observations may replace an entry inside the merge
 * window. Manual, switch-guard, and restore snapshots are explicit recovery
 * points and must always retain their own stable ID and content.
 */
export function canCoalesceSnapshotTrigger(trigger) {
    return COALESCIBLE_TRIGGERS.has(trigger);
}

export function isProtectedSnapshot(snapshot) {
    return Boolean(snapshot?.pinned) || !isSnapshotCommitted(snapshot);
}

export function isSnapshotCommitted(snapshot) {
    return snapshot != null
        && (!Object.hasOwn(snapshot, 'saveStatus') || snapshot.saveStatus === 'committed');
}

/** Input is newest first. Preserve recovery records plus at least one normal entry. */
export function retainSnapshotList(list, max) {
    if (list.length <= max) return [...list];
    const protectedRecords = list.filter(isProtectedSnapshot);
    const ordinary = list.filter(snapshot => !isProtectedSnapshot(snapshot));
    return [...protectedRecords, ...ordinary.slice(0, Math.max(1, max - protectedRecords.length))]
        .sort((left, right) => right.timestamp - left.timestamp);
}
