import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_SETTINGS,
    getSettings,
    initSettings,
    resetSettings,
    updateSetting,
} from '../modules/settings.js';

test('resetSettings gives mutable settings fresh nested defaults', async () => {
    let saveCalls = 0;
    const extensionSettings = {
        preset_auto_save: {
            ...structuredClone(DEFAULT_SETTINGS),
            groupingSeriesAliases: { story: 'Creative' },
        },
    };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings,
            saveSettingsDebounced() { saveCalls += 1; },
        }),
    };

    await initSettings();
    assert.equal(saveCalls, 0, 'valid settings should not be rewritten during startup');
    resetSettings();

    const aliases = getSettings().groupingSeriesAliases;
    assert.deepEqual(aliases, {});
    assert.equal(updateSetting('groupingSeriesAliases', {}), false);
    assert.equal(saveCalls, 1, 'an equivalent map should not trigger another write');
    aliases.story = 'Changed after reset';
    assert.deepEqual(DEFAULT_SETTINGS.groupingSeriesAliases, {});
    assert.notEqual(aliases, DEFAULT_SETTINGS.groupingSeriesAliases);
});
