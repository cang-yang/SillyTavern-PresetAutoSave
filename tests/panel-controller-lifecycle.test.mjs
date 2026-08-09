import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');

test('panel dataset failures reach the production error state', () => {
    assert.doesNotMatch(source, /getAllSnapshots\(\)\.catch\(\(\) => \[\]\)/);
    assert.doesNotMatch(source, /listArchivedPresets\(\)\.catch\(\(\) => \[\]\)/);
    assert.match(source, /pas-panel-error[^]*?role="alert"/);
    assert.match(source, /escapeHtml\(t\('Panel Open Failed'/);
    const errorRenderer = source.match(/function renderPanelError[^]*?\n}/)?.[0] || '';
    assert.match(errorRenderer, /t\('Panel Open Recovery Hint'\)/);
    assert.doesNotMatch(errorRenderer, /error\?\.message|escapeHtml\(stage|stage:/);
});

test('async dataset loading resynchronizes the persisted view controls before rendering', () => {
    const loader = source.match(/async function loadAndRenderMountedPanel[^]*?\n}/)?.[0] || '';
    assert.match(loader, /await loadData[^]*?updateViewToggleUI\(\)[^]*?renderActiveTab/);
});

test('every deferred controller render is cleared by mount disposal', () => {
    assert.doesNotMatch(source, /let _panelRefreshTimer = null/);
    assert.match(source, /let _panelSearchTimer = null/);
    assert.match(source, /let _panelLogSearchTimer = null/);
    assert.match(source, /let _panelPresetRefreshTimer = null/);
    assert.match(source, /let _renderListFrame = null/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelSearchTimer\)/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelLogSearchTimer\)/);
    assert.match(source, /disposeHistoryPanelMount[^]*?clearTimeout\(_panelPresetRefreshTimer\)/);
    assert.match(source, /disposeHistoryPanelMount[^]*?cancelAnimationFrame\(_renderListFrame\)/);
});

test('bursty host preset events debounce one pending list repaint', () => {
    assert.match(
        source,
        /const onPresetChanged = \(\) => \{[\s\S]*?if \(_panelPresetRefreshTimer\) \{[\s\S]*?clearTimeout\(_panelPresetRefreshTimer\)[\s\S]*?_panelPresetRefreshTimer = setTimeout/,
    );
});

test('loading state uses localized user copy without exposing internal stages', async () => {
    const [english, chinese] = await Promise.all([
        readFile(new URL('../i18n/en-us.json', import.meta.url), 'utf8').then(JSON.parse),
        readFile(new URL('../i18n/zh-cn.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);

    assert.equal(english['Panel Loading History'], 'Loading preset history…');
    assert.equal(chinese['Panel Loading History'], '正在加载预设历史…');
    assert.equal(english['Panel Building History Catalog'], 'Preparing history index… {{completed}}/{{total}}');
    assert.equal(chinese['Panel Building History Catalog'], '正在准备历史索引… {{completed}}/{{total}}');
    const loadingRenderer = source.match(/function renderPanelLoading[^]*?\n}/)?.[0] || '';
    assert.match(loadingRenderer, /t\('Panel Loading History'\)/);
    assert.doesNotMatch(loadingRenderer, /pas-empty-hint|escapeHtml\(stage/);
    assert.match(source, /getSnapshotSummaries\(\{ onProgress \}\)/);
    assert.match(source, /t\('Panel Building History Catalog'/);
});
