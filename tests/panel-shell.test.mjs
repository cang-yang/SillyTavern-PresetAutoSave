import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPanelHTML } from '../modules/panel-shell.js';

const identity = (value) => String(value);
const historyPanelSource = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');
const html = buildPanelHTML({
    t: (key, vars) => vars ? `${key}:${JSON.stringify(vars)}` : key,
    escapeHtml: identity,
    escapeAttr: identity,
});

test('history panel uses the pure shell renderer as its single markup path', () => {
    assert.match(historyPanelSource, /buildPanelHTML as buildPanelShellHTML/);
    assert.match(historyPanelSource, /function buildHistoryPanelMarkup\(\)[\s\S]*?return buildPanelShellHTML\(/);
    assert.match(historyPanelSource, /const html = buildHistoryPanelMarkup\(\)/);
    assert.doesNotMatch(historyPanelSource, /function buildPanelHTML\(/);
    assert.doesNotMatch(historyPanelSource, /pas-footer-actions/);
});

test('panel shell exposes an accessible three-tab workspace', () => {
    assert.match(html, /role="tablist"/);
    assert.equal((html.match(/role="tab"/g) || []).length, 3);
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 3);
    assert.match(html, /id="pas-tab-list"[^>]*aria-selected="true"/);
    assert.match(html, /id="pas-panel-logs"[^>]*hidden/);
    assert.match(html, /id="pas-panel-settings"[^>]*hidden/);
});

test('panel shell renders the current save state instead of a fixed ready claim', () => {
    const saving = buildPanelHTML({
        t: (key) => key,
        escapeHtml: identity,
        escapeAttr: identity,
        saveStatus: 'saving',
        saveStatusLabel: 'Saving now',
    });

    assert.match(saving, /class="pas-status-dot pas-status-saving"[^>]*data-status="saving"/);
    assert.match(saving, /data-pas-status-label>Saving now<\/span>/);
    assert.doesNotMatch(saving, />Auto Save Ready<\/span>/);
});

test('secondary actions live in one closed tools menu', () => {
    assert.match(html, /class="pas-tools-trigger"[^>]*aria-expanded="false"/);
    assert.match(html, /id="pas-tools-menu"[^>]*role="menu" hidden/);
    for (const hook of ['pas-btn-batch-toggle', 'pas-btn-manage-grouping', 'pas-btn-export', 'pas-btn-import', 'pas-btn-cleanup', 'pas-btn-purge']) {
        assert.match(html, new RegExp(`class="[^"]*${hook}`));
    }
    assert.doesNotMatch(html, /pas-footer-actions/);
});

test('contextual UI starts collapsed and markup contains no mojibake sentinel', () => {
    assert.match(html, /id="pas-diff-bar" hidden/);
    assert.match(html, /id="pas-footer-stats">—</);
    assert.doesNotMatch(html, /鈥\?/);
});

test('manifest loads the layered panel stylesheet and mobile keeps tab labels', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const indexCss = await readFile(new URL('../styles/index.css', import.meta.url), 'utf8');
    const panelCss = await readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8');
    const responsiveCss = await readFile(new URL('../styles/responsive.css', import.meta.url), 'utf8');
    const panelRenderer = await readFile(new URL('../modules/panel-list-render.js', import.meta.url), 'utf8');
    const snapshotCardRenderer = await readFile(new URL('../modules/panel-snapshot-card.js', import.meta.url), 'utf8');
    assert.equal(manifest.css, 'styles/index.css');
    assert.match(indexCss, /@import url\('\.\.\/style\.css'\)/);
    assert.match(indexCss, /@import url\('\.\/panel-v4\.css'\)/);
    assert.match(indexCss, /@import url\('\.\/panel-v4\.css'\);[\s\S]*@import url\('\.\/responsive\.css'\)/);
    assert.doesNotMatch(panelCss, /\.pas-tab\s+span\s*\{[^}]*display:\s*none/s);
    assert.doesNotMatch(panelCss, /\.pas-(?:primary-action|tools-trigger)\s+span\s*\{[^}]*display:\s*none/s);
    assert.doesNotMatch(panelCss, /\.pas-view-btn\s+span\s*\{[^}]*display:\s*none/s);
    assert.match(panelCss, /\.pas-tab\s*>\s*span:not\(\.pas-tab-badge\)[\s\S]*?display:\s*inline\s*!important/);
    assert.match(panelCss, /\.pas-filter\s*>\s*span\s*\{\s*display:\s*inline\s*!important/);
    assert.match(panelCss, /min-height:\s*44px/);
    assert.match(panelCss, /--pas-v4-accent:\s*#8b5cf6/);
    assert.match(panelCss, /--pas-v4-current:\s*#f59e0b/);
    assert.match(panelCss, /\.pas-version-group\.pas-version-current[\s\S]*?var\(--pas-v4-current\)/);
    assert.match(panelCss, /content-visibility:\s*visible/);
    assert.match(panelCss, /height:\s*100svh\s*!important/);
    assert.match(panelCss, /@media \(hover:\s*none\), \(pointer:\s*coarse\)/);
    assert.match(responsiveCss, /@media \(max-width:\s*768px\)[\s\S]*?\.pas-panel \.pas-tab > span:not\(\.pas-tab-badge\)[\s\S]*?display:\s*inline\s*!important/);
    assert.match(responsiveCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-panel button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
    assert.match(responsiveCss, /\.pas-panel \.pas-card-actions,[\s\S]*?flex-wrap:\s*wrap/);
    assert.match(responsiveCss, /\.pas-panel \.pas-log-actions \.pas-mini-btn\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
    assert.match(panelRenderer, /pas-series-current-node/);
    for (const action of ['pas-btn-rename', 'pas-btn-pin', 'pas-btn-restore', 'pas-btn-view', 'pas-btn-export-preset', 'pas-btn-delete', 'pas-btn-clear-preset', 'pas-btn-apply-version', 'pas-version-delete-btn']) {
        assert.match(snapshotCardRenderer + panelRenderer, new RegExp(`${action}[\\s\\S]{0,420}pas-action-label`));
    }
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-action-label\s*\{[^}]*display:\s*inline/s);
    assert.doesNotMatch(panelCss, /--pas-v4-accent:\s*var\(--SmartThemeQuoteColor/);
});

test('mobile workspace keeps controls dense without wrapping or starving log messages', async () => {
    const panelCss = await readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8');

    assert.match(panelCss, /\.pas-panel\s*\{[\s\S]*?gap:\s*0;/);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-panel-header\s*\{[^}]*padding:\s*8px 12px/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-panel-tabs\s*\{[^}]*margin:\s*0 10px[^}]*padding:\s*2px/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-toolbar\s*\{[^}]*gap:\s*6px[^}]*padding-bottom:\s*6px/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-search-wrap input\.text_pole\s*\{[^}]*margin:\s*0/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-filters\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-log-toolbar\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-log-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/s);
    assert.match(panelCss, /@media \(max-width:\s*460px\)[\s\S]*?\.pas-log-msg\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    assert.match(panelCss, /@media \(max-width:\s*360px\)/);
});
