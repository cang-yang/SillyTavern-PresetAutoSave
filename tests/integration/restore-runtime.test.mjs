import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

let blocker = null;
let entered = null;
let failHistory = false;
const host = installRuntimeHost({
    save: async () => { entered?.resolve(); if (blocker) await blocker.promise; },
    storageSet: async store => {
        if (failHistory && store === 'history_v2') throw new Error('history unavailable');
    },
});
const compat = await import('../../modules/compatibility.js');
compat.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');
const { logger } = await import('../../modules/logger.js');
const { getSaveStatus } = await import('../../modules/core/save-status.js');

test('restore uses the active writer barrier and captures its immutable payload', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        blocker = deferred();
        entered = deferred();
        host.live.temperature = 0.2;
        const saving = auto.saveNow();
        await entered.promise;
        const preset = { ...host.live, temperature: 0.8 };
        const restoring = auto.restoreSnapshotDetailed({ apiId: 'openai', presetName: 'race', preset });
        preset.temperature = 0.99;
        assert.equal(host.writes.length, 0);
        blocker.resolve();
        blocker = null;
        await saving;
        const outcome = await restoring;
        assert.equal(outcome.status, 'committed');
        assert.deepEqual(host.writes.map(item => item.preset.temperature), [0.2, 0.8]);
        assert.equal(host.writes.at(-1).options.skipUpdate, false);
        assert.equal((await history.getSnapshots('openai', 'race'))[0].trigger, 'restore');
    } finally {
        blocker?.resolve();
        blocker = null;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('restore reports partial history failure and works with automatic saving disabled', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    settings.updateSetting('enabled', false);
    failHistory = true;
    try {
        const outcome = await auto.restoreSnapshotDetailed({
            apiId: 'openai', presetName: 'race', preset: { ...host.live, temperature: 0.9 },
        });
        assert.equal(outcome.status, 'partial');
        assert.equal(getSaveStatus(), 'partial');
        assert.equal(outcome.error.diskCommitted, true);
        assert.equal(host.writes.at(-1).preset.temperature, 0.9);
    } finally {
        failHistory = false;
        await auto.teardown();
        await history.teardownHistoryStore();
        settings.updateSetting('enabled', true);
    }
});

test('diagnostic observer failures cannot interrupt a restore transaction', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    const original = logger.debug;
    logger.debug = (...args) => {
        if (String(args[0]).startsWith('[doSave]')) throw new Error('diagnostic observer failed');
        original(...args);
    };
    try {
        const outcome = await auto.restoreSnapshotDetailed({
            apiId: 'openai', presetName: 'race', preset: { ...host.live, temperature: 0.7 },
        });
        assert.equal(outcome.status, 'committed');
        assert.equal(host.writes.at(-1).preset.temperature, 0.7);
    } finally {
        logger.debug = original;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('invalid live preset returns a failed detailed result without any write', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    const count = host.writes.length;
    host.live.temperature = Number.NaN;
    try {
        const outcome = await auto.saveNowDetailed();
        assert.equal(outcome.status, 'failed');
        assert.equal(getSaveStatus(), 'error');
        assert.equal(host.writes.length, count);
    } finally {
        host.live.temperature = 0.7;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});
