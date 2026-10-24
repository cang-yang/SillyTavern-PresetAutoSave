import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initCompatibility, on, off, offAll } from '../modules/compatibility.js';

function emitter() {
    const listeners = new Map();
    return {
        listeners,
        on(name, handler) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(handler);
        },
        off(name, handler) { listeners.get(name)?.delete(handler); },
    };
}

test('event disposers detach from their original emitter after host context replacement', () => {
    const first = emitter();
    const second = emitter();
    let active = first;
    globalThis.window = globalThis;
    globalThis.document = { querySelector: () => null, getElementById: () => null };
    globalThis.SillyTavern = { getContext: () => ({ eventSource: active }) };
    initCompatibility();
    const handler = () => {};
    const dispose = on('first', handler);
    on('second', handler);
    on('third', handler);
    assert.equal(first.listeners.size, 3, 'fixture must actually install all listeners');
    active = second;
    dispose();
    off('second', handler);
    offAll();
    assert.equal([...first.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
    assert.equal(second.listeners.size, 0);
});
