import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const autoSaveSource = await readFile(new URL('../../modules/auto-save.js', import.meta.url), 'utf8');
const takeoverSource = await readFile(new URL('../../modules/preset-takeover.js', import.meta.url), 'utf8');

test('auto-save routes every completed switch event through one convergence controller', () => {
    assert.match(autoSaveSource, /createPresetSwitchConvergence/);
    assert.match(autoSaveSource, /beginSwitchConvergence\(/);
    assert.doesNotMatch(autoSaveSource, /function updateTrackingAfterSwitch\s*\(/);
    assert.doesNotMatch(autoSaveSource, /updateTrackingAfterSwitch\(\)/);
});

test('auto-save seeds only from the immutable settled candidate', () => {
    assert.match(
        autoSaveSource,
        /seedSnapshotForPreset\(candidate\.presetName, candidate\.apiId,\s*\{[\s\S]*?preset:\s*candidate\.preset,[\s\S]*?verified:\s*candidate\.verified/,
    );
});

test('preset seeding rejects an unverified payload override', () => {
    assert.match(takeoverSource, /seedSnapshotForPreset\(presetName, apiId, options = \{\}\)/);
    assert.match(takeoverSource, /options\.preset/);
    assert.match(takeoverSource, /options\.verified !== true/);
});
