import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, installRuntimeHost } from '../fixtures/runtime-host.mjs';
import { installEditControls } from '../fixtures/edit-controls.mjs';

let barrier = null;
let rejectWrite = false;
const host = installRuntimeHost({ save: async () => {
    if (rejectWrite) throw new Error('fixture write failure');
    if (barrier) { barrier.started.resolve(); await barrier.release.promise; }
} });
const controls = installEditControls(host);
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ debounceMs: 20, mergeWindowSec: 0, fallbackPolling: false });
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(body) {
    await history.initHistoryStore();
    await auto.initAutoSave();
    try { await body(); }
    finally {
        barrier?.release.resolve();
        barrier = null;
        rejectWrite = false;
        await auto.teardown();
        await history.teardownHistoryStore();
    }
}

test('background extension updates never authorize host writes or snapshots', async () => {
    await run(async () => {
        const writes = host.writes.length;
        const ids = (await history.getSnapshots('openai', 'race')).map(item => item.id);
        host.live.extensions = { runtime: { active: true } };
        host.emit('settings_updated');
        await wait(100);
        assert.equal(host.writes.length, writes);
        assert.deepEqual((await history.getSnapshots('openai', 'race')).map(item => item.id), ids);
        assert.equal(auto.isDirty(), false);
    });
});

test('an explicit snapshot does not authorize later background drift during the host write', async () => {
    await run(async () => {
        barrier = { started: deferred(), release: deferred() };
        host.live.temperature = 0.65;
        const operation = auto.saveNowDetailed();
        await barrier.started.promise;
        host.live.extensions = { runtime: { active: false } };
        host.emit('settings_updated');
        barrier.release.resolve();
        const outcome = await operation;
        assert.equal(outcome.status, 'committed');
        const writes = host.writes.length;
        await wait(100);
        assert.equal(host.writes.length, writes, 'background drift must not cause a follow-up write');
        assert.equal(auto.isDirty(), false);
    });
});

test('unowned scheduling and flush cannot bypass the edit authorization boundary', async () => {
    await run(async () => {
        const writes = host.writes.length;
        host.live.temperature = 0.75;
        auto.scheduleAutoSave(0, 'prompt-mutation');
        await wait(40);
        await auto.flushSave();
        assert.equal(host.writes.length, writes);
        const explicit = await auto.saveNowDetailed();
        assert.equal(explicit.status, 'committed');
        assert.equal(host.writes.at(-1).preset.temperature, 0.75);
        assert.deepEqual(host.writes.at(-1).preset.extensions, host.live.extensions);
    });
});

test('trusted edits capture full state once while synthetic input does not authorize persistence', async () => {
    await run(async () => {
        const writes = host.writes.length;
        controls.change('temperature', 0.12, { isTrusted: false });
        host.emit('settings_updated');
        await wait(60);
        assert.equal(host.writes.length, writes);
        controls.change('temperature', 0.22);
        await wait(5);
        host.live.extensions = { runtime: { backgroundAfterEdit: true } };
        host.emit('settings_updated');
        await wait(150);
        assert.equal(host.writes.length, writes + 1);
        assert.equal(host.writes.at(-1).preset.temperature, 0.22);
        assert.equal(host.writes.at(-1).preset.extensions.runtime.backgroundAfterEdit, undefined);
    });
    assert.equal(controls.listenerCount(), 0);
});

test('a newer trusted edit survives an in-flight write, without authorizing later ambient changes', async () => {
    await run(async () => {
        barrier = { started: deferred(), release: deferred() };
        controls.change('temperature', 0.31);
        await barrier.started.promise;
        controls.change('temperature', 0.41);
        await wait(5);
        host.live.temperature = 0.91;
        host.emit('settings_updated');
        barrier.release.resolve();
        await wait(100);
        assert.equal(host.writes.at(-1).preset.temperature, 0.41);
        assert.equal(auto.isDirty(), false);
    });
});

test('switch protection submits the immutable edit to its original preset', async () => {
    await run(async () => {
        settings.updateSetting('debounceMs', 10000);
        controls.change('temperature', 0.51);
        await wait(5);
        host.live.temperature = 0.99;
        host.emit('oai_preset_changed_before');
        await wait(70);
        assert.equal(host.writes.at(-1).name, 'race');
        assert.equal(host.writes.at(-1).preset.temperature, 0.51);
        settings.updateSetting('debounceMs', 20);
    });
});

test('invalid initial host state remains diagnosable and recoverable by a later explicit snapshot', async () => {
    host.live.extensions = { broken: NaN };
    await run(async () => {
        const writes = host.writes.length;
        const failure = await auto.saveNowDetailed();
        assert.equal(failure.status, 'failed');
        assert.equal(host.writes.length, writes);
        host.live.extensions.broken = 1;
        const recovered = await auto.saveNowDetailed();
        assert.equal(recovered.status, 'committed');
    });
});

test('an overdue host write keeps exclusive ownership until its promise settles', async () => {
    await run(async () => {
        const originalTimer = globalThis.setTimeout;
        const originalNow = Date.now;
        let watchdog;
        barrier = { started: deferred(), release: deferred() };
        try {
            globalThis.setTimeout = (fn, delay, ...args) => {
                if (delay === 15000) watchdog = fn;
                return originalTimer(fn, delay, ...args);
            };
            host.live.temperature = 0.61;
            const first = auto.saveNowDetailed();
            await barrier.started.promise;
            const beforeWrites = host.writes.length;
            Date.now = () => originalNow() + 16000;
            watchdog();
            Date.now = originalNow;
            assert.equal(auto.isSaving(), true);
            host.live.temperature = 0.71;
            const second = auto.saveNowDetailed();
            await wait(20);
            assert.equal(host.writes.length, beforeWrites);
            barrier.release.resolve();
            assert.equal((await first).status, 'committed');
            assert.equal((await second).status, 'committed');
            assert.equal(host.writes.length, beforeWrites + 2);
            assert.equal(auto.isSaving(), false);
        } finally {
            Date.now = originalNow;
            globalThis.setTimeout = originalTimer;
            barrier.release.resolve();
        }
    });
});

