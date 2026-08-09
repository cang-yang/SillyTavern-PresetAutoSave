import test from 'node:test';
import assert from 'node:assert/strict';

import { createPresetSwitchConvergence } from '../../modules/core/preset-switch-convergence.js';

function createManualScheduler() {
    let nextId = 1;
    const jobs = new Map();
    return {
        schedule(fn) {
            const id = nextId++;
            jobs.set(id, fn);
            return id;
        },
        cancel(id) {
            jobs.delete(id);
        },
        takeNext() {
            const entry = jobs.entries().next().value;
            if (!entry) return null;
            jobs.delete(entry[0]);
            return entry[1];
        },
        async runNext() {
            const fn = this.takeNext();
            if (fn) await fn();
        },
        pending() {
            return jobs.size;
        },
    };
}

function candidate(name, liveHash, storedHash = null, temperature = 0.7) {
    return {
        apiId: 'openai',
        presetName: name,
        preset: { temperature },
        liveHash,
        storedHash,
    };
}

test('waits for destination live content to match stored content before settling', async () => {
    const scheduler = createManualScheduler();
    const candidates = [
        candidate('Preset B', 'hash-a', 'hash-b', 0.1),
        candidate('Preset B', 'hash-b', 'hash-b', 0.8),
        candidate('Preset B', 'hash-b', 'hash-b', 0.8),
    ];
    const settled = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => candidates.shift(),
        onSettled: value => settled.push(value),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        requiredStableSamples: 2,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();
    await scheduler.runNext();
    assert.equal(settled.length, 0);
    await scheduler.runNext();

    assert.equal(settled.length, 1);
    assert.equal(settled[0].presetName, 'Preset B');
    assert.equal(settled[0].preset.temperature, 0.8);
    assert.equal(settled[0].verified, true);
    assert.equal(controller.isActive(), false);
});

test('only the newest rapid switch generation may settle', async () => {
    const scheduler = createManualScheduler();
    let selected = candidate('Preset B', 'hash-b', 'hash-b');
    const settled = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => selected,
        onSettled: value => settled.push(value.presetName),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        requiredStableSamples: 1,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    const staleCallback = scheduler.takeNext();
    selected = candidate('Preset C', 'hash-c', 'hash-c');
    controller.begin({ apiId: 'openai', presetName: 'Preset C' });

    await staleCallback();
    await scheduler.runNext();

    assert.deepEqual(settled, ['Preset C']);
});

test('does not settle a candidate that disagrees with the target hint', async () => {
    const scheduler = createManualScheduler();
    const settled = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => candidate('Preset A', 'hash-a', 'hash-a'),
        onSettled: value => settled.push(value),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        requiredStableSamples: 1,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();

    assert.equal(settled.length, 0);
    assert.equal(controller.isActive(), true);
});

test('stable compatibility fallback settles without authorizing history seeding', async () => {
    const scheduler = createManualScheduler();
    const settled = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => candidate('Preset B', 'hash-b', null, 0.8),
        onSettled: value => settled.push(value),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        requiredStableSamples: 1,
        requiredFallbackSamples: 3,
        allowUnverifiedFallback: true,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();
    await scheduler.runNext();

    assert.equal(settled.length, 0);
    await scheduler.runNext();

    assert.equal(settled.length, 1);
    assert.equal(settled[0].verified, false);
});

test('fails closed when stored destination content cannot be verified', async () => {
    const scheduler = createManualScheduler();
    let now = 0;
    const settled = [];
    const timedOut = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => candidate('Preset B', 'hash-b', null, 0.8),
        onSettled: value => settled.push(value),
        onTimeout: value => timedOut.push(value),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        now: () => now,
        timeoutMs: 100,
        requiredFallbackSamples: 1,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();
    assert.equal(settled.length, 0);

    now = 101;
    await scheduler.runNext();
    assert.equal(settled.length, 0);
    assert.equal(timedOut.length, 1);
});

test('settled candidates own an immutable payload snapshot', async () => {
    const scheduler = createManualScheduler();
    const livePreset = { temperature: 0.8, nested: { enabled: true } };
    let result = null;
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => ({
            apiId: 'openai',
            presetName: 'Preset B',
            preset: livePreset,
            liveHash: 'hash-b',
            storedHash: 'hash-b',
        }),
        onSettled: value => { result = value; },
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        requiredStableSamples: 1,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();
    livePreset.nested.enabled = false;

    assert.equal(result.preset.nested.enabled, true);
    assert.equal(Object.isFrozen(result.preset.nested), true);
});

test('times out once and leaves uncertain content unsettled', async () => {
    const scheduler = createManualScheduler();
    let now = 0;
    const settled = [];
    const timedOut = [];
    const controller = createPresetSwitchConvergence({
        readCandidate: async () => candidate('Preset B', 'hash-a', 'hash-b'),
        onSettled: value => settled.push(value),
        onTimeout: value => timedOut.push(value),
        schedule: fn => scheduler.schedule(fn),
        cancel: id => scheduler.cancel(id),
        now: () => now,
        timeoutMs: 100,
        requiredStableSamples: 1,
    });

    controller.begin({ apiId: 'openai', presetName: 'Preset B' });
    await scheduler.runNext();
    now = 101;
    await scheduler.runNext();

    assert.equal(settled.length, 0);
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].hint.presetName, 'Preset B');
    assert.equal(controller.isActive(), false);
    assert.equal(scheduler.pending(), 0);
});
