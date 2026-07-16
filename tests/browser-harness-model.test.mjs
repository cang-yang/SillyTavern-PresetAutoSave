import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildHarnessScenario,
    buildPerformanceStorageRecords,
    PERFORMANCE_HISTORY_TARGETS,
} from './fixtures/browser-harness-model.mjs';

test('ordinary harness scenario is deterministic and exercises hostile display text', () => {
    const first = buildHarnessScenario('ordinary');
    const second = buildHarnessScenario('ordinary');

    assert.deepEqual(first, second);
    assert.equal(first.kind, 'ordinary');
    assert.equal(first.records.length, 45);
    assert.equal(first.currentApiId, 'openai');
    assert.equal(first.currentPresetName, first.records[0].presetName);
    assert.ok(first.records.some(record => /[\u{1F300}-\u{1FAFF}]/u.test(record.presetName)));
    assert.ok(first.records.some(record => record.presetName.includes('<script>')));
    assert.ok(first.records.some(record => record.presetName.length > 60));
    assert.ok(first.records.every((record, index) => record.id === `harness-ordinary-${String(index + 1).padStart(4, '0')}`));
    assert.ok(first.records.every((record, index, records) => index === 0 || record.timestamp < records[index - 1].timestamp));
    assert.ok(first.records.every(record => Number.isInteger(record.size) && record.size > 0));
    assert.ok(first.records.every(record => record.schemaVersion === 2 && record.saveStatus === 'committed'));
});

test('harness scenarios do not share mutable preset data', () => {
    const first = buildHarnessScenario('ordinary');
    first.records[0].preset.temperature = 99;
    first.overrides[first.records[0].presetName] = 'changed';

    const second = buildHarnessScenario('ordinary');
    assert.notEqual(second.records[0].preset.temperature, 99);
    assert.notEqual(second.overrides[second.records[0].presetName], 'changed');
});

test('empty and performance scenarios provide exact boundary cardinalities', () => {
    const empty = buildHarnessScenario('empty');
    const performance = buildHarnessScenario('performance');

    assert.equal(empty.records.length, 0);
    assert.equal(empty.currentPresetName, '未创建快照的预设');
    assert.equal(performance.records.length, 500);
    assert.equal(new Set(performance.records.map(record => record.presetName)).size, 25);
    assert.equal(performance.records.at(-1).id, 'harness-performance-0500');
});

test('performance storage fixtures represent 1, 15, and 46 MiB IndexedDB histories', () => {
    const performance = buildHarnessScenario('performance');
    for (const [label, targetBytes] of Object.entries(PERFORMANCE_HISTORY_TARGETS)) {
        const records = buildPerformanceStorageRecords(performance.records, {
            targetBytesPerSnapshot: Math.floor(targetBytes / performance.records.length),
        });
        const totalBytes = records.reduce((sum, record) => sum + record.size, 0);

        assert.equal(records.length, 500);
        assert.ok(Math.abs(totalBytes - targetBytes) < performance.records.length, label);
        assert.ok(records.every(record => record.preset.__pasHarnessPayload.length > 0), label);
    }
});

test('unsupported harness scenarios fail closed', () => {
    assert.throws(() => buildHarnessScenario('unknown'), /Unsupported harness scenario/);
});
