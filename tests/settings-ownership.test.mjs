import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS, getSettings, getSetting, getDefault, initSettings,
    updateSetting, onSettingChange, resetSettings,
} from '../modules/settings.js';

let writes = 0;
const extensionSettings = {};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced() { writes++; } }),
};
await initSettings();

test('public settings snapshots are deeply immutable and cached until an actual update', () => {
    const initial = getSettings();
    assert.equal(getSettings(), initial);
    assert.throws(() => { initial.groupingSeriesAliases.story = 'mutation'; }, TypeError);
    assert.throws(() => { getSetting('groupingTree').story = 'parent'; }, TypeError);
    assert.throws(() => { DEFAULT_SETTINGS.groupingTree.story = 'parent'; }, TypeError);
    const mutableDefault = getDefault('groupingTree');
    mutableDefault.story = 'parent';
    assert.deepEqual(DEFAULT_SETTINGS.groupingTree, {});
    const before = writes;
    assert.equal(updateSetting('groupingSeriesAliases', { story: 'Creative' }), true);
    assert.notEqual(getSettings(), initial);
    assert.equal(initial.groupingSeriesAliases.story, undefined);
    const updated = getSettings();
    assert.equal(updateSetting('groupingSeriesAliases', { story: 'Creative' }), false);
    assert.equal(getSettings(), updated);
    assert.equal(writes, before + 1);
});

test('listener values cannot mutate stored settings or later notifications', () => {
    let observed;
    const stopFirst = onSettingChange(event => {
        try { event.newValue.story = 'tampered'; } catch (_) {}
    });
    const stopSecond = onSettingChange(event => { observed = event.newValue; });
    try {
        updateSetting('groupingSeriesAliases', { story: 'Storytelling' });
        assert.equal(getSettings().groupingSeriesAliases.story, 'Storytelling');
        assert.equal(observed.story, 'Storytelling');
        assert.notEqual(observed, extensionSettings.preset_auto_save.groupingSeriesAliases);
    } finally {
        stopFirst(); stopSecond();
    }
});

test('setting maps preserve prototype-shaped names as literal own keys', () => {
    const input = JSON.parse('{"__proto__":"Parent","constructor":"Named","toString":"Literal"}');
    for (const key of ['groupingSeriesAliases', 'groupingManualOverrides', 'groupingTree', 'seriesDefaultApply']) {
        updateSetting(key, input);
        assert.deepEqual(getSettings()[key], input);
        assert.equal(Object.getPrototypeOf(getSettings()[key]), Object.prototype);
    }
});

test('resetting already default settings is a no-op for persistence and revision', () => {
    resetSettings();
    const before = writes;
    const state = getSettings();
    resetSettings();
    assert.equal(writes, before);
    assert.equal(getSettings(), state);
});
