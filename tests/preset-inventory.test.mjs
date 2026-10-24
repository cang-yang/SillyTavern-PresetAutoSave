import test from 'node:test';
import assert from 'node:assert/strict';
import { readPresetInventory } from '../modules/host/preset-inventory.js';

test('inventory keeps host values separate from stable case-sensitive names across APIs', () => {
    const select = (api, names, connected = true) => ({
        isConnected: connected, getAttribute: () => api,
        options: names.map((name, index) => ({ textContent: name, value: String(index) })),
    });
    const selects = [select('openai', ['Same', 'same', 'Same']), select('kobold', ['Same']),
        select('openai', ['Detached'], false)];
    const result = readPresetInventory({ documentObject: { querySelectorAll: () => selects } });
    assert.deepEqual(result.map(({ apiId, presetName, hostValue }) => [apiId, presetName, hostValue]),
        [['openai', 'Same', '0'], ['openai', 'same', '1'], ['kobold', 'Same', '0']]);
    assert.throws(() => { result[0].presetName = 'changed'; }, TypeError);
});

test('inventory missing DOM fails cleanly and API filters remain explicit', () => {
    assert.deepEqual(readPresetInventory({ documentObject: null }), []);
    const select = { isConnected: true, getAttribute: () => 'openai,textgenerationwebui',
        options: [{ textContent: 'Alpha', value: '7' }] };
    const documentObject = { querySelectorAll: () => [select] };
    assert.equal(readPresetInventory({ apiId: 'openai', documentObject }).length, 1);
    assert.equal(readPresetInventory({ apiId: 'kobold', documentObject }).length, 0);
});

test('inventory preserves legal numeric and whitespace-bearing canonical names', () => {
    const select = { isConnected: true, getAttribute: () => 'openai',
        options: ['123', ' A ', 'A'].map(textContent => ({ textContent, value: textContent })) };
    assert.deepEqual(readPresetInventory({ documentObject: { querySelectorAll: () => [select] } })
        .map(item => item.presetName), ['123', ' A ', 'A']);
});
