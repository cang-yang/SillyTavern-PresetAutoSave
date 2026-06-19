import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
    SillyTavern: {
        libs: {},
        getContext: () => ({}),
    },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;

const { renderSummary } = await import('../../modules/panel-summary.js');

test('renders concrete changed paths instead of an unexplained minor-change label', () => {
    const html = renderSummary({
        isFirst: false,
        sections: [],
        counts: {},
        rawChangedPaths: ['extensions.foo.enabled'],
    });

    assert.match(html, /extensions\.foo\.enabled/);
    assert.doesNotMatch(html, /Summary Minor/);
});
