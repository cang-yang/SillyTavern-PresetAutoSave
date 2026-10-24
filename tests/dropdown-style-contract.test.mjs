import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('takeover dropdown has a feature-owned touch and keyboard focus layer', async () => {
    const styles = await readFile(new URL('../styles/preset-dropdown.css', import.meta.url), 'utf8');
    const index = await readFile(new URL('../styles/index.css', import.meta.url), 'utf8');
    assert.match(index, /preset-dropdown\.css/);
    assert.match(styles, /\.pas-dd-trigger,[\s\S]*\.pas-dd-group-header,[\s\S]*\.pas-dd-item\s*\{[^}]*min-height:\s*44px/);
    assert.match(styles, /\.pas-dd-item:focus-visible/);
    assert.match(styles, /\.pas-dd-item--focused/);
    assert.match(styles, /outline:\s*2px solid/);
});
