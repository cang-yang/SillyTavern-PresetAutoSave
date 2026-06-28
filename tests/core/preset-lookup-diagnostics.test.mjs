import test from 'node:test';
import assert from 'node:assert/strict';

import { describePresetLookup } from '../../modules/core/preset-lookup-diagnostics.js';

test('describePresetLookup identifies exact object-map hits', () => {
    const result = describePresetLookup({
        preset_names: { Alpha: 0, Beta: 1 },
        presets: [{ temperature: 0.7 }, { temperature: 0.9 }],
    }, 'Beta', 'Alpha');

    assert.equal(result.namesShape, 'object');
    assert.equal(result.exactIndex, 1);
    assert.equal(result.hasPresetAtIndex, true);
    assert.equal(result.presetData.usable, true);
});

test('describePresetLookup exposes whitespace-only name mismatches', () => {
    const result = describePresetLookup({
        preset_names: { 'Preset A ': 0 },
        presets: [{ temperature: 0.7 }],
    }, 'Preset A', 'Other');

    assert.equal(result.exactIndex, undefined);
    assert.equal(result.trimmedIndex, 0);
    assert.equal(result.hasPresetAtIndex, false);
});

test('describePresetLookup distinguishes invalid index from empty preset data', () => {
    const invalidIndex = describePresetLookup({
        preset_names: { Broken: 4 },
        presets: [{ temperature: 0.7 }],
    }, 'Broken');
    assert.equal(invalidIndex.exactIndex, 4);
    assert.equal(invalidIndex.hasPresetAtIndex, false);
    assert.equal(invalidIndex.presetData.kind, 'undefined');

    const emptyData = describePresetLookup({
        preset_names: ['Empty'],
        presets: [{}],
    }, 'Empty');
    assert.equal(emptyData.exactIndex, 0);
    assert.equal(emptyData.hasPresetAtIndex, true);
    assert.equal(emptyData.presetData.kind, 'object');
    assert.equal(emptyData.presetData.usable, false);
});
