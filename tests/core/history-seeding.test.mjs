import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistorySeeding } from '../../modules/core/history-seeding.js';
import { deferred } from '../fixtures/runtime-host.mjs';

test('seeding captures the exact target and payload and serializes duplicates', async () => {
    const gate = deferred();
    const records = [];
    const captured = [];
    const controller = createHistorySeeding({
        capturePreset: target => { captured.push(target); return { temperature: 0.8 }; },
        readHistory: async () => { await gate.promise; return records; },
        writeSnapshot: async (target, preset) => { records.push({ target, preset }); return records[0]; },
    });
    const target = { apiId: 'openai', presetName: 'Original' };
    const first = controller.seed(target);
    const second = controller.seed(target);
    target.apiId = 'kobold';
    target.presetName = 'Later';
    gate.resolve();
    assert.equal((await first).seeded, true);
    assert.equal((await second).reason, 'existing');
    assert.deepEqual(records[0].target, { apiId: 'openai', presetName: 'Original' });
    assert.equal(records.length, 1);
    assert.equal(captured[0].presetName, 'Original');
});

test('closing during a pending history read prevents a new snapshot write', async () => {
    const gate = deferred();
    const entered = deferred();
    let writes = 0;
    const controller = createHistorySeeding({
        capturePreset: () => ({ temperature: 1 }),
        readHistory: async () => { entered.resolve(); await gate.promise; return []; },
        writeSnapshot: async () => { writes++; },
    });
    const operation = controller.seed({ apiId: 'openai', presetName: 'A' });
    await entered.promise;
    const closing = controller.close();
    gate.resolve();
    await closing;
    assert.equal((await operation).reason, 'closed');
    assert.equal(writes, 0);
});

test('closing drains an already-started write and rejects unverified payloads', async () => {
    const gate = deferred();
    const entered = deferred();
    const controller = createHistorySeeding({
        capturePreset: () => ({ temperature: 1 }),
        readHistory: async () => [],
        writeSnapshot: async () => { entered.resolve(); await gate.promise; return {}; },
    });
    const target = { apiId: 'openai', presetName: 'A' };
    assert.equal((await controller.seed(target, { preset: {} })).reason, 'unverified');
    const operation = controller.seed(target);
    await entered.promise;
    let closed = false;
    const closing = controller.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    gate.resolve();
    await closing;
    assert.equal((await operation).seeded, true);
    assert.equal((await controller.seed(target)).reason, 'closed');
});

test('target cancellation drains an active seed and blocks queued seeds until recreated', async () => {
    const gate = deferred();
    const entered = deferred();
    const target = { apiId: 'openai', presetName: 'A' };
    let writes = 0;
    const controller = createHistorySeeding({
        capturePreset: () => ({ temperature: 1 }),
        readHistory: async () => [],
        writeSnapshot: async () => { writes++; entered.resolve(); await gate.promise; return {}; },
    });
    const first = controller.seed(target);
    await entered.promise;
    const next = controller.seed(target);
    const cancelled = controller.cancelTarget(target);
    gate.resolve();
    await first;
    await cancelled;
    assert.equal(writes, 1);
    assert.equal((await next).reason, 'closed');
    controller.allowTarget(target);
    assert.equal((await controller.seed(target)).seeded, true);
    assert.equal(writes, 2);
});
