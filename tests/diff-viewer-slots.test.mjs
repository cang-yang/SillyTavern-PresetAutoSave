import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDiffPopupHTML, resolveDiffSides } from '../modules/diff-viewer.js';

test('diff viewer preserves the explicit A and B slots regardless of timestamp order', () => {
    const selectedA = { id: 'newer-a', timestamp: 200, preset: { temperature: 0.7 } };
    const selectedB = { id: 'older-b', timestamp: 100, preset: { temperature: 0.5 } };

    const sides = resolveDiffSides(selectedA, selectedB);

    assert.equal(sides.a, selectedA);
    assert.equal(sides.b, selectedB);
});

test('compact diff toolbar keeps explicit accessible names when labels are visually hidden', () => {
    const snapshot = (id, timestamp) => ({
        id,
        timestamp,
        presetName: 'demo',
        preset: {},
        size: 0,
        hash: id,
    });

    const html = buildDiffPopupHTML(snapshot('a', 100), snapshot('b', 200));

    for (const label of [
        'Diff Swap Title',
        'Diff Export Title',
        'Export Preset A Title',
        'Export Preset B Title',
    ]) {
        assert.match(html, new RegExp(`aria-label="${label}"`));
    }
});
