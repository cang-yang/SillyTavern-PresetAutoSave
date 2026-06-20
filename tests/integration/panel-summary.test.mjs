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

test('labels quarantined legacy runtime changes without exposing internal paths', () => {
    const html = renderSummary({
        isFirst: false,
        sections: [],
        rawChangedPaths: [],
        ignoredPaths: ['additional_parameters_by_source.custom.exclude_body'],
        onlyIgnoredChanges: true,
    });

    assert.match(html, /Summary Runtime Only/);
    assert.doesNotMatch(html, /additional_parameters_by_source/);
});

test('labels deliberate same-content snapshots as unchanged', () => {
    const html = renderSummary({ isFirst: false, sections: [], rawChangedPaths: [], unchanged: true });
    assert.match(html, /Summary Unchanged/);
    assert.doesNotMatch(html, /Summary Minor/);
});
