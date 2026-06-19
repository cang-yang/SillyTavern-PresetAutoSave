import test from 'node:test';
import assert from 'node:assert/strict';

import { getDeferredSaveDelay } from '../../modules/core/deferred-save.js';

test('defers beyond the active suspension window', () => {
    assert.equal(getDeferredSaveDelay({
        now: 1_000,
        suspendUntil: 5_000,
        ignoreInput: true,
        ignoreFallbackMs: 2_500,
        safetyMs: 50,
    }), 4_050);
});

test('uses the ignore fallback when the switch event has not set suspension yet', () => {
    assert.equal(getDeferredSaveDelay({
        now: 1_000,
        suspendUntil: 0,
        ignoreInput: true,
        ignoreFallbackMs: 2_500,
        safetyMs: 50,
    }), 2_550);
});
