import test from 'node:test';
import assert from 'node:assert/strict';

import { SerialTaskQueue } from '../../modules/core/serial-task-queue.js';

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

test('serial task queue prevents overlapping history mutations', async () => {
    const queue = new SerialTaskQueue();
    const gate = deferred();
    const order = [];
    const first = queue.run(async () => {
        order.push('first-start');
        await gate.promise;
        order.push('first-end');
    });
    const second = queue.run(async () => {
        order.push('second');
    });

    await Promise.resolve();
    assert.deepEqual(order, ['first-start']);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    assert.equal(queue.size, 0);
});

test('serial task queue continues after a failed mutation', async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(async () => { throw new Error('quota'); });
    const healthy = queue.run(async () => 'written');

    await assert.rejects(failed, /quota/);
    assert.equal(await healthy, 'written');
    await queue.whenIdle();
    assert.equal(queue.size, 0);
});

test('serial task queue preserves all 1000 read-modify-write mutations', async () => {
    const queue = new SerialTaskQueue();
    let value = 0;
    const tasks = Array.from({ length: 1000 }, () => queue.run(async () => {
        const current = value;
        await Promise.resolve();
        value = current + 1;
    }));

    await Promise.all(tasks);
    assert.equal(value, 1000);
    assert.equal(queue.size, 0);
});
