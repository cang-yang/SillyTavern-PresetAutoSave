import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeHarnessOptions } from './harness/config.mjs';
import { contentTypeFor, resolveRequestPath } from './harness/server.mjs';

test('browser harness loads production styles and runs the production panel controller', async () => {
    const html = await readFile(new URL('./harness/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('./harness/app.mjs', import.meta.url), 'utf8');
    const historyPanel = await readFile(new URL('../modules/history-panel.js', import.meta.url), 'utf8');
    const harnessCss = await readFile(new URL('./harness/harness.css', import.meta.url), 'utf8');

    assert.match(html, /href="\.\.\/\.\.\/styles\/index\.css"/);
    assert.match(html, /rel="icon" href="data:image\/svg\+xml,/);
    assert.match(html, /src="\.\/app\.mjs"/);
    assert.match(app, /mountHistoryPanel/);
    assert.match(app, /initHistoryStore/);
    assert.match(app, /seedHarnessHistory/);
    assert.match(app, /createIndexedDbLocalforage/);
    assert.match(app, /storeName: 'history_v2'/);
    assert.match(app, /buildPerformanceStorageRecords/);
    assert.match(app, /fingerprintSnapshotSummaries/);
    assert.match(app, /catalogSummaries: projectSnapshotSummaries/);
    assert.match(app, /getSnapshotSummaries/);
    assert.match(app, /scenario === 'ordinary' \|\| options\.scenario === 'performance'[\s\S]*?getSnapshotSummaries/);
    assert.match(app, /initAutoSave/);
    assert.match(app, /teardownAutoSave/);
    assert.match(app, /operationEvents/);
    assert.match(app, /renderHistoryPanelShell/);
    assert.match(app, /disposeHistoryPanelMount/);
    assert.doesNotMatch(app, /from '\.\.\/\.\.\/modules\/panel-shell\.js'/);
    assert.doesNotMatch(app, /import\('\.\.\/\.\.\/modules\/panel-list-render\.js'\)/);
    assert.doesNotMatch(app, /function activateTab/);
    assert.doesNotMatch(app, /app\.addEventListener\('(click|keydown|input)'/);
    assert.doesNotMatch(app, /\.pas-search'\)\.addEventListener/);
    assert.match(app, /showSaveStatus/);
    assert.match(app, /renderHistoryImportPreview/);
    assert.match(app, /bindHistoryImportPreview/);
    assert.match(app, /showImportPreview/);
    assert.match(app, /mountGroupingManager/);
    assert.match(app, /groupManagerMount\?\.dispose/);
    assert.match(app, /showGroupManager/);
    assert.match(app, /exerciseCoreOperations/);
    assert.match(app, /exercisePresetSwitchConvergence/);
    assert.match(app, /exerciseDirtyPresetSwitchGuard/);
    assert.match(app, /countIncreased/);
    assert.match(app, /newIdCreated/);
    assert.match(app, /previousSnapshotPreserved/);
    assert.doesNotMatch(app, /renderModernGroupingHTML/);
    assert.match(app, /exerciseDisclosures/);
    assert.match(app, /exerciseUnusedNativeSeries/);
    assert.match(app, /exerciseViewSwitchPerformance/);
    assert.match(app, /groupingDefaultExpand: options\.scenario === 'performance' \? 'current' : 'all'/);
    assert.match(app, /payloadReads/);
    assert.match(app, /archivePayloadReads/);
    assert.match(app, /longTasks/);
    assert.match(app, /expandedSeriesContent/);
    assert.match(app, /exerciseGroupingMenus/);
    assert.match(app, /exerciseGroupingLayout/);
    assert.match(app, /exerciseHostileTranslations/);
    assert.match(app, /hostile translation executed as markup/i);
    assert.match(app, /importantSelector[\s\S]*?\.pas-gm-search input/);
    assert.match(app, /\.pas-primary-action \.pas-control-face > span[\s\S]*?\.pas-view-btn > span[\s\S]*?\.pas-btn-clear-preset > \.pas-action-label/);
    assert.match(app, /footerText[\s\S]*?contrastRatio/);
    assert.match(historyPanel, /renderActiveTab\(\{ immediateList: true, updateStatistics: false \}\)/);
    assert.doesNotMatch(app, /buildPanelHTML/);
    assert.doesNotMatch(app, /class="pas-panel"/);
    assert.doesNotMatch(app, /translate\('Panel Stats'/);
    assert.match(harnessCss, /\.fa-solid::before\s*\{/);
    assert.match(harnessCss, /\.fa-ellipsis::before/);
    assert.match(harnessCss, /\.fa-camera::before\s*\{[^}]*border:\s*2px solid currentColor/s);
    assert.doesNotMatch(harnessCss, /\.fa-camera::before\s*\{\s*content:\s*"●"/);
});

test('harness options are allow-listed and fail back to stable defaults', () => {
    assert.deepEqual(normalizeHarnessOptions('?scenario=performance&theme=light&view=flat&catalog=cold&history=15mb'), {
        scenario: 'performance',
        theme: 'light',
        view: 'flat',
        catalog: 'cold',
        history: '15mb',
    });
    assert.deepEqual(normalizeHarnessOptions('?scenario=secret&theme=neon&view=grid'), {
        scenario: 'ordinary',
        theme: 'dark',
        view: 'series',
        catalog: 'warm',
        history: '46mb',
    });
    assert.equal(Object.isFrozen(normalizeHarnessOptions('')), true);
});

test('local server resolves only files inside the repository root', () => {
    const root = resolve('D:/example/repository');
    assert.equal(resolveRequestPath('/tests/harness/', root), resolve(root, 'tests/harness/index.html'));
    assert.equal(resolveRequestPath('/styles/index.css?cache=1', root), resolve(root, 'styles/index.css'));
    assert.equal(resolveRequestPath('/../../outside.txt', root), null);
    assert.equal(resolveRequestPath('/%2e%2e/%2e%2e/outside.txt', root), null);
    assert.equal(resolveRequestPath('/%E0%A4%A', root), null);
});

test('local server sends explicit content types for harness assets', () => {
    assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('app.mjs'), 'text/javascript; charset=utf-8');
    assert.equal(contentTypeFor('index.css'), 'text/css; charset=utf-8');
    assert.equal(contentTypeFor('fixture.json'), 'application/json; charset=utf-8');
    assert.equal(contentTypeFor('unknown.bin'), 'application/octet-stream');
});
