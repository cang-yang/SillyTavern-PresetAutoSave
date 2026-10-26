import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLifecycle } from '../../modules/core/runtime-lifecycle.js';
import { deferred } from '../fixtures/runtime-host.mjs';

test('duplicate starts share work and stop invalidates initialization before cleaning up', async () => {
    const gate = deferred();
    const calls = [];
    const lifecycle = createRuntimeLifecycle({
        initialize: async current => {
            calls.push('start');
            await gate.promise;
            if (current()) calls.push('next-phase');
            return true;
        },
        cleanup: async () => calls.push('cleanup'),
    });
    const first = lifecycle.start();
    assert.equal(lifecycle.start(), first);
    const stopping = lifecycle.stop();
    assert.deepEqual(calls, ['start']);
    gate.resolve();
    assert.equal(await first, false);
    await stopping;
    assert.deepEqual(calls, ['start', 'cleanup']);
    assert.equal(await lifecycle.start(), false);
});

test('enable requested during stop starts a fresh generation after cleanup', async () => {
    const gate = deferred();
    const calls = [];
    const lifecycle = createRuntimeLifecycle({
        initialize: async () => { calls.push('start'); return true; },
        cleanup: async () => { calls.push('cleanup'); await gate.promise; },
    });
    await lifecycle.start();
    const stop = lifecycle.stop();
    const restart = lifecycle.start({ explicit: true });
    assert.deepEqual(calls, ['start', 'cleanup']);
    gate.resolve();
    await stop;
    assert.equal(await restart, true);
    assert.deepEqual(calls, ['start', 'cleanup', 'start']);
});

test('failed readiness rolls back acquired resources and can be retried', async () => {
    let succeeds = false;
    let cleanups = 0;
    const lifecycle = createRuntimeLifecycle({
        initialize: async () => succeeds,
        cleanup: async () => { cleanups++; },
    });
    assert.equal(await lifecycle.start(), false);
    assert.equal(cleanups, 1);
    succeeds = true;
    assert.equal(await lifecycle.start(), true);
});

test('a repeated stop operation is idempotent until explicitly enabled again', async () => {
    let cleanups = 0;
    const lifecycle = createRuntimeLifecycle({
        initialize: async () => true,
        cleanup: async () => ++cleanups,
    });
    await lifecycle.start();
    assert.equal(await lifecycle.stop(), 1);
    assert.equal(await lifecycle.stop(), 1);
    assert.equal(cleanups, 1);
    await lifecycle.start({ explicit: true });
    assert.equal(await lifecycle.stop(), 2);
});

test('a rejected stop is retryable without enabling the runtime', async () => {
    let attempts = 0;
    const lifecycle = createRuntimeLifecycle({
        initialize: async () => true,
        cleanup: async () => { if (++attempts === 1) throw new Error('storage busy'); return { complete: true }; },
    });
    await lifecycle.start();
    await assert.rejects(lifecycle.stop(), /storage busy/);
    assert.deepEqual(await lifecycle.stop(), { complete: true });
    assert.equal(attempts, 2);
});

test('an explicitly incomplete stop result is not cached as successful cleanup', async () => {
    let attempts = 0;
    const lifecycle = createRuntimeLifecycle({
        initialize: async () => true,
        cleanup: async () => ({ complete: ++attempts > 1 }),
    });
    await lifecycle.start();
    assert.equal((await lifecycle.stop()).complete, false);
    assert.equal((await lifecycle.stop()).complete, true);
    assert.equal(attempts, 2);
});

test('a different stop command waits for active cleanup and is not silently dropped', async () => {
    const gate = deferred();
    const calls = [];
    const disable = async () => { calls.push('disable'); await gate.promise; return 'disabled'; };
    const remove = async () => { calls.push('delete'); return 'deleted'; };
    const lifecycle = createRuntimeLifecycle({ initialize: async () => true, cleanup: disable });
    await lifecycle.start();
    const first = lifecycle.stop(disable);
    const second = lifecycle.stop(remove);
    gate.resolve();
    assert.equal(await first, 'disabled');
    assert.equal(await second, 'deleted');
    assert.deepEqual(calls, ['disable', 'delete']);
});
