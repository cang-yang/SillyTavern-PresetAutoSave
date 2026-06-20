import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_WATCH_SELECTORS, isInsidePresetWatchArea } from '../modules/core/preset-dom-watch.js';

test('common generation controls participate in preset auto-save feedback', () => {
    assert.ok(PRESET_WATCH_SELECTORS.includes('#common-gen-settings-block'));

    const visited = [];
    const element = {
        closest(selector) {
            visited.push(selector);
            return selector === '#common-gen-settings-block' ? { id: 'common-gen-settings-block' } : null;
        },
    };
    assert.equal(isInsidePresetWatchArea(element), true);
    assert.ok(visited.includes('#common-gen-settings-block'));
});

test('unrelated chat inputs remain outside preset observation', () => {
    assert.equal(isInsidePresetWatchArea({ closest: () => null }), false);
    assert.equal(isInsidePresetWatchArea(null), false);
});
