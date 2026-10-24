import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';

const host = installRuntimeHost();
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({
    takeoverEnabled: false, autoSeedOnTakeover: false, fallbackPolling: false,
    mergeWindowSec: 0, skipUnchangedSave: true,
});
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');
const { getSaveStatus } = await import('../../modules/core/save-status.js');

async function importRecord(name, preset, hash, extra = {}) {
    const record = {
        id: `imported-${name}`, apiId: 'openai', presetName: name,
        timestamp: 1, trigger: 'manual', preset, hash, pinned: true, name: '',
        ...extra,
    };
    await history.importAll({ version: 2, data: { [`openai::${name}`]: [record] } }, 'merge');
    return record;
}

test('imported matching hash cannot suppress an automatic host save recovery point', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        const future = { ...host.live, temperature: 0.9 };
        const original = await importRecord('race', { ...host.live }, history.hashPreset(future));
        host.live.temperature = 0.9;
        const result = await auto.saveNowDetailed('auto');
        assert.equal(host.writes.at(-1).preset.temperature, 0.9);
        const snapshots = await history.getSnapshots('openai', 'race');
        assert.equal(snapshots[0].preset.temperature, 0.9);
        assert.equal(result.status, 'committed');
        assert.equal(getSaveStatus(), 'saved');
        const retained = snapshots.find(item => item.id === original.id);
        assert.equal(retained.hash, original.hash);
        assert.equal(retained.pinned, true);
        assert.deepEqual(retained.preset, original.preset);
    } finally {
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('switch guard records changed content despite imported matching hash', async () => {
    await history.initHistoryStore();
    try {
        const future = { temperature: 0.9 };
        const original = await importRecord('guard', { temperature: 0.1 }, history.hashPreset(future));
        const result = await history.addSnapshot('guard', 'openai', future, history.TRIGGER.SWITCH_GUARD);
        assert.ok(result?.id);
        assert.notEqual(result.id, original.id);
        assert.equal((await history.getSnapshots('openai', 'guard')).length, 2);
    } finally {
        await history.teardownHistoryStore();
    }
});

test('canonical equivalents skip even with stale imported hash and preserve its metadata', async () => {
    await history.initHistoryStore();
    try {
        const original = await importRecord('equivalent', { temp_openai: '0.9' }, 'legacy-stale-hash');
        const result = await history.addSnapshot('equivalent', 'openai', { temperature: 0.9 }, history.TRIGGER.AUTO);
        assert.equal(result, null);
        const snapshots = await history.getSnapshots('openai', 'equivalent');
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].id, original.id);
        assert.equal(snapshots[0].hash, original.hash);
        assert.equal(snapshots[0].pinned, true);
    } finally {
        await history.teardownHistoryStore();
    }
});

test('equal recomputed 32-bit hashes do not establish canonical content equality', async () => {
    const before = { send_if_empty: 'collision-46781' };
    const after = { send_if_empty: 'collision-126001' };
    assert.equal(history.hashPreset(before), history.hashPreset(after));
    await history.initHistoryStore();
    try {
        await importRecord('collision', before, history.hashPreset(before));
        const result = await history.addSnapshot('collision', 'openai', after, history.TRIGGER.AUTO);
        assert.ok(result?.id);
        assert.deepEqual(result.preset, after);
        assert.equal((await history.getSnapshots('openai', 'collision')).length, 2);
    } finally {
        await history.teardownHistoryStore();
    }
});

test('empty legacy canonical payload does not block a new valid snapshot', async () => {
    await history.initHistoryStore();
    try {
        host.stores.get('history').set('openai::empty-legacy', [{
            id: 'empty-legacy', apiId: 'openai', presetName: 'empty-legacy',
            timestamp: 1, trigger: 'manual', preset: {}, hash: 'legacy-empty', pinned: true,
        }]);
        const result = await history.addSnapshot('empty-legacy', 'openai', { temperature: 0.4 }, history.TRIGGER.AUTO);
        assert.ok(result?.id);
        assert.deepEqual(result.preset, { temperature: 0.4 });
    } finally {
        await history.teardownHistoryStore();
    }
});
