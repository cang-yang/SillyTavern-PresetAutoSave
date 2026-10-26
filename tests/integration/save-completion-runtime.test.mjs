import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';
import { installEditControls } from '../fixtures/edit-controls.mjs';

let started = deferred();
let release = deferred();
let holdSave = true;
const host = installRuntimeHost({ save: async () => {
    if (holdSave) { started.resolve(); await release.promise; }
} });
const controls = installEditControls(host);
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ mergeWindowSec: 0, fallbackPolling: false, debounceMs: 100 });
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');

test('an older save never adopts the fingerprint of an edit made during persistence', async () => {
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        host.live.temperature = 0.2;
        const first = auto.saveNow();
        await started.promise;
        controls.change('temperature', 0.3);
        await new Promise(resolve => setTimeout(resolve, 5));
        holdSave = false;
        release.resolve();
        await first;
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(host.writes.at(-1).preset.temperature, 0.3);
        assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.temperature, 0.3);
        assert.equal(auto.isDirty(), false);
    } finally {
        release.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

test('host settings events during an active save cannot mint a second user edit', async () => {
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
        assert.equal(host.writes.at(-1).preset.temperature, 0.4);
        assert.equal(host.live.temperature, 0.5, 'background state must not be overwritten');
    } finally {
        release.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});
