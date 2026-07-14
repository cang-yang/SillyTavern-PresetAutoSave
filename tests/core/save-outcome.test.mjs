import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { classifyCoordinatorResult } from '../../modules/core/save-outcome.js';

test('classifies committed snapshots and explicit unchanged results', () => {
    const snapshot = { id: 'snapshot-1' };
    assert.deepEqual(classifyCoordinatorResult({ status: 'committed', value: snapshot }), {
        status: 'committed',
        snapshot,
    });
    assert.deepEqual(classifyCoordinatorResult({ status: 'committed', value: null }), {
        status: 'unchanged',
    });
});

test('distinguishes partial persistence from an uncommitted failure', () => {
    const partialError = Object.assign(new Error('history failed'), {
        diskCommitted: true,
        historyCommitted: false,
    });
    const failedError = new Error('disk failed');

    assert.equal(classifyCoordinatorResult({ status: 'failed', error: partialError }).status, 'partial');
    assert.equal(classifyCoordinatorResult({ status: 'failed', error: failedError }).status, 'failed');
});

test('preserves coordinator cancellation and supersession outcomes', () => {
    assert.deepEqual(classifyCoordinatorResult({ status: 'cancelled' }), { status: 'cancelled' });
    assert.deepEqual(classifyCoordinatorResult({ status: 'superseded' }), { status: 'superseded' });
});

test('manual snapshot UI only describes an explicit unchanged outcome as skipped', async () => {
    const autoSaveSource = await readFile(new URL('../../modules/auto-save.js', import.meta.url), 'utf8');
    const panelSource = await readFile(new URL('../../modules/panel-settings-log.js', import.meta.url), 'utf8');

    assert.match(autoSaveSource, /export async function saveNowDetailed/);
    assert.match(panelSource, /outcome\.status === 'unchanged'[\s\S]*?Snapshot Skipped/);
    assert.match(panelSource, /outcome\.status === 'failed' \|\| outcome\.status === 'partial'/);
});
