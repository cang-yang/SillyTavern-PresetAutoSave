import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAcceptUserMutation } from '../../modules/core/input-gate.js';

test('user mutations remain observable while a save worker is active', () => {
    assert.equal(shouldAcceptUserMutation({
        enabled: true,
        ignoreInput: false,
        restoreInProgress: false,
        saveInProgress: true,
    }), true);
});

test('user mutations are rejected only for disabled, switching, or restoring states', () => {
    assert.equal(shouldAcceptUserMutation({ enabled: false }), false);
    assert.equal(shouldAcceptUserMutation({ enabled: true, ignoreInput: true }), false);
    assert.equal(shouldAcceptUserMutation({ enabled: true, restoreInProgress: true }), false);
});

test('trusted user input is retained during the post-switch programmatic-event window', () => {
    assert.equal(shouldAcceptUserMutation({
        enabled: true,
        ignoreInput: true,
        userInitiated: true,
    }), true);

    assert.equal(shouldAcceptUserMutation({
        enabled: true,
        ignoreInput: true,
        userInitiated: false,
    }), false);
});
