function uniquePaths(paths) {
    if (!Array.isArray(paths)) return [];
    return [...new Set(paths.filter(path => typeof path === 'string' && path.trim() !== ''))];
}

export function getSnapshotDiagnostics(snapshot = {}) {
    const schemaVersion = Number.isInteger(snapshot?.schemaVersion) ? snapshot.schemaVersion : 1;
    const changedPaths = uniquePaths(
        snapshot?.changeSet?.changedPaths ?? snapshot?.summary?.rawChangedPaths,
    );
    return {
        schemaVersion,
        canonicalHash: snapshot?.canonicalHash ?? snapshot?.hash ?? '',
        transactionId: snapshot?.transactionId ?? '',
        parentSnapshotId: snapshot?.parentSnapshotId ?? null,
        saveStatus: snapshot?.saveStatus ?? (schemaVersion >= 2 ? 'committed' : 'legacy'),
        trigger: snapshot?.cause?.trigger ?? snapshot?.trigger ?? 'unknown',
        changedPaths,
    };
}

export function getSnapshotSummary(snapshot = {}) {
    const summary = snapshot?.summary && typeof snapshot.summary === 'object'
        ? structuredClone(snapshot.summary)
        : null;
    const changedPaths = getSnapshotDiagnostics(snapshot).changedPaths;
    if (changedPaths.length === 0) return summary;
    if (!summary) return { isFirst: false, sections: [], rawChangedPaths: changedPaths };
    if (!Array.isArray(summary.rawChangedPaths) || summary.rawChangedPaths.length === 0) {
        summary.rawChangedPaths = changedPaths;
    }
    return summary;
}
