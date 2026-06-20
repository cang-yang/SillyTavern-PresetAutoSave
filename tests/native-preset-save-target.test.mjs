import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNativePresetSaveTarget } from '../modules/core/native-preset-save-target.js';

test('uses the active runtime API for the active preset', () => {
    assert.deepEqual(resolveNativePresetSaveTarget(
        { apiId: 'kobold', name: 'RecoveredRuins' },
        { apiId: 'koboldhorde', presetName: 'RecoveredRuins' },
    ), { apiId: 'koboldhorde', presetName: 'RecoveredRuins' });
});

test('keeps the request API when the save is not for the active preset', () => {
    assert.deepEqual(resolveNativePresetSaveTarget(
        { apiId: 'openai', name: 'Another preset' },
        { apiId: 'koboldhorde', presetName: 'RecoveredRuins' },
    ), { apiId: 'openai', presetName: 'Another preset' });
});
