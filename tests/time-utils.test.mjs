import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTime } from '../modules/time-utils.js';

test('formatTime uses a stable placeholder for missing or invalid timestamps', () => {
    assert.equal(formatTime(null), '—');
    assert.equal(formatTime(0), '—');
    assert.equal(formatTime('not-a-date'), '—');
    assert.equal(formatTime(Number.NaN), '—');
});

test('formatTime never leaks NaN components for an invalid Date value', () => {
    assert.doesNotMatch(formatTime('2026-99-99'), /NaN/);
});
