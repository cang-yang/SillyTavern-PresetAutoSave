import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeTimerRegistry } from '../../modules/core/runtime-timers.js';

function fakeClock() {
    let id = 0;
    const callbacks = new Map();
    return {
        setTimeoutFn(callback) {
            const handle = ++id;
            callbacks.set(handle, callback);
            return handle;
        },
        clearTimeoutFn(handle) {
            callbacks.delete(handle);
        },
        run(handle) {
            const callback = callbacks.get(handle);
            if (callback) callback();
        },
        callbacks,
    };
}

test('runtime timer registry removes completed callbacks', () => {
    const clock = fakeClock();
    const registry = new RuntimeTimerRegistry(clock);
    let calls = 0;
    const handle = registry.schedule(() => { calls++; }, 10);

    assert.equal(registry.size, 1);
    clock.run(handle);
    assert.equal(calls, 1);
    assert.equal(registry.size, 0);
});

test('runtime timer registry prevents every stale callback after clearAll', () => {
    const clock = fakeClock();
    const registry = new RuntimeTimerRegistry(clock);
    let calls = 0;
    const first = registry.schedule(() => { calls++; }, 10);
    const second = registry.schedule(() => { calls++; }, 20);

    registry.clearAll();
    clock.run(first);
    clock.run(second);

    assert.equal(calls, 0);
    assert.equal(registry.size, 0);
    assert.equal(clock.callbacks.size, 0);
});

test('runtime timer registry cancels repeating callbacks with the interval clearer', () => {
    const timeoutClock = fakeClock();
    const intervalClock = fakeClock();
    const registry = new RuntimeTimerRegistry({
        setTimeoutFn: timeoutClock.setTimeoutFn,
        clearTimeoutFn: timeoutClock.clearTimeoutFn,
        setIntervalFn: intervalClock.setTimeoutFn,
        clearIntervalFn: intervalClock.clearTimeoutFn,
    });
    let calls = 0;
    const handle = registry.repeat(() => { calls++; }, 10);

    intervalClock.run(handle);
    assert.equal(calls, 1);
    registry.clearAll();
    intervalClock.run(handle);
    assert.equal(calls, 1);
});

test('default browser timers retain their required global receiver', () => {
    const originals = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
    };
    const receiver = globalThis;
    const handles = [];
    try {
        globalThis.setTimeout = function (callback) {
            assert.equal(this, receiver);
            handles.push(callback);
            return handles.length;
        };
        globalThis.clearTimeout = function () { assert.equal(this, receiver); };
        globalThis.setInterval = function (callback) {
            assert.equal(this, receiver);
            handles.push(callback);
            return handles.length;
        };
        globalThis.clearInterval = function () { assert.equal(this, receiver); };

        const registry = new RuntimeTimerRegistry();
        registry.schedule(() => {}, 1);
        registry.repeat(() => {}, 1);
        registry.clearAll();
    } finally {
        Object.assign(globalThis, originals);
    }
});
