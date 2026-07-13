import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseFocusCandidate } from '../../modules/core/focus-anchor.js';

test('restores the exact semantic action after list markup is replaced', () => {
    const anchor = {
        action: 'restore', snapshotId: 'snap-2', versionKey: 'openai::Demo', seriesKey: 'Demo',
    };
    const candidates = [
        { action: 'restore', snapshotId: 'snap-1', versionKey: 'openai::Demo', seriesKey: 'Demo' },
        { action: 'restore', snapshotId: 'snap-2', versionKey: 'openai::Demo', seriesKey: 'Demo' },
        { action: 'view', snapshotId: 'snap-2', versionKey: 'openai::Demo', seriesKey: 'Demo' },
    ];

    assert.equal(chooseFocusCandidate(anchor, candidates), candidates[1]);
});

test('falls back through the nearest surviving group when the focused row was removed', () => {
    const anchor = {
        action: 'delete', snapshotId: 'deleted', versionKey: 'openai::Demo', seriesKey: 'Demo',
    };
    const versionHeader = { action: 'toggle-version', versionKey: 'openai::Demo', seriesKey: 'Demo' };
    const seriesHeader = { action: 'toggle-series', seriesKey: 'Demo' };

    assert.equal(chooseFocusCandidate(anchor, [seriesHeader, versionHeader]), versionHeader);
    assert.equal(chooseFocusCandidate(anchor, [seriesHeader]), seriesHeader);
    assert.equal(chooseFocusCandidate(anchor, []), null);
});

test('keeps focus on an injected batch control instead of preferring its group header', () => {
    const anchor = { controlKey: 'data-preset-name:Demo', versionKey: 'openai::Demo', seriesKey: 'Demo' };
    const checkbox = { controlKey: 'data-preset-name:Demo', versionKey: 'openai::Demo', seriesKey: 'Demo' };
    const versionHeader = { action: 'toggle-version', versionKey: 'openai::Demo', seriesKey: 'Demo' };

    assert.equal(chooseFocusCandidate(anchor, [versionHeader, checkbox]), checkbox);
});
