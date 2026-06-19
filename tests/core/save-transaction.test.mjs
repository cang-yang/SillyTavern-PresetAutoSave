import test from 'node:test';
import assert from 'node:assert/strict';

import { commitPresetSave, PresetSaveTransactionError } from '../../modules/core/save-transaction.js';

test('persists the SillyTavern preset before committing history', async () => {
    const calls = [];
    const result = await commitPresetSave({ id: 'request' }, {
        persistPreset: async () => calls.push('disk'),
        syncMemory: async () => calls.push('memory'),
        commitHistory: async () => { calls.push('history'); return { id: 'snapshot' }; },
    });

    assert.deepEqual(calls, ['disk', 'memory', 'history']);
    assert.equal(result.snapshot.id, 'snapshot');
    assert.equal(result.diskCommitted, true);
    assert.equal(result.historyCommitted, true);
});

test('a disk failure creates no history record', async () => {
    let historyCalls = 0;
    await assert.rejects(() => commitPresetSave({}, {
        persistPreset: async () => { throw new Error('disk failed'); },
        syncMemory: async () => {},
        commitHistory: async () => { historyCalls++; },
    }), /disk failed/);
    assert.equal(historyCalls, 0);
});

test('reports a partial transaction when history fails after disk commit', async () => {
    await assert.rejects(() => commitPresetSave({}, {
        persistPreset: async () => {},
        syncMemory: async () => {},
        commitHistory: async () => { throw new Error('history failed'); },
    }), error => {
        assert.equal(error instanceof PresetSaveTransactionError, true);
        assert.equal(error.diskCommitted, true);
        assert.equal(error.historyCommitted, false);
        assert.match(error.cause.message, /history failed/);
        return true;
    });
});

test('treats unchanged-history deduplication as a successful disk transaction', async () => {
    const result = await commitPresetSave({}, {
        persistPreset: async () => {},
        syncMemory: async () => {},
        commitHistory: async () => null,
    });
    assert.equal(result.diskCommitted, true);
    assert.equal(result.historyCommitted, true);
    assert.equal(result.snapshot, null);
});
