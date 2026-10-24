import { groupNamesBySeries } from '../preset-grouping.js';

/**
 * Join history and host inventories without changing target ownership.
 * The optional cache contains summaries only; projected arrays are fresh so
 * filtering or rendering cannot mutate cached history.
 */
export function projectHistoryGroups({
    snapshots, apiId, nativePresets = [], archives = [],
    overrides = {}, aliases = {}, hideEmpty = false, cachedGroups = null,
    includeVersion = () => true,
}) {
    const targets = new Map();
    const targetFor = (targetApi, presetName) => {
        if (targetApi !== apiId || typeof presetName !== 'string' || !presetName) return null;
        if (!targets.has(presetName)) {
            targets.set(presetName, {
                apiId, presetName, snapshots: [], native: false,
                archived: false, archivedAt: 0,
            });
        }
        return targets.get(presetName);
    };
    const filtered = (snapshots || []).filter(snapshot => snapshot?.apiId === apiId);
    const wantedIds = new Set(filtered.map(snapshot => snapshot.id));
    if (cachedGroups?.size) {
        for (const group of cachedGroups.values()) {
            for (const version of group.versions) {
                const matching = (version.snapshots || []).filter(snapshot => wantedIds.has(snapshot.id));
                if (!matching.length) continue;
                const target = targetFor(version.apiId, version.presetName);
                if (target) target.snapshots.push(...matching);
            }
        }
    } else {
        for (const snapshot of filtered) {
            targetFor(snapshot.apiId, snapshot.presetName)?.snapshots.push(snapshot);
        }
    }
    for (const entry of nativePresets) {
        const target = targetFor(entry.apiId || apiId, entry.presetName);
        if (target) target.native = true;
    }
    for (const entry of archives) {
        const target = targetFor(entry.apiId || apiId, entry.presetName);
        if (target) {
            target.archived = true;
            target.archivedAt = entry.archivedAt || 0;
        }
    }

    const result = new Map();
    const groups = groupNamesBySeries([...targets.keys()], overrides, aliases);
    for (const group of groups) {
        const versions = group.items.map(item => {
            const target = targets.get(item.presetName);
            const records = [...target.snapshots].sort((a, b) => b.timestamp - a.timestamp);
            return {
                ...item, apiId, snapshots: records,
                available: target.native,
                archived: target.archived && !target.native,
                snapshotCount: records.length,
                totalSize: records.reduce((sum, snapshot) => sum + (snapshot.size || 0), 0),
                latestTime: Math.max(target.archivedAt, ...records.map(snapshot => snapshot.timestamp || 0)),
            };
        }).filter(version => (!hideEmpty || version.snapshotCount > 0) && includeVersion(version, group));
        if (!versions.length) continue;
        result.set(group.canonicalKey, {
            ...group, versions,
            versionCount: versions.length,
            snapshotCount: versions.reduce((sum, version) => sum + version.snapshotCount, 0),
            totalSize: versions.reduce((sum, version) => sum + version.totalSize, 0),
            latestTime: Math.max(...versions.map(version => version.latestTime)),
        });
    }
    return result;
}
