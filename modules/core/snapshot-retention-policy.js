const COALESCIBLE_TRIGGERS = new Set(['auto']);

/**
 * Only bursty automatic observations may replace an entry inside the merge
 * window. Manual, switch-guard, and restore snapshots are explicit recovery
 * points and must always retain their own stable ID and content.
 */
export function canCoalesceSnapshotTrigger(trigger) {
    return COALESCIBLE_TRIGGERS.has(trigger);
}
