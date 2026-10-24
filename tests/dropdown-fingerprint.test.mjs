import test from 'node:test';
import assert from 'node:assert/strict';
import * as inventory from '../modules/host/preset-inventory.js';

test('dropdown fingerprint observes every name, host value, and disabled state', () => {
    const select = { id: 'presets', value: '0', getAttribute: () => 'openai',
        options: Array.from({ length: 8 }, (_, index) => ({
            value: String(index), textContent: `Preset ${index}`, disabled: false,
        })) };
    const initial = inventory.fingerprintPresetSelect(select);
    select.options[1].textContent = 'Changed';
    const renamed = inventory.fingerprintPresetSelect(select);
    assert.notEqual(renamed, initial);
    select.options[1].value = 'different';
    const revalued = inventory.fingerprintPresetSelect(select);
    assert.notEqual(revalued, renamed);
    select.options[1].disabled = true;
    assert.notEqual(inventory.fingerprintPresetSelect(select), revalued);
});
