import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [renderer, panelCss, safetyCss] = await Promise.all([
    readFile(new URL('../modules/panel-list-render.js', import.meta.url), 'utf8'),
    readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8'),
    readFile(new URL('../styles/responsive.css', import.meta.url), 'utf8'),
]);

test('collapsed version rows do not carry the contextual action strip', () => {
    const versionRenderer = renderer.match(/function renderVersionGroup[\s\S]*?\n}\n\nfunction renderShowMoreSnapshots/)?.[0] || '';
    const header = versionRenderer.match(/<div class="pas-version-header"[\s\S]*?<div class="pas-version-body"/)?.[0] || '';
    const body = versionRenderer.match(/<div class="pas-version-body"[\s\S]*?<\/div>\s*<\/div>`/)?.[0] || '';

    assert.doesNotMatch(header, /pas-version-meta-actions/);
    assert.match(versionRenderer, /const versionActionsHtml = `<div class="pas-version-actions"/);
    assert.match(body, /isExpanded \? versionActionsHtml : ''/);
});

test('compact safety styles size named primary controls instead of every button', () => {
    assert.doesNotMatch(safetyCss, /\.pas-panel\s+button\s*\{[\s\S]*?min-height:\s*44px/);
    assert.doesNotMatch(safetyCss, /\.pas-panel\s+\[role="button"\]\s*\{[\s\S]*?min-height:\s*44px/);
    assert.match(safetyCss, /\.pas-primary-action/);
    assert.match(safetyCss, /\.pas-series-header/);
    assert.match(safetyCss, /\.pas-btn-apply-version/);
});

test('compact history filters stay in one scrollable row instead of a two-row grid', () => {
    const compactCss = panelCss.match(/@media \(max-width: 460px\) \{[\s\S]*?\r?\n}\r?\n\r?\n@media \(max-width: 360px\)/)?.[0] || '';
    const filterRule = compactCss.match(/#pas-panel-list\s*>\s*\.pas-toolbar\s*>\s*\.pas-filters\s*\{([^}]*)}/)?.[1] || '';
    const filterItemRule = compactCss.match(/#pas-panel-list\s*>\s*\.pas-toolbar\s*>\s*\.pas-filters\s+\.pas-filter\s*\{([^}]*)}/)?.[1] || '';
    assert.doesNotMatch(filterRule, /grid-template-columns/);
    assert.match(filterRule, /overflow-x:\s*auto/);
    assert.match(filterItemRule, /white-space:\s*nowrap/);
});
