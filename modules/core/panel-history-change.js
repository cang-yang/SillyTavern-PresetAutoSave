import { projectSnapshotSummary } from './snapshot-summary.js';

const INCREMENTAL_CHANGE_TYPES = new Set(['snapshot-added', 'snapshot-updated']);

export function applyPanelHistoryChange(currentSummaries, change) {
    const current = Array.isArray(currentSummaries) ? currentSummaries : [];
    if (!change || !INCREMENTAL_CHANGE_TYPES.has(change.type)) {
        return { handled: false, summaries: currentSummaries };
    }

    let summary;
    try {
        summary = projectSnapshotSummary(change.snapshot);
    } catch (_) {
        return { handled: false, summaries: currentSummaries };
    }

    const removedIds = new Set(
        Array.isArray(change.removedIds)
            ? change.removedIds.filter(id => typeof id === 'string' && id)
            : [],
    );
    const next = current.filter(item => item?.id !== summary.id && !removedIds.has(item?.id));
    next.push(summary);
    next.sort((left, right) => {
        const timestampDifference = (right?.timestamp || 0) - (left?.timestamp || 0);
        return timestampDifference || String(left?.id || '').localeCompare(String(right?.id || ''));
    });

    return {
        handled: true,
        summaries: Object.freeze(next),
    };
}
