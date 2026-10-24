import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSaveCompletion } from '../../modules/core/save-completion.js';

const request = { newHash: 'committed', canonicalContent: '{"temperature":0.1}',
    quickFingerprint: 'old', mutationGeneration: 1, revision: 1 };
test('completion retains the immutable committed baseline when live content advances', () => {
    assert.deepEqual(assessSaveCompletion(request, {
        liveFingerprint: 'new', mutationGeneration: 1, latestRevision: 1,
    }), { committedHash: 'committed', committedFingerprint: 'old',
        committedCanonicalContent: '{"temperature":0.1}', pending: true });
});
test('new mutation generations and submitted revisions keep completion pending', () => {
    for (const state of [{ mutationGeneration: 2, latestRevision: 1 }, { mutationGeneration: 1, latestRevision: 2 }]) {
        assert.equal(assessSaveCompletion(request, { liveFingerprint: 'old', ...state }).pending, true);
    }
});
test('commands without a raw fingerprint verify live canonical content', () => {
    const command = { ...request, quickFingerprint: null };
    const state = { mutationGeneration: 1, latestRevision: 1 };
    assert.equal(assessSaveCompletion(command, { ...state, liveCanonicalContent: command.canonicalContent }).pending, false);
    assert.equal(assessSaveCompletion(command, { ...state, liveCanonicalContent: '{"temperature":0.2}' }).pending, true);
});

test('equal diagnostic hashes cannot hide newer canonical content without a raw fingerprint', () => {
    const command = { ...request, quickFingerprint: null, canonicalContent: '{"send_if_empty":"collision-17327"}' };
    const result = assessSaveCompletion(command, {
        liveHash: command.newHash,
        liveCanonicalContent: '{"send_if_empty":"collision-28051"}',
        mutationGeneration: 1,
        latestRevision: 1,
    });
    assert.equal(result.pending, true);
});
