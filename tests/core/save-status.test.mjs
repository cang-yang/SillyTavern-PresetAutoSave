import test from 'node:test';
import assert from 'node:assert/strict';

import { getSaveStatus, setSaveStatus } from '../../modules/core/save-status.js';

test('retains only valid auto-save presentation states', () => {
    setSaveStatus('idle');
    assert.equal(setSaveStatus('saving'), true);
    assert.equal(getSaveStatus(), 'saving');
    assert.equal(setSaveStatus('not-a-state'), false);
    assert.equal(getSaveStatus(), 'saving');
    setSaveStatus('idle');
});
