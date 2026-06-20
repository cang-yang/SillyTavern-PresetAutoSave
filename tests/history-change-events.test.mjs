import test from 'node:test';
import assert from 'node:assert/strict';

import {
    emitHistoryChange,
    onHistoryChange,
} from '../modules/core/history-change-events.js';

test('notifies subscribers and supports teardown', () => {
    const received = [];
    const unsubscribe = onHistoryChange(change => received.push(change));

    emitHistoryChange({ type: 'snapshot-added', snapshotId: 'snap-1' });
    unsubscribe();
    emitHistoryChange({ type: 'snapshot-added', snapshotId: 'snap-2' });

    assert.deepEqual(received, [
        { type: 'snapshot-added', snapshotId: 'snap-1' },
    ]);
});

test('one broken subscriber does not prevent the remaining subscribers', () => {
    const received = [];
    const stopBroken = onHistoryChange(() => { throw new Error('broken listener'); });
    const stopHealthy = onHistoryChange(change => received.push(change.type));

    assert.doesNotThrow(() => emitHistoryChange({ type: 'history-imported' }));
    assert.deepEqual(received, ['history-imported']);

    stopBroken();
    stopHealthy();
});
