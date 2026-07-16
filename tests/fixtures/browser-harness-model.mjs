import { buildPerformanceScenario, buildVisualScenario } from './visual-scenarios.mjs';

const FIXED_EPOCH = Date.UTC(2026, 6, 13, 8, 0, 0);
const SNAPSHOT_INTERVAL_MS = 60_000;
export const PERFORMANCE_HISTORY_TARGETS = Object.freeze({
    '1mb': 1 * 1024 * 1024,
    '15mb': 15 * 1024 * 1024,
    '46mb': 46 * 1024 * 1024,
});

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function byteSize(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function buildPerformanceStorageRecords(records, {
    targetBytesPerSnapshot = Math.floor(PERFORMANCE_HISTORY_TARGETS['46mb'] / 500),
} = {}) {
    if (!Array.isArray(records)) throw new TypeError('Performance records must be an array');
    return records.map(record => {
        const copy = clone(record);
        const preset = { ...copy.preset, __pasHarnessPayload: '' };
        const paddingLength = Math.max(0, targetBytesPerSnapshot - byteSize(preset));
        preset.__pasHarnessPayload = 'x'.repeat(paddingLength);
        return {
            ...copy,
            size: byteSize(preset),
            preset,
        };
    });
}

function projectRecords(kind, records) {
    return records.map((record, index) => {
        const preset = clone(record.preset);
        const sequence = String(index + 1).padStart(4, '0');
        return {
            ...clone(record),
            id: `harness-${kind}-${sequence}`,
            timestamp: FIXED_EPOCH - index * SNAPSHOT_INTERVAL_MS,
            size: byteSize(preset),
            hash: `fixture-${kind}-${sequence}`,
            schemaVersion: 2,
            saveStatus: 'committed',
            transactionId: `fixture-tx-${kind}-${sequence}`,
            preset,
        };
    });
}

export function buildHarnessScenario(kind = 'ordinary') {
    if (kind === 'empty') {
        return {
            kind,
            currentApiId: 'openai',
            currentPresetName: '未创建快照的预设',
            records: [],
            overrides: {},
            tree: {},
        };
    }

    const source = kind === 'ordinary'
        ? buildVisualScenario()
        : kind === 'performance'
            ? buildPerformanceScenario()
            : null;

    if (!source) throw new Error(`Unsupported harness scenario: ${kind}`);

    const records = projectRecords(kind, source.records);
    return {
        kind,
        currentApiId: records[0]?.apiId || 'openai',
        currentPresetName: records[0]?.presetName || '',
        records,
        overrides: clone(source.overrides),
        tree: clone(source.tree),
    };
}
