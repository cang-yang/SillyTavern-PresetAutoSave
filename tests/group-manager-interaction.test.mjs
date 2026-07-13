import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../modules/panel-group-manager.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('the modern group manager renderer is the single active markup path', () => {
    assert.match(source, /function renderModernGroupingHTML/);
    assert.doesNotMatch(source, /function renderGroupingHTML/);
    assert.doesNotMatch(source, /function renderNestedGroupingHTML/);
    assert.doesNotMatch(source, /renderGroupingHTML,|renderNestedGroupingHTML,/);
});

test('nested groups expose parent context and visible tree connectors', () => {
    assert.match(source, /parentName: parent\?\.displayName/);
    assert.match(source, /pas-gm-tree-relation/);
    assert.match(source, /--pas-gm-depth:/);
    assert.match(css, /\.pas-gm-list > \.pas-gm-nested::before/);
    assert.match(css, /border-bottom-left-radius/);
});

test('group cards accept presets and persist hover expansion', () => {
    assert.match(source, /_gmExpandedKeys\.add\(key\)/);
    assert.match(source, /_gmHoverExpander\.schedule\(key/);
    assert.match(source, /data\.type === 'item'.*performMove\(data\.presetName, targetKey/s);
    assert.match(source, /data-drop-label=.*Grouping Drag Hint/);
    assert.match(css, /content: attr\(data-drop-label\)/);
});

test('group names expose an accessible inline rename interaction', () => {
    assert.match(source, /pas-gm-rename-btn/);
    assert.match(source, /pas-gm-name-input/);
    assert.match(source, /aria-describedby=/);
    assert.match(source, /compositionstart/);
    assert.match(source, /Grouping Restore Automatic Name/);
    assert.match(css, /\.pas-gm-rename-btn/);
    assert.match(css, /min-(?:width|height):\s*44px/);
});

test('the rename pencil becomes an explicit confirm button while editing', () => {
    assert.match(source, /data-editing/);
    assert.match(source, /fa-check/);
    assert.match(source, /pas-gm-confirm-rename/);
    assert.match(source, /controller\.commit\(input\.value\)/);
    assert.match(source, /Grouping Confirm Rename/);
    assert.match(css, /\.pas-gm-rename-btn\.is-confirm/);
});

test('expanded groups expose applicable secondary actions outside the compact header', () => {
    const mobileActionMarkup = source.match(/const mobileActions = \[([\s\S]*?)\]\.filter\(Boolean\)\.join\(''\);/)?.[1] || '';
    assert.match(source, /pas-gm-mobile-actions/);
    assert.match(mobileActionMarkup, /nestingEnabled && !depthExceeded[\s\S]*data-action="subgroup"/);
    assert.match(mobileActionMarkup, /node\.customized[\s\S]*data-action="restore-name"/);
    assert.match(mobileActionMarkup, /data-action="delete"/);
    assert.doesNotMatch(mobileActionMarkup, /data-action="rename"/);
});

test('mobile group actions reuse existing group operations', () => {
    const start = source.indexOf('function bindMobileGroupActions');
    const end = source.indexOf('function bindGroupingEvents', start);
    const mobileBindings = source.slice(start, end);
    assert.match(source, /bindMobileGroupActions/);
    assert.match(mobileBindings, /action === 'subgroup'[\s\S]*onCreateSubGroup/);
    assert.match(mobileBindings, /action === 'restore-name'[\s\S]*restoreGroupAlias/);
    assert.match(mobileBindings, /action === 'delete'[\s\S]*onDeleteCustomGroup/);
});

test('compact layout trades the overflow trigger for touch-safe labeled actions', () => {
    assert.match(css, /\.pas-gm-mobile-actions\s*\{[^}]*display:\s*none/s);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pas-gm-series-menu-btn\s*\{[^}]*display:\s*none/s);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pas-gm-mobile-actions\s*\{[^}]*display:\s*flex/s);
    assert.match(css, /\.pas-gm-mobile-actions button\s*\{[^}]*min-height:\s*44px/s);
});

test('organization changes expose session undo and redo controls', () => {
    assert.match(source, /pas-gm-undo-btn/);
    assert.match(source, /pas-gm-redo-btn/);
    assert.match(source, /undoOrganizationChange/);
    assert.match(source, /redoOrganizationChange/);
    assert.match(source, /recordOrganizationChange/);
    assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
    assert.match(source, /wantsUndo/);
    assert.match(source, /wantsRedo/);
    assert.match(css, /\.pas-gm-history-status/);
    assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.pas-gm-header-actions button\s*\{[^}]*min-height:\s*44px/s);
});
