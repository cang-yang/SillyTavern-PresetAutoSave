import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSeriesKeyResolver } from '../../modules/core/series-key-resolver.js';
import { normalizeSeriesKey } from '../../modules/preset-grouping.js';

test('native automatic names resolve to the aliased history group with all data intact', () => {
    const historyGroup = {
        canonicalKey: 'story',
        automaticName: 'Story',
        displayName: 'My Stories',
        series: 'My Stories',
        snapshotCount: 3,
        totalSize: 6144,
        versions: [
            { presetName: 'Story V1', snapshotCount: 1, totalSize: 1024 },
            { presetName: 'Story V2', snapshotCount: 2, totalSize: 5120 },
        ],
    };
    const seriesMap = new Map([['My Stories', historyGroup]]);
    const resolve = buildSeriesKeyResolver(seriesMap, normalizeSeriesKey);

    assert.equal(resolve('Story'), 'My Stories');
    assert.equal(resolve('ＳＴＯＲＹ'), 'My Stories');
    assert.equal(seriesMap.get(resolve('Story')), historyGroup);
    assert.equal(seriesMap.get(resolve('Story')).totalSize, 6144);
    assert.equal(seriesMap.size, 1);
});

test('unknown canonical names still create one stable display key', () => {
    const seriesMap = new Map();
    const resolve = buildSeriesKeyResolver(seriesMap, normalizeSeriesKey);
    assert.equal(resolve('Utility'), 'Utility');
    assert.equal(resolve('utility'), 'Utility');
});
