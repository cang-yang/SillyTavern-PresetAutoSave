import { buildPerformanceScenario, buildVisualScenario } from './visual-scenarios.mjs';
import {
    addSnapshot,
    clearAll,
    exportAll,
    importAll,
    renameSnapshot,
    togglePinSnapshot,
} from '../../modules/history-store.js';
import { batchUpdate, getSettings } from '../../modules/settings.js';
import { normalizeSeriesKey } from '../../modules/preset-grouping.js';
import { getCurrentApiId } from '../../modules/compatibility.js';

let backup = null;

function normalizedTree(tree) {
    return Object.fromEntries(Object.entries(tree).map(([child, parent]) => [
        normalizeSeriesKey(child),
        normalizeSeriesKey(parent),
    ]));
}

async function preserveCurrentState() {
    if (backup) return;
    backup = {
        history: await exportAll(),
        settings: structuredClone(getSettings()),
    };
}

export async function installBrowserScenario(kind = 'visual') {
    await preserveCurrentState();
    const scenario = kind === 'performance'
        ? buildPerformanceScenario()
        : buildVisualScenario();
    const activeApiId = getCurrentApiId() || scenario.records[0]?.apiId || 'openai';

    await clearAll();
    batchUpdate({
        groupingEnabled: true,
        groupingFirstScanDone: true,
        groupingDefaultExpand: kind === 'performance' ? 'none' : 'all',
        groupingManualOverrides: scenario.overrides,
        nestingEnabled: kind === 'visual',
        nestingMaxDepth: 3,
        groupingTree: normalizedTree(scenario.tree),
        mergeWindowSec: 0,
        maxHistoryPerPreset: 500,
        takeoverEnabled: false,
        autoSeedOnTakeover: false,
    });

    const created = [];
    for (const record of scenario.records) {
        const snapshot = await addSnapshot(record.presetName, activeApiId, record.preset, record.trigger);
        if (!snapshot) throw new Error(`Fixture snapshot was rejected: ${record.presetName}`);
        if (record.label) await renameSnapshot(snapshot.id, record.label);
        if (record.pinned) await togglePinSnapshot(snapshot.id, true);
        created.push(snapshot.id);
    }
    return { kind, apiId: activeApiId, snapshotCount: created.length, presetCount: new Set(scenario.records.map(item => item.presetName)).size };
}

export async function restoreBrowserScenario() {
    if (!backup) return { restored: false };
    const saved = backup;
    backup = null;
    batchUpdate(saved.settings);
    await importAll(saved.history, 'replace');
    return { restored: true };
}

if (typeof window !== 'undefined') {
    window.__PAS_BROWSER_SCENARIO__ = { installBrowserScenario, restoreBrowserScenario };
}
