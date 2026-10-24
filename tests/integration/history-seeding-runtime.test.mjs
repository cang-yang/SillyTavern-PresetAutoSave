import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

const readStarted = deferred();
const releaseRead = deferred();
let armed = false;
const host = installRuntimeHost({ storageGet: async () => {
    if (armed) {
        armed = false;
        readStarted.resolve();
        await releaseRead.promise;
    }
} });
const compat = await import('../../modules/compatibility.js');
compat.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');
const seeding = await import('../../modules/preset-takeover.js');
const service = await import('../../modules/history-seeding.js');

test('verified seed payload is captured before an asynchronous history read', async () => {
    await history.initHistoryStore();
    const preset = { ...host.live, temperature: 0.8 };
    armed = true;
    try {
        const operation = seeding.seedSnapshotForPreset('race', 'openai', { preset, verified: true });
        await readStarted.promise;
        preset.temperature = 0.99;
        releaseRead.resolve();
        await operation;
        assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.temperature, 0.8);
    } finally {
        releaseRead.resolve();
        await seeding.teardown();
        await service.teardownHistorySeeding();
        await history.teardownHistoryStore();
    }
});
