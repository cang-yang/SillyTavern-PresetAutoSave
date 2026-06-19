import test from 'node:test';
import assert from 'node:assert/strict';

import { SaveCoordinator, sameSaveTarget } from '../../modules/core/save-coordinator.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('executes save requests one at a time and returns to idle', async () => {
    const gates = [deferred(), deferred()];
    const started = [];
    const states = [];
    const coordinator = new SaveCoordinator({
        worker: async request => {
            const index = started.length;
            started.push(request.id);
            await gates[index].promise;
            return request.id;
        },
        onStateChange: state => states.push(state.status),
    });

    const first = coordinator.enqueue({ id: 'first', apiId: 'openai', presetName: 'A' });
    const second = coordinator.enqueue({ id: 'second', apiId: 'openai', presetName: 'B' });
    await Promise.resolve();
    assert.deepEqual(started, ['first']);
    assert.equal(coordinator.getState().status, 'running');

    gates[0].resolve();
    await first;
    await Promise.resolve();
    assert.deepEqual(started, ['first', 'second']);

    gates[1].resolve();
    await second;
    await coordinator.whenIdle();
    assert.equal(coordinator.getState().status, 'idle');
    assert.deepEqual(states, ['running', 'idle']);
});

test('coalesces pending revisions for one target but preserves other targets', async () => {
    const gate = deferred();
    const started = [];
    const coordinator = new SaveCoordinator({
        worker: async request => {
            started.push(`${request.presetName}:${request.revision}`);
            if (request.revision === 1) await gate.promise;
            return request.revision;
        },
    });

    const first = coordinator.enqueue({ apiId: 'openai', presetName: 'A', revision: 1 });
    await Promise.resolve();
    const obsolete = coordinator.enqueue({ apiId: 'openai', presetName: 'A', revision: 2 });
    const latest = coordinator.enqueue({ apiId: 'openai', presetName: 'A', revision: 3 });
    const other = coordinator.enqueue({ apiId: 'openai', presetName: 'B', revision: 1 });

    gate.resolve();
    const obsoleteResult = await obsolete;
    await Promise.all([first, latest, other]);
    assert.equal(obsoleteResult.status, 'superseded');
    assert.deepEqual(started, ['A:1', 'A:3', 'B:1']);
});

test('captures an immutable request snapshot at enqueue time', async () => {
    const gate = deferred();
    let observed;
    const coordinator = new SaveCoordinator({
        worker: async request => { await gate.promise; observed = request; },
    });
    const request = {
        apiId: 'openai',
        presetName: 'Original',
        revision: 1,
        preset: { temperature: 1 },
    };

    const result = coordinator.enqueue(request);
    request.presetName = 'Mutated';
    request.preset.temperature = 2;
    gate.resolve();
    await result;

    assert.equal(observed.presetName, 'Original');
    assert.equal(observed.preset.temperature, 1);
});

test('contains worker failures and continues with later requests', async () => {
    const coordinator = new SaveCoordinator({
        worker: async request => {
            if (request.presetName === 'Broken') throw new Error('disk unavailable');
            return 'saved';
        },
    });

    const failed = coordinator.enqueue({ apiId: 'openai', presetName: 'Broken', revision: 1 });
    const committed = coordinator.enqueue({ apiId: 'openai', presetName: 'Healthy', revision: 1 });

    assert.equal((await failed).status, 'failed');
    assert.equal((await committed).status, 'committed');
    await coordinator.whenIdle();
    assert.equal(coordinator.getState().status, 'idle');
});

test('close cancels queued requests, rejects new work, and waits for active work', async () => {
    const gate = deferred();
    const coordinator = new SaveCoordinator({ worker: async () => gate.promise });
    const active = coordinator.enqueue({ apiId: 'openai', presetName: 'A', revision: 1 });
    await Promise.resolve();
    const queued = coordinator.enqueue({ apiId: 'openai', presetName: 'B', revision: 1 });

    coordinator.close();
    assert.equal((await queued).status, 'cancelled');
    await assert.rejects(
        coordinator.enqueue({ apiId: 'openai', presetName: 'C', revision: 1 }),
        /closed/,
    );
    gate.resolve('done');
    assert.equal((await active).status, 'committed');
    await coordinator.whenIdle();
    assert.equal(coordinator.getState().status, 'closed');
});

test('rejects requests without a stable target identity', async () => {
    const coordinator = new SaveCoordinator({ worker: async () => 'unused' });
    await assert.rejects(coordinator.enqueue({ presetName: 'A' }), /apiId/);
    await assert.rejects(coordinator.enqueue({ apiId: 'openai' }), /presetName/);
    assert.equal(coordinator.getState().status, 'idle');
});

test('matches completion state only to the request target', () => {
    assert.equal(sameSaveTarget(
        { apiId: 'openai', presetName: 'A' },
        { apiId: 'openai', presetName: 'A' },
    ), true);
    assert.equal(sameSaveTarget(
        { apiId: 'openai', presetName: 'A' },
        { apiId: 'openai', presetName: 'B' },
    ), false);
});
