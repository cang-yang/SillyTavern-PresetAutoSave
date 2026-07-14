import assert from 'node:assert/strict';
import test from 'node:test';

import { handleListClick } from '../modules/panel-actions.js';

function classListStub() {
    return { toggle() {} };
}

test('first series expansion hydrates an empty lazy body before showing it', async () => {
    const body = { childElementCount: 0, hidden: true };
    const chevron = { classList: classListStub() };
    const icon = { classList: classListStub() };
    let group;
    const header = {
        closest: selector => selector === '.pas-series-group' ? group : null,
        setAttribute() {},
    };
    group = {
        getAttribute: name => name === 'data-series-key' ? 'unused-series' : null,
        querySelector(selector) {
            if (selector === ':scope > .pas-series-body') return body;
            if (selector === ':scope > .pas-series-header') return header;
            if (selector === '.pas-series-chevron') return chevron;
            if (selector === '.pas-series-icon') return icon;
            return null;
        },
    };
    const target = {
        closest: selector => selector === '.pas-series-header' ? header : null,
    };
    const state = {
        expandedSeries: new Set(),
        expandedVersions: new Set(),
        expandedPresets: new Set(),
        snapshotRenderLimits: new Map(),
    };
    let renderCount = 0;

    await handleListClick({
        target,
        preventDefault() {},
        stopPropagation() {},
    }, {
        state: () => state,
        renderListTab: () => { renderCount += 1; },
    });

    assert.equal(state.expandedSeries.has('unused-series'), true);
    assert.equal(renderCount, 1, 'the renderer must populate native presets before the body is revealed');
    assert.equal(body.hidden, true, 'the empty placeholder must not be exposed as completed content');
});
