import test from 'node:test';
import assert from 'node:assert/strict';

import { initThemeDetector, teardownThemeDetector } from '../modules/theme-detector.js';

test('theme detector initialization is idempotent across lifecycle retries', () => {
    const originals = {
        document: globalThis.document,
        getComputedStyle: globalThis.getComputedStyle,
        MutationObserver: globalThis.MutationObserver,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
    };
    let intervalCount = 0;
    let observerCount = 0;
    let disconnected = 0;

    globalThis.document = {
        documentElement: {},
        body: { classList: { toggle() {}, remove() {} } },
    };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' });
    globalThis.setInterval = () => ++intervalCount;
    globalThis.clearInterval = () => {};
    globalThis.MutationObserver = class {
        constructor() { observerCount += 1; }
        observe() {}
        disconnect() { disconnected += 1; }
    };

    try {
        initThemeDetector();
        initThemeDetector();
        assert.equal(intervalCount, 1);
        assert.equal(observerCount, 1);
        teardownThemeDetector();
        assert.equal(disconnected, 1);
    } finally {
        Object.assign(globalThis, originals);
    }
});
