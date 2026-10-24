import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

let started = deferred();
let release = deferred();
let holdSave = true;
const host = installRuntimeHost({ save: async () => {
    if (holdSave) { started.resolve(); await release.promise; }
} });
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ mergeWindowSec: 0, fallbackPolling: false });
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');

test('an older save never adopts the fingerprint of an edit made during persistence', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        host.live.temperature = 0.2;
        const first = auto.saveNow();
        await started.promise;
        host.live.temperature = 0.3;
        auto.scheduleAutoSave(30, 'settings_updated');
        holdSave = false;
        release.resolve();
        await first;
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(host.writes.at(-1).preset.temperature, 0.3);
        assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.temperature, 0.3);
        assert.equal(auto.isDirty(), false);
    } finally {
        release.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('host settings events during an active save retain the final intent without a DOM event', async () => {
    started = deferred();
    release = deferred();
    holdSave = true;
    settings.updateSetting('debounceMs', 100);
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        host.live.temperature = 0.4;
        const first = auto.saveNow();
        await started.promise;
        host.live.temperature = 0.5;
        host.emit('settings_updated');
        holdSave = false;
        release.resolve();
        await first;
        await new Promise(resolve => setTimeout(resolve, 170));
        assert.equal(host.writes.at(-1).preset.temperature, 0.5);
    } finally {
        release.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});
