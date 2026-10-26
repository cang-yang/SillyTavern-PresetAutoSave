import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';

let gate = null;
const host = installRuntimeHost({ storageGet: async (store, key) => {
    if (gate && store === 'history_v2' && key === 'openai::race') {
        gate.started.resolve();
        await gate.release.promise;
    }
} });
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');

test('history teardown drains accepted mutations before detaching storage and rejects new work', async () => {
    await history.initHistoryStore();
    gate = { started: deferred(), release: deferred() };
    const save = history.addSnapshot('race', 'openai', { temperature: 0.8 }, history.TRIGGER.MANUAL);
    // Attach failure observation before teardown can race it.
    const outcome = save.then(value => ({ value }), error => ({ error }));
    await gate.started.promise;
    let closed = false;
    const closing = history.teardownHistoryStore().then(() => { closed = true; });
    try {
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(closed, false, 'accepted writes still own their repository');
        await assert.rejects(history.addSnapshot('later', 'openai', { temperature: 0.9 }), /closing|initialized/);
        gate.release.resolve();
        const result = await outcome;
        assert.equal(result.error, undefined);
        assert.ok(result.value.id);
        await closing;
        assert.equal(host.stores.get('history_v2').get('openai::race')[0].preset.temperature, 0.8);
    } finally {
        gate.release.resolve();
        await Promise.all([outcome, closing]);
        gate = null;
    }
});
