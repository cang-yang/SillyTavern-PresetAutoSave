import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [renderer, panelCss, safetyCss] = await Promise.all([
    readFile(new URL('../modules/panel-list-render.js', import.meta.url), 'utf8'),
    readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8'),
    readFile(new URL('../styles/responsive.css', import.meta.url), 'utf8'),
]);
const snapshotRenderer = await readFile(new URL('../modules/panel-snapshot-card.js', import.meta.url), 'utf8');

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

test('version status and metadata share one secondary row', () => {
    const versionRenderer = renderer.match(/function renderVersionGroup[\s\S]*?\n}\n\nfunction renderShowMoreSnapshots/)?.[0] || '';
    assert.doesNotMatch(versionRenderer, /const tagsRowHtml/);
    assert.match(versionRenderer, /pas-version-header-row-meta[\s\S]*?pas-version-header-tags[\s\S]*?tagsHtml/);
});

test('snapshot cards keep common actions visible and disclose secondary tools', () => {
    assert.match(snapshotRenderer, /pas-card-primary-actions/);
    assert.match(snapshotRenderer, /<details class="pas-card-tools">/);
    assert.match(snapshotRenderer, /<summary[\s\S]*?Panel Tools/);
    assert.match(snapshotRenderer, /pas-card-tools-actions[\s\S]*?pas-btn-rename[\s\S]*?pas-btn-pin[\s\S]*?pas-btn-export-preset[\s\S]*?pas-btn-delete/);
    assert.match(panelCss, /\.pas-card-tools\[open\][\s\S]*?\.pas-card-tools-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(panelCss, /\.pas-card-tools-trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--pas-v4-accent\)/s);
});

test('long history views defer offscreen group layout work', () => {
    assert.match(panelCss, /\.pas-series-group,\s*\n?\s*\.pas-preset-group\s*\{[^}]*content-visibility:\s*auto[^}]*contain-intrinsic-size:\s*auto 56px/s);
    assert.doesNotMatch(panelCss, /@media \(max-width:\s*720px\)[\s\S]*?\.pas-series-group,[\s\S]*?content-visibility:\s*visible/s);
});
