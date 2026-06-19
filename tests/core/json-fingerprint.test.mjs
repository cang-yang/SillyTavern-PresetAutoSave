import test from 'node:test';
import assert from 'node:assert/strict';

import { createJsonFingerprint } from '../../modules/core/json-fingerprint.js';

test('quick fingerprints detect same-length scalar changes', () => {
    const before = createJsonFingerprint({ enabled: true, mode: 'alpha' });
    const after = createJsonFingerprint({ enabled: false, mode: 'bravo' });

    assert.notEqual(before, after);
});

test('quick fingerprints detect nested and extension changes', () => {
    const before = createJsonFingerprint({
        prompts: [{ identifier: 'main', enabled: true }],
        extensions: { sample: { mode: 'safe' } },
    });
    const after = createJsonFingerprint({
        prompts: [{ identifier: 'main', enabled: false }],
        extensions: { sample: { mode: 'fast' } },
    });

    assert.notEqual(before, after);
});

test('quick fingerprints are deterministic for an unchanged live object', () => {
    const live = { temperature: 0.7, prompts: [{ name: 'A', content: 'hello' }] };
    assert.equal(createJsonFingerprint(live), createJsonFingerprint(live));
});

test('quick fingerprints fail closed for non-serializable values', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(createJsonFingerprint(cyclic), null);
});