test('stable runtime/stored divergence settles unverified without speculative history or writes', async () => {
    await run(async () => {
        const writes = host.writes.length;
        const count = (await history.getSnapshots('openai', 'race')).length;
        host.live.extensions = { plugin: { runtime: true } };
        host.emit('preset_changed');
        await wait(1000);
        assert.equal(auto.getCurrentTracking().ignoring, false);
        assert.equal(auto.getCurrentTracking().lastHash, null);
        assert.equal(host.writes.length, writes);
        assert.equal((await history.getSnapshots('openai', 'race')).length, count);
        controls.change('temperature', 0.81);
        await wait(160);
        assert.equal(host.writes.at(-1).preset.temperature, 0.81);
    });
});

test('reverting to the last committed value during an in-flight edit is not discarded', async () => {
    await run(async () => {
        const original = host.live.temperature;
        barrier = { started: deferred(), release: deferred() };
        controls.change('temperature', original + 0.1);
        await barrier.started.promise;
        controls.change('temperature', original);
        await wait(160);
        barrier.release.resolve();
        await wait(80);
        assert.equal(host.writes.at(-1).preset.temperature, original);
        assert.equal(auto.isDirty(), false);
    });
});

test('manual recovery acknowledges a failed automatic edit without leaving permanent pending state', async () => {
    await run(async () => {
        rejectWrite = true;
        controls.change('temperature', 0.93);
        await wait(160);
        assert.equal(auto.isDirty(), true);
        rejectWrite = false;
        assert.equal((await auto.saveNowDetailed()).status, 'committed');
        assert.equal(auto.isDirty(), false);
        assert.equal(auto.isPending(), false);
    });
});

test('automatic retry preserves the failed edit instead of recapturing background state', async () => {
    await run(async () => {
        rejectWrite = true;
        const writes = host.writes.length;
        controls.change('temperature', 0.92);
        await wait(160);
        assert.equal(auto.isDirty(), true);
        rejectWrite = false;
        host.live.temperature = 0.11;
        host.emit('settings_updated');
        await wait(1100);
        assert.equal(host.writes.length, writes + 1);
        assert.equal(host.writes.at(-1).preset.temperature, 0.92);
        assert.equal(host.live.temperature, 0.11);
        assert.equal(auto.isDirty(), false);
    });
});

test('successful native save acknowledges a failed automatic edit captured with its request', async () => {
    const originalFetch = globalThis.fetch;
    const originalAdd = document.addEventListener;
    const originalRemove = document.removeEventListener;
    const clicks = new Set();
    document.addEventListener = (type, handler, ...args) => {
        if (type === 'click') clicks.add(handler);
        originalAdd.call(document, type, handler, ...args);
    };
    document.removeEventListener = (type, handler, ...args) => {
        if (type === 'click') clicks.delete(handler);
        originalRemove.call(document, type, handler, ...args);
    };
    globalThis.fetch = async () => ({ ok: true });
    try {
        await run(async () => {
            rejectWrite = true;
            controls.change('temperature', 0.94);
            await wait(160);
            assert.equal(auto.isDirty(), true);
            rejectWrite = false;
            const button = { id: 'update_oai_preset' };
            for (const handler of clicks) handler({ isTrusted: true, target: { closest: () => button } });
            await window.fetch('/api/presets/save', {
                method: 'POST', body: JSON.stringify({ apiId: 'openai', name: 'race', preset: host.live }),
            });
            await wait(60);
            assert.equal(auto.isDirty(), false);
            assert.equal(auto.isPending(), false);
        });
    } finally {
        globalThis.fetch = originalFetch;
        document.addEventListener = originalAdd;
        document.removeEventListener = originalRemove;
    }
});

test('a same-turn switch finalizes the old target edit before host state replacement', async () => {
    await run(async () => {
        controls.change('temperature', 0.84);
        host.emit('oai_preset_changed_before');
        host.pm.select[0].options[0].textContent = 'B';
        host.live.temperature = 0.22;
        host.emit('preset_changed');
        await wait(150);
        assert.equal(host.writes.at(-1).name, 'race');
        assert.equal(host.writes.at(-1).preset.temperature, 0.84);
        host.pm.select[0].options[0].textContent = 'race';
    });
});

test('disable cancels queued automatic writes while the active writer retains ownership', async () => {
    await run(async () => {
        barrier = { started: deferred(), release: deferred() };
        const count = host.writes.length;
        controls.change('temperature', 0.64);
        await barrier.started.promise;
        controls.change('temperature', 0.74);
        await wait(160);
        settings.updateSetting('enabled', false);
        assert.equal(auto.isSaving(), true);
        barrier.release.resolve();
        await wait(60);
        assert.equal(host.writes.length, count + 1);
        assert.equal(host.writes.at(-1).preset.temperature, 0.64);
        assert.equal(auto.isDirty(), false);
        settings.updateSetting('enabled', true);
    });
});
