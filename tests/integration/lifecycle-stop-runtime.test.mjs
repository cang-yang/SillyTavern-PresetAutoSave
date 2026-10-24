import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

const started = deferred();
const release = deferred();
let firstArchiveKeys = true;
const host = installRuntimeHost({ storageKeys: async storeName => {
    if (storeName === 'archived_presets' && firstArchiveKeys) {
        firstArchiveKeys = false;
        started.resolve();
        await release.promise;
    }
} });
const runtime = await import('../../index.js');

test('stop waits for abandoned initialization and leaves no revived subscriptions', async () => {
    const enable = runtime.onEnable();
    await started.promise;
    let stopped = false;
    const disable = runtime.onDisable().then(result => { stopped = true; return result; });
    try {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(stopped, false, 'disable must not resolve while initialization can still acquire resources');
        release.resolve();
        await Promise.all([enable, disable]);
        assert.equal(host.listenerCount(), 0);
    } finally {
        release.resolve();
        await Promise.allSettled([enable, disable]);
        await runtime.onDisable();
    }
});
