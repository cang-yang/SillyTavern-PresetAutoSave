import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPanelViewMarkupCache } from '../modules/core/panel-view-markup-cache.js';

test('view markup cache isolates supported views and preserves scroll position', () => {
    const cache = createPanelViewMarkupCache();

    assert.equal(cache.capture('series', '<div>series</div>', 128), true);
    assert.equal(cache.capture('flat', '<div>flat</div>', 42), true);
    assert.deepEqual(cache.read('series'), { markup: '<div>series</div>', scrollTop: 128 });
    assert.deepEqual(cache.read('flat'), { markup: '<div>flat</div>', scrollTop: 42 });
});

test('view markup cache overwrites one view without changing the other', () => {
    const cache = createPanelViewMarkupCache();
    cache.capture('series', '<div>old</div>', 1);
    cache.capture('flat', '<div>flat</div>', 2);
    cache.capture('series', '<div>new</div>', 3);

    assert.deepEqual(cache.read('series'), { markup: '<div>new</div>', scrollTop: 3 });
    assert.deepEqual(cache.read('flat'), { markup: '<div>flat</div>', scrollTop: 2 });
});

test('view markup cache rejects malformed entries and clears atomically', () => {
    const cache = createPanelViewMarkupCache();

    assert.equal(cache.capture('grid', '<div></div>', 0), false);
    assert.equal(cache.capture('series', null, 0), false);
    assert.equal(cache.capture('series', '<div></div>', Number.NaN), false);
    assert.equal(cache.read('grid'), null);
    assert.equal(cache.read('series'), null);

    cache.capture('series', '<div>series</div>', 0);
    cache.capture('flat', '<div>flat</div>', 0);
    cache.clear();
    assert.equal(cache.read('series'), null);
    assert.equal(cache.read('flat'), null);
});

test('history panel uses the cache only for view-only navigation', async () => {
    const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');

    assert.match(source, /_viewMarkupCache\.capture\(_state\.viewMode, list\.innerHTML, list\.scrollTop\)/);
    assert.match(source, /renderListTab\(\{ reuseViewCache: true \}\)/);
    assert.match(source, /if \(!reuseViewCache\) _viewMarkupCache\.clear\(\)/);
    assert.match(source, /const cachedView = reuseViewCache \? _viewMarkupCache\.read\(_state\.viewMode\) : null/);
    assert.match(source, /requestAnimationFrame\(\(\) => \{[\s\S]*?_root\?\.contains\(list\)[\s\S]*?list\.scrollTop = cachedView\.scrollTop/s);
});
