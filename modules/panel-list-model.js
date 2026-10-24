import { getSettings } from './settings.js';
import { getCurrentApiId, getSelectedPresetName } from './compatibility.js';
import { groupNamesBySeries, buildNestedGroupTree } from './preset-grouping.js';
import { indexPresetMembership } from './core/group-projection.js';
import { projectHistoryGroups } from './core/history-group-projection.js';
import { listAllPresetsIncludingDetached } from './preset-takeover.js';
import { logger } from './logger.js';

export function presetKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

export function parsePresetKey(key) {
    const index = key.indexOf('::');
    if (index < 0) return { apiId: '', presetName: key };
    return { apiId: key.slice(0, index), presetName: key.slice(index + 2) };
}

export function resolvePanelSeriesProjection(snapshots, panelCtx, cachedGroups = null) {
    const settings = getSettings();
    const apiId = getCurrentApiId() || 'openai';
    let nativePresets = [];
    try {
        nativePresets = listAllPresetsIncludingDetached(apiId) || [];
    } catch (error) {
        logger.debug('Panel native inventory failed:', error);
    }
    const state = panelCtx.state();
    const currentKey = groupNamesBySeries(
        [getSelectedPresetName()].filter(Boolean), settings.groupingManualOverrides,
    )[0]?.canonicalKey;
    const search = (state.search || '').toLowerCase();
    const groups = projectHistoryGroups({
        snapshots, apiId, nativePresets,
        archives: panelCtx.archivedCache?.() || [],
        overrides: settings.groupingManualOverrides,
        aliases: settings.groupingSeriesAliases,
        hideEmpty: ['pinned', 'today', 'week'].includes(state.filter),
        cachedGroups,
        includeVersion: (version, group) => (
            (state.filter !== 'current' || group.canonicalKey === currentKey)
            && (!search || version.snapshotCount > 0 || [
                version.presetName, group.automaticName, group.displayName,
            ].some(value => (value || '').toLowerCase().includes(search)))
        ),
    });
    const tree = settings.nestingEnabled && Object.keys(settings.groupingTree || {}).length
        ? buildNestedGroupTree(
            [...groups.values()].flatMap(group => group.versions.map(version => version.presetName)),
            settings.groupingManualOverrides, settings.groupingTree,
            settings.nestingMaxDepth, settings.groupingSeriesAliases,
        ) : null;
    const keepVisible = node => {
        node.children = node.children.filter(keepVisible);
        return node.items.length > 0 || node.children.length > 0;
    };
    return { groups, tree: tree?.filter(keepVisible) || null };
}

export function resolveSeriesExpansion(snapshots, panelCtx, { currentOnly = false } = {}) {
    const { groups, tree } = resolvePanelSeriesProjection(snapshots, panelCtx);
    const apiId = getCurrentApiId();
    const presetName = getSelectedPresetName();
    const seriesKeys = new Set();
    const versionKeys = new Set();
    const currentGroups = new Set();
    for (const [key, group] of groups) {
        if (currentOnly && !group.versions.some(version => version.apiId === apiId && version.presetName === presetName)) continue;
        seriesKeys.add(key);
        currentGroups.add(key);
        for (const version of group.versions) versionKeys.add(presetKey(version.apiId, version.presetName));
    }
    const visit = node => {
        const children = (node.children || []).map(visit);
        const containsCurrent = currentGroups.has(node.key) || node.items?.includes(presetName)
            || children.some(Boolean);
        if (!currentOnly || containsCurrent) seriesKeys.add(node.key);
        return containsCurrent;
    };
    tree?.forEach(visit);
    return { seriesKeys, versionKeys };
}

function startOfToday() {
    const date = new Date();
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfWeek() {
    const date = new Date();
    const dayOfWeek = date.getDay() || 7;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        - (dayOfWeek - 1) * 86400000;
}

export function groupSnapshotsByPreset(snapshots) {
    const groups = {};
    for (const snapshot of snapshots) {
        const key = presetKey(snapshot.apiId, snapshot.presetName);
        if (!groups[key]) groups[key] = [];
        groups[key].push(snapshot);
    }
    for (const key of Object.keys(groups)) {
        groups[key].sort((left, right) => right.timestamp - left.timestamp);
    }
    return groups;
}

export function applyFiltersAndSearch(snapshots, panelCtx) {
    const state = panelCtx.state();
    let result = [...snapshots];
    const name = getSelectedPresetName();
    const api = getCurrentApiId();
    const settings = getSettings();
    const groups = groupNamesBySeries(
        [...snapshots.map(snapshot => snapshot.presetName), name].filter(Boolean),
        settings.groupingManualOverrides,
        settings.groupingSeriesAliases,
    );
    const membership = indexPresetMembership(groups);

    if (state.filter === 'current') {
        if (state.viewMode === 'series' && name) {
            const currentKey = membership.get(name)?.canonicalKey;
            result = result.filter(snapshot => snapshot.apiId === api
                && membership.get(snapshot.presetName)?.canonicalKey === currentKey);
        } else {
            result = result.filter(snapshot => snapshot.presetName === name && snapshot.apiId === api);
        }
    } else if (state.filter === 'pinned') {
        result = result.filter(snapshot => !!snapshot.pinned);
    } else if (state.filter === 'today') {
        const start = startOfToday();
        result = result.filter(snapshot => snapshot.timestamp >= start);
    } else if (state.filter === 'week') {
        const start = startOfWeek();
        result = result.filter(snapshot => snapshot.timestamp >= start);
    }

    if (state.search) {
        const query = state.search.toLowerCase();
        result = result.filter(snapshot => {
            if ((snapshot.presetName || '').toLowerCase().includes(query)) return true;
            if ((snapshot.name || '').toLowerCase().includes(query)) return true;
            const group = membership.get(snapshot.presetName);
            return [group?.automaticName, group?.displayName]
                .some(label => (label || '').toLowerCase().includes(query));
        });
    }

    return result;
}
