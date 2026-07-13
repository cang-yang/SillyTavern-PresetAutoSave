import test from 'node:test';
import assert from 'node:assert/strict';

import { initLogger, logger, teardownLogger } from '../modules/logger.js';

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
        this.addCalls = [];
        this.removeCalls = [];
    }

    addEventListener(type, handler) {
        this.addCalls.push({ type, handler });
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.removeCalls.push({ type, handler });
        this.listeners.get(type)?.delete(handler);
    }

    dispatch(type, event) {
        for (const handler of this.listeners.get(type) || []) handler(event);
    }
}

test('global logger capture is idempotent and fully reversible', () => {
    teardownLogger();
    logger.clearLogs();
    const target = new FakeEventTarget();

    assert.equal(initLogger(target), true);
    assert.equal(initLogger(target), false);
    assert.deepEqual(target.addCalls.map(call => call.type), ['error', 'unhandledrejection']);

    target.dispatch('error', {
        message: 'extension failed',
        filename: '/scripts/extensions/SillyTavern-PresetAutoSave/index.js',
        lineno: 12,
        colno: 4,
    });
    assert.equal(logger.getLogs({ level: 'error' }).length, 1);

    assert.equal(teardownLogger(), true);
    assert.equal(teardownLogger(), false);
    assert.deepEqual(target.removeCalls.map(call => call.type), ['error', 'unhandledrejection']);

    target.dispatch('error', {
        message: 'must not be captured after teardown',
        filename: '/scripts/extensions/SillyTavern-PresetAutoSave/index.js',
    });
    assert.equal(logger.getLogs({ level: 'error' }).length, 1);
});
