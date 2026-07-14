import { getSettings } from './settings.js';
import { getCurrentApiId, getSelectedPresetName } from './compatibility.js';
import { parsePresetName } from './preset-grouping.js';

export function presetKey(apiId, presetName) {
    return `${apiId}::${presetName}`;
}

export function parsePresetKey(key) {
    const index = key.indexOf('::');
    if (index < 0) return { apiId: '', presetName: key };
    return { apiId: key.slice(0, index), presetName: key.slice(index + 2) };
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

    if (state.filter === 'current') {
        const name = getSelectedPresetName();
        const api = getCurrentApiId();
        if (state.viewMode === 'series' && name) {
            const settings = getSettings();
            const overrides = settings.groupingManualOverrides;
            const currentInfo = (() => {
                try {
                    return parsePresetName(name);
                } catch (_) {
                    return { series: name };
                }
            })();
            let currentSeries = currentInfo.series || name;
            if (overrides && Object.hasOwn(overrides, name) && overrides[name]) {
                currentSeries = overrides[name];
            }
            result = result.filter(snapshot => {
                if (snapshot.apiId !== api) return false;
                const override = (overrides && overrides[snapshot.presetName]) || null;
                if (override) return override === currentSeries;
                try {
                    const parsed = parsePresetName(snapshot.presetName || '');
                    return (parsed.series || snapshot.presetName) === currentSeries;
                } catch (_) {
                    return snapshot.presetName === name;
                }
            });
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
            try {
                const parsed = parsePresetName(snapshot.presetName || '');
                return (parsed.series || '').toLowerCase().includes(query);
            } catch (_) {
                return false;
            }
        });
    }

    return result;
}
