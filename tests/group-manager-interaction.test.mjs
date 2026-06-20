import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../modules/panel-group-manager.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

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
