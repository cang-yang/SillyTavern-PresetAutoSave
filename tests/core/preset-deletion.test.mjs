import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresetDeletionCommand } from '../../modules/core/preset-deletion.js';

function dependencies(overrides = {}) {
    const calls = [];
    return {
        calls,
        runHostDeletion: async (_target, afterDelete) => {
            calls.push('host');
            await afterDelete();
            return { status: 'committed', deleted: true };
        },
        clearHistory: async () => { calls.push('history'); },
        removeArchive: async () => { calls.push('archive'); },
        isCurrentTarget: () => false,
        notifyHost: async () => { calls.push('notify'); },
        ...overrides,
    };
}

test('deletion cleanup failure is partial and retains the remaining recovery stage', async () => {
    const deps = dependencies({ clearHistory: async () => { throw new Error('storage unavailable'); } });
    const result = await createPresetDeletionCommand(deps)({ apiId: 'openai', presetName: 'A' });
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'history');
    assert.deepEqual(deps.calls, ['host', 'notify']);
});

test('notification failure cannot turn a committed deletion into failure', async () => {
    const deps = dependencies({ notifyHost: async () => { throw new Error('observer'); } });
    const result = await createPresetDeletionCommand(deps)({ apiId: 'openai', presetName: 'A' });
    assert.equal(result.status, 'committed');
    assert.deepEqual(deps.calls, ['host', 'history', 'archive']);
});

test('queued deletion captures target and rechecks current selection before host mutation', async () => {
    let release;
    let started;
    const barrier = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    let current = null;
    const observed = [];
    const command = createPresetDeletionCommand(dependencies({
        runHostDeletion: async (target, afterDelete) => {
            observed.push(target.presetName);
            started();
            await barrier;
            await afterDelete();
            return { status: 'committed', deleted: true };
        },
        isCurrentTarget: target => current === target.presetName,
    }));
    const first = command({ apiId: 'openai', presetName: 'A' });
    await entered;
    const target = { apiId: 'openai', presetName: 'B' };
    const second = command(target);
    target.presetName = 'C';
    current = 'B';
    release();
    assert.equal((await first).status, 'committed');
    assert.equal((await second).status, 'protected');
    assert.deepEqual(observed, ['A']);
});
