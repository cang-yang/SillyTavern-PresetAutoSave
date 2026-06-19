import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPanelHTML } from '../modules/panel-shell.js';

const identity = (value) => String(value);
const html = buildPanelHTML({
    t: (key, vars) => vars ? `${key}:${JSON.stringify(vars)}` : key,
    escapeHtml: identity,
    escapeAttr: identity,
});

test('panel shell exposes an accessible three-tab workspace', () => {
    assert.match(html, /role="tablist"/);
    assert.equal((html.match(/role="tab"/g) || []).length, 3);
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 3);
    assert.match(html, /id="pas-tab-list"[^>]*aria-selected="true"/);
    assert.match(html, /id="pas-panel-logs"[^>]*hidden/);
    assert.match(html, /id="pas-panel-settings"[^>]*hidden/);
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
    assert.equal(manifest.css, 'styles/index.css');
    assert.match(indexCss, /@import url\('\.\.\/style\.css'\)/);
    assert.match(indexCss, /@import url\('\.\/panel-v4\.css'\)/);
    assert.doesNotMatch(panelCss, /\.pas-tab\s+span\s*\{[^}]*display:\s*none/s);
    assert.match(panelCss, /\.pas-tab\s*>\s*span:not\(\.pas-tab-badge\)[\s\S]*?display:\s*inline\s*!important/);
    assert.match(panelCss, /\.pas-filter\s*>\s*span\s*\{\s*display:\s*inline\s*!important/);
    assert.match(panelCss, /min-height:\s*44px/);
    assert.match(panelCss, /--pas-v4-accent:\s*#8b5cf6/);
    assert.doesNotMatch(panelCss, /--pas-v4-accent:\s*var\(--SmartThemeQuoteColor/);
});
