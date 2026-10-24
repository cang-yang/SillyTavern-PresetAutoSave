import test from 'node:test';
import assert from 'node:assert/strict';

import * as statusStore from '../../modules/core/save-status.js';
const { getSaveStatus, setSaveStatus } = statusStore;

test('retains only valid auto-save presentation states', () => {
    setSaveStatus('idle');
    assert.equal(setSaveStatus('saving'), true);
    assert.equal(getSaveStatus(), 'saving');
    assert.equal(setSaveStatus('not-a-state'), false);
    assert.equal(getSaveStatus(), 'saving');
    setSaveStatus('idle');
});

test('status subscriptions publish distinct states, isolate observers, and unsubscribe', () => {
    setSaveStatus('idle');
    const observed = [];
    const broken = statusStore.onSaveStatusChange(() => { throw new Error('observer'); });
    const unsubscribe = statusStore.onSaveStatusChange(state => observed.push(state));
    setSaveStatus('pending');
    setSaveStatus('pending');
    assert.equal(setSaveStatus('partial'), true);
    assert.equal(getSaveStatus(), 'partial');
    unsubscribe();
    broken();
    setSaveStatus('saved');
    assert.deepEqual(observed, ['pending', 'partial']);
});
