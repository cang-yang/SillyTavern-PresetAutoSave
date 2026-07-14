import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getMenuNavigationIndex } from '../modules/core/menu-navigation.js';

test('menu arrow navigation wraps and supports boundary keys', () => {
    assert.equal(getMenuNavigationIndex('ArrowDown', 0, 3), 1);
    assert.equal(getMenuNavigationIndex('ArrowDown', 2, 3), 0);
    assert.equal(getMenuNavigationIndex('ArrowUp', 0, 3), 2);
    assert.equal(getMenuNavigationIndex('Home', 2, 3), 0);
    assert.equal(getMenuNavigationIndex('End', 0, 3), 2);
    assert.equal(getMenuNavigationIndex('Escape', 1, 3), null);
    assert.equal(getMenuNavigationIndex('ArrowDown', 0, 0), null);
});

test('group manager delegates both action menus to the accessible controller', async () => {
    const manager = await readFile(new URL('../modules/panel-group-manager.js', import.meta.url), 'utf8');
    const controller = await readFile(new URL('../modules/group-manager-context-menu.js', import.meta.url), 'utf8');

    assert.match(manager, /openGroupManagerContextMenu/);
    assert.match(manager, /closeGroupManagerContextMenu/);
    assert.doesNotMatch(manager, /<div class="pas-gm-ctx-item"/);
    assert.match(controller, /menu\.setAttribute\('role', 'menu'\)/);
    assert.match(controller, /button\.setAttribute\('role', 'menuitem'\)/);
    assert.match(controller, /case 'Escape'/);
    assert.match(controller, /restoreFocus: true/);
    assert.match(controller, /case 'Tab'/);
});
