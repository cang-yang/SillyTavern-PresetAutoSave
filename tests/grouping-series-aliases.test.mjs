import test from 'node:test';
import assert from 'node:assert/strict';

import {
    groupNamesBySeries,
    resolveSeriesDisplayName,
    validateSeriesAlias,
} from '../modules/preset-grouping.js';
import { DEFAULT_SETTINGS, sanitizeSeriesAliasMap } from '../modules/settings.js';

test('resolves a display alias without changing canonical series identity', () => {
    assert.deepEqual(
        resolveSeriesDisplayName('梦境思客', { 梦境思客: '我的主力预设' }),
        {
            canonicalKey: '梦境思客',
            automaticName: '梦境思客',
            displayName: '我的主力预设',
            customized: true,
        },
    );
});

test('new versions inherit an alias through the stable canonical key', () => {
    const groups = groupNamesBySeries(
        ['梦境思客 V1', '梦境思客 V2', '梦境思客 V3'],
        {},
        { 梦境思客: '我的主力预设' },
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0].canonicalKey, '梦境思客');
    assert.equal(groups[0].automaticName, '梦境思客');
    assert.equal(groups[0].displayName, '我的主力预设');
    assert.equal(groups[0].series, '我的主力预设');
    assert.deepEqual(groups[0].items.map(item => item.presetName), [
        '梦境思客 V3',
        '梦境思客 V2',
        '梦境思客 V1',
    ]);
});

test('validates friendly Unicode names without silently truncating them', () => {
    const groups = [
        { canonicalKey: 'story', displayName: '故事模型' },
        { canonicalKey: 'utility', displayName: '工具' },
    ];

    assert.deepEqual(validateSeriesAlias('  我的 ✨ 预设  ', groups, 'story'), {
        ok: true,
        value: '我的 ✨ 预设',
    });
    assert.equal(validateSeriesAlias('   ', groups, 'story').reason, 'empty');
    assert.equal(validateSeriesAlias('😀'.repeat(121), groups, 'story').reason, 'too-long');
});

test('rejects duplicate display names using normalized comparison', () => {
    const groups = [
        { canonicalKey: 'story', displayName: '故事模型' },
        { canonicalKey: 'utility', displayName: 'ＭＵＲ 鹿鹿 API' },
    ];

    assert.equal(validateSeriesAlias('mur鹿鹿API', groups, 'story').reason, 'duplicate');
    assert.equal(validateSeriesAlias('故事模型', groups, 'story').ok, true);
});

test('settings include a separate alias map instead of overloading manual membership', () => {
    assert.deepEqual(DEFAULT_SETTINGS.groupingSeriesAliases, {});
    assert.deepEqual(DEFAULT_SETTINGS.groupingManualOverrides, {});
    assert.notEqual(DEFAULT_SETTINGS.groupingSeriesAliases, DEFAULT_SETTINGS.groupingManualOverrides);
});

test('settings count visible Unicode code points instead of UTF-16 units', () => {
    const validEmojiName = '😀'.repeat(110);
    assert.equal(sanitizeSeriesAliasMap({ story: validEmojiName }).story, validEmojiName);
    assert.deepEqual(sanitizeSeriesAliasMap({ story: '😀'.repeat(121) }), {});
});
