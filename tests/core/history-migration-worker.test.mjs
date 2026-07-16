import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryMigrationWorker } from '../../modules/core/history-migration-worker.js';

function createManualClock() {
    let nextId = 0;
    const timers = new Map();
    return {
        setTimer(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        async runNext() {
            const next = timers.entries().next().value;
            if (!next) return false;
            const [id, timer] = next;
            timers.delete(id);
            await timer.callback();
            return timer.delay;
        },
        get delays() {
            return [...timers.values()].map(timer => timer.delay);
        },
        get size() {
            return timers.size;
        },
    };
}

test('migration work stays outside the caller path and processes one bucket per turn', async () => {
    const clock = createManualClock();
    const calls = [];
    const migrated = [];
    const worker = createHistoryMigrationWorker({
        migrateKey: async key => {
            calls.push(key);
            return { status: 'migrated', snapshots: [{ id: key }] };
        },
        onMigrated: async (key, snapshots) => migrated.push([key, snapshots[0].id]),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        initialDelayMs: 1_000,
    });

    worker.enqueue(['a', 'b']);

    assert.deepEqual(calls, []);
    assert.deepEqual(clock.delays, [1_000]);
    assert.equal(await clock.runNext(), 1_000);
    assert.deepEqual(calls, ['a']);
    assert.deepEqual(migrated, [['a', 'a']]);
    assert.equal(await clock.runNext(), 0);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(migrated, [['a', 'a'], ['b', 'b']]);
    assert.equal(clock.size, 0);
});

test('failed migrations use exponential backoff instead of retrying on each enqueue', async () => {
    const clock = createManualClock();
    let attempts = 0;
    const worker = createHistoryMigrationWorker({
        migrateKey: async () => {
            attempts++;
            return attempts < 3
                ? { status: 'failed', snapshots: [] }
                : { status: 'migrated', snapshots: [{ id: 'done' }] };
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        initialDelayMs: 1_000,
        baseRetryMs: 30_000,
        maxRetryMs: 60_000,
    });

    worker.enqueue(['legacy']);
    await clock.runNext();
    assert.equal(attempts, 1);
    assert.deepEqual(clock.delays, [30_000]);

    worker.enqueue(['legacy']);
    assert.deepEqual(clock.delays, [30_000], 'duplicate panel opens must not bypass backoff');

    await clock.runNext();
    assert.deepEqual(clock.delays, [0]);
    await clock.runNext();
    assert.equal(attempts, 2);
    assert.deepEqual(clock.delays, [60_000]);
    await clock.runNext();
    await clock.runNext();
    assert.equal(attempts, 3);
    assert.equal(clock.size, 0);
});

test('closing the worker cancels pending migration work', async () => {
    const clock = createManualClock();
    let attempts = 0;
    const worker = createHistoryMigrationWorker({
        migrateKey: async () => {
            attempts++;
            return { status: 'migrated', snapshots: [] };
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    worker.enqueue(['legacy']);
    worker.close();

    assert.equal(clock.size, 0);
    assert.equal(attempts, 0);
});

test('closing the worker prevents a failing active migration from scheduling a retry', async () => {
    const clock = createManualClock();
    let rejectMigration;
    const worker = createHistoryMigrationWorker({
        migrateKey: () => new Promise((_, reject) => {
            rejectMigration = reject;
        }),
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    worker.enqueue(['legacy']);
    const activeTurn = clock.runNext();
    await Promise.resolve();

    const close = worker.close();
    rejectMigration(new Error('migration failed during shutdown'));
    await Promise.all([activeTurn, close]);

    assert.equal(clock.size, 0);
});
