import test from 'node:test';
import assert from 'node:assert/strict';

import { createSnapshotWriteback } from '../modules/core/snapshot-writeback.js';

function snapshot(apiId, presetName, timestamp, value = timestamp) {
    return { apiId, presetName, timestamp, preset: { value } };
}

function createHarness({ snapshots = [], managers = {}, savePreset = async () => {} } = {}) {
    const logs = [];
    const writeBack = createSnapshotWriteback({
        loadSnapshots: async () => snapshots,
        getPresetManager: apiId => managers[apiId] || null,
        savePreset,
        parsePresetName: name => ({ series: name.replace(/ v\d+$/, '') }),
        logger: {
            debug: (...args) => logs.push(['debug', ...args]),
            warn: (...args) => logs.push(['warn', ...args]),
        },
    });
    return { writeBack, logs };
}

test('writeback selects the latest valid snapshot for each stable preset target', async () => {
    const writes = [];
    const manager = { findPreset: () => ({}) };
    const { writeBack } = createHarness({
        snapshots: [
            snapshot('openai', 'Fox v1', 10, 'old'),
            snapshot('openai', 'Fox v1', 20, 'latest'),
            snapshot('claude', 'Fox v1', 15, 'other-api'),
            { apiId: 'openai', presetName: '', timestamp: 30, preset: {} },
        ],
        managers: { openai: manager, claude: manager },
        savePreset: async (name, preset, options) => writes.push({ name, preset, options }),
    });

    assert.deepEqual(await writeBack(), { written: 2, skipped: 0, failed: 1 });
    assert.deepEqual(writes.map(item => [item.options.apiId, item.name, item.preset.value]), [
        ['openai', 'Fox v1', 'latest'],
        ['claude', 'Fox v1', 'other-api'],
    ]);
});

test('ghost filtering is isolated by API and does not detach another API history target', async () => {
    const writes = [];
    const missingManager = {
        getPresetList: () => ({ preset_names: [] }),
        findPreset: () => undefined,
    };
    const { writeBack } = createHarness({
        snapshots: [
            snapshot('openai', 'Fox', 20),
            snapshot('openai', 'Fox v2', 19),
            snapshot('claude', 'Fox', 18),
        ],
        managers: { openai: missingManager, claude: missingManager },
        savePreset: async (name, _preset, options) => writes.push(`${options.apiId}:${name}`),
    });

    assert.deepEqual(
        await writeBack({ skipExisting: true, filterGhosts: true }),
        { written: 2, skipped: 1, failed: 0 },
    );
    assert.deepEqual(writes, ['openai:Fox v2', 'claude:Fox']);
});

test('skip-existing recovery fails closed when host existence cannot be verified', async () => {
    const { writeBack } = createHarness({
        snapshots: [snapshot('openai', 'Fox', 20)],
        managers: { openai: {} },
    });

    assert.deepEqual(
        await writeBack({ skipExisting: true }),
        { written: 0, skipped: 0, failed: 1 },
    );
});

test('snapshot loading failure returns a diagnosable partial result', async () => {
    const writeBack = createSnapshotWriteback({
        loadSnapshots: async () => { throw new Error('storage unavailable'); },
        getPresetManager: () => null,
        savePreset: async () => {},
        parsePresetName: name => ({ series: name }),
        logger: { debug() {}, warn() {} },
    });

    assert.deepEqual(await writeBack(), {
        written: 0,
        skipped: 0,
        failed: 1,
        error: 'Error: storage unavailable',
    });
});
