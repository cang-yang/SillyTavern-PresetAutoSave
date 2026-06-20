import { isHistoryOwnedPath } from './preset-schema.js';

function uniquePaths(paths) {
    if (!Array.isArray(paths)) return [];
    return [...new Set(paths.filter(path => typeof path === 'string' && path.trim() !== ''))];
}

function partitionPaths(paths, apiId) {
    const unique = uniquePaths(paths);
    return {
        visible: unique.filter(path => isHistoryOwnedPath(path, { apiId })),
        ignored: unique.filter(path => !isHistoryOwnedPath(path, { apiId })),
    };
}

function sanitizeSummary(summary, apiId) {
    if (!summary || typeof summary !== 'object') return null;
    const projected = structuredClone(summary);
    const ignored = new Set(uniquePaths(projected.ignoredPaths));

    if (Array.isArray(projected.sections)) {
        projected.sections = projected.sections.flatMap(section => {
            if (section?.kind !== 'field' || !Array.isArray(section.items)) return [section];
            const items = section.items.filter(item => {
                const owned = isHistoryOwnedPath(item?.key, { apiId });
                if (!owned && item?.key) ignored.add(item.key);
                return owned;
            });
            return items.length > 0 ? [{ ...section, items }] : [];
        });
    }

    if (Array.isArray(projected.details)) {
        projected.details = projected.details.filter(item => {
            const owned = isHistoryOwnedPath(item?.key, { apiId });
            if (!owned && item?.key) ignored.add(item.key);
            return owned;
        });
    }

    const hadRawPaths = Array.isArray(projected.rawChangedPaths);
    const rawPartition = partitionPaths(projected.rawChangedPaths, apiId);
    for (const path of rawPartition.ignored) ignored.add(path);
    if (hadRawPaths || rawPartition.visible.length > 0) projected.rawChangedPaths = rawPartition.visible;
    if (ignored.size > 0 || Array.isArray(projected.ignoredPaths)) projected.ignoredPaths = [...ignored];

    const hasVisibleSections = projected.sections?.some(section => section?.items?.length > 0) ?? false;
    const hasVisibleDetails = projected.details?.length > 0;
    const hasVisiblePaths = (projected.rawChangedPaths?.length ?? 0) > 0;
    if (!projected.isFirst && !hasVisibleSections && !hasVisibleDetails && !hasVisiblePaths && ignored.size > 0) {
        projected.onlyIgnoredChanges = true;
    }
    return projected;
}

export function getSnapshotDiagnostics(snapshot = {}) {
    const schemaVersion = Number.isInteger(snapshot?.schemaVersion) ? snapshot.schemaVersion : 1;
    const apiId = snapshot?.apiId ?? 'openai';
    const changedPaths = partitionPaths(
        snapshot?.changeSet?.changedPaths ?? snapshot?.summary?.rawChangedPaths,
        apiId,
    ).visible;
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
    const apiId = snapshot?.apiId ?? 'openai';
    const summary = sanitizeSummary(snapshot?.summary, apiId);
    const changedPaths = getSnapshotDiagnostics(snapshot).changedPaths;
    const ignoredPaths = partitionPaths(
        snapshot?.changeSet?.changedPaths ?? snapshot?.summary?.rawChangedPaths,
        apiId,
    ).ignored;
    if (changedPaths.length === 0) {
        if (!summary && ignoredPaths.length > 0) {
            return {
                isFirst: false,
                sections: [],
                rawChangedPaths: [],
                ignoredPaths,
                onlyIgnoredChanges: true,
            };
        }
        if (summary) {
            if (ignoredPaths.length > 0 && !summary.isFirst) summary.onlyIgnoredChanges = true;
            const combinedIgnored = [...new Set([...(summary.ignoredPaths ?? []), ...ignoredPaths])];
            if (combinedIgnored.length > 0 || Array.isArray(summary.ignoredPaths)) {
                summary.ignoredPaths = combinedIgnored;
            }
        }
        return summary;
    }
    if (!summary) return { isFirst: false, sections: [], rawChangedPaths: changedPaths };
    if (!Array.isArray(summary.rawChangedPaths) || summary.rawChangedPaths.length === 0) {
        summary.rawChangedPaths = changedPaths;
    }
    return summary;
}
