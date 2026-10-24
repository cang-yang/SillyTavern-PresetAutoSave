import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('group manager rules have one feature owner in the production style stack', async () => {
    const index = await readFile(new URL('../styles/index.css', import.meta.url), 'utf8');
    assert.match(index, /@import url\('\.\/group-manager\.css'\)/);
    const legacy = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(legacy, /^\.pas-gm-(?:header|series|move-option|context-menu)\s*\{/m);
    const css = await readFile(new URL('../styles/group-manager.css', import.meta.url), 'utf8');
    assert.match(css, /button\.pas-gm-move-option\s*\{[^}]*min-height:\s*44px/s);
    assert.match(css, /\.pas-gm-menu-btn:focus-visible/);
    assert.match(css, /\.pas-tag-unavailable/);
});
