import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDebugInterface } from '../modules/debug-interface.js';

test('production diagnostics expose no destructive reset path when reseeding is skipped', async () => {
    const recoveryState = { snapshots: 31, archives: 1 };
    const api = createDebugInterface({
        version: 'test',
        env: {},
        logger: {},
        showHistoryPanel() {},
        refreshTakeover() {},
        phaseState: () => ({ phase1: true, takeover: true, phase2: true }),
        ensureRuntimeReady: async () => {},
        listSeries: () => [],
        parsePresetName: name => name,
        groupNamesBySeries: names => names,
        listArchived: () => ({ total: recoveryState.archives }),
        restoreArchives: async () => ({ restored: 0, failed: 0 }),
        reseed: async () => ({ skipped: true }),
        listPanelPresets: () => [],
        documentObject: { querySelectorAll: () => [] },
    });

    assert.equal('fullReset' in api.debug, false);
    assert.deepEqual(await api.debug.reseed(), { skipped: true });
    assert.deepEqual(recoveryState, { snapshots: 31, archives: 1 });
});

test('the lifecycle entry delegates diagnostics and contains no clear-then-reseed implementation', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

    assert.match(source, /createDebugInterface/);
    assert.doesNotMatch(source, /fullReset/);
    assert.doesNotMatch(source, /一键清空\+重新种子/);
});
