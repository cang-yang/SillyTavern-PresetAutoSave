import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

let gate;
let started;
const order = [];
const host = installRuntimeHost({
    save: async ({ name }) => { started?.resolve(); if (gate) await gate.promise; order.push(`save:${name}`); },
    remove: async name => { order.push(`delete:${name}`); return name !== 'fails'; },
});
const compat = await import('../../modules/compatibility.js');
compat.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');

test('deletion waits behind an active write and cancels pending target restores', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    gate = deferred();
    started = deferred();
    try {
        host.live.temperature = 0.2;
        const saving = auto.saveNow();
        await started.promise;
        const pending = auto.restoreSnapshotDetailed({ apiId: 'openai', presetName: 'other', preset: { temperature: 0.8 } });
        const deleting = auto.deleteHostPresetDetailed({ apiId: 'openai', presetName: 'other' });
        gate.resolve();
        gate = null;
        await saving;
        assert.equal((await pending).status, 'cancelled');
        const result = await deleting;
        assert.equal(result.status, 'committed');
        assert.equal(result.deleted, true);
        assert.deepEqual(order, ['save:race', 'delete:other']);
        assert.equal((await auto.restoreSnapshotDetailed({
            apiId: 'openai', presetName: 'other', preset: { temperature: 0.9 },
        })).status, 'unavailable');
    } finally {
        gate?.resolve();
        gate = null;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('current target is protected and unsuccessful delete permits a later explicit write', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    const originalList = host.pm.getPresetList;
    host.pm.getPresetList = () => ({ settings: host.live, presets: [host.stored, { temperature: 0.1 }],
        preset_names: ['race', 'fails'] });
    try {
        assert.equal((await auto.deleteHostPresetDetailed({ apiId: 'openai', presetName: 'race' })).status, 'protected');
        assert.equal((await auto.deleteHostPresetDetailed({ apiId: 'openai', presetName: 'fails' })).status, 'failed');
        assert.equal((await auto.restoreSnapshotDetailed({
            apiId: 'openai', presetName: 'fails', preset: { temperature: 0.9 },
        })).status, 'committed');
    } finally {
        host.pm.getPresetList = originalList;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('deletion retains the writer through recovery cleanup and exposes partial cleanup failure', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    const cleanupEntered = deferred();
    const finishCleanup = deferred();
    const start = order.length;
    try {
        const deletion = auto.deleteHostPresetDetailed({ apiId: 'openai', presetName: 'cleanup' }, {
            afterDelete: async () => {
                order.push('cleanup:start');
                cleanupEntered.resolve();
                await finishCleanup.promise;
                order.push('cleanup:end');
            },
        });
        await Promise.race([cleanupEntered.promise, deletion.then(() => {
            throw new Error('Deletion returned without running its cleanup barrier');
        })]);
        host.live.temperature = 0.6;
        const saving = auto.saveNowDetailed();
        await Promise.resolve();
        assert.deepEqual(order.slice(start), ['delete:cleanup', 'cleanup:start']);
        finishCleanup.resolve();
        assert.equal((await deletion).status, 'committed');
        assert.equal((await saving).status, 'committed');
        assert.deepEqual(order.slice(start), ['delete:cleanup', 'cleanup:start', 'cleanup:end', 'save:race']);
        const partial = await auto.deleteHostPresetDetailed({ apiId: 'openai', presetName: 'partial' }, {
            afterDelete: async () => { throw new Error('Archive cleanup failed'); },
        });
        assert.equal(partial.status, 'partial');
        assert.equal(partial.deleted, true);
        assert.match(partial.error.message, /Archive cleanup/);
    } finally {
        finishCleanup.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});
