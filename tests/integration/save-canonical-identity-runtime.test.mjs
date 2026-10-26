import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';
import { installEditControls } from '../fixtures/edit-controls.mjs';
import { hashCanonicalPreset } from '../../modules/core/preset-schema.js';

const host = installRuntimeHost();
const controls = installEditControls(host);
const first = 'collision-17327';
const second = 'collision-28051';
host.live.send_if_empty = first;
Object.assign(host.stored, host.live);
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
settings.batchUpdate({ mergeWindowSec: 0, fallbackPolling: false });
const history = await import('../../modules/history-store.js');
const auto = await import('../../modules/auto-save.js');

const waitFor = async predicate => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(predicate(), true, 'runtime operation did not complete');
};

test('real canonical hash collisions cannot suppress automatic host and history writes', async () => {
    const initial = structuredClone(host.live);
    const changed = { ...initial, send_if_empty: second };
    assert.equal(hashCanonicalPreset(initial), '19x4r5g');
    assert.equal(hashCanonicalPreset(changed), '19x4r5g');
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        host.live.send_if_empty = second;
        const result = await auto.saveNowDetailed('auto');
        assert.equal(result.status, 'committed');
        assert.equal(host.writes.length, 1);
        assert.equal(host.writes[0].preset.send_if_empty, second);
        assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.send_if_empty, second);

        host.live.send_if_empty = first;
        const reverted = await auto.saveNowDetailed('auto');
        assert.equal(reverted.status, 'committed');
        assert.equal(host.writes.length, 2);
        assert.equal(host.writes[1].preset.send_if_empty, first);
        assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.send_if_empty, first);
        assert.equal(auto.isDirty(), false);
    } finally {
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});

for (const source of ['switch-event', 'dom-capture', 'polling']) {
    test(`${source} protects an edit with the same diagnostic hash as the baseline`, async () => {
        host.live.send_if_empty = first;
        Object.assign(host.stored, host.live);
        const beforeWrites = host.writes.length;
        const originalAdd = document.addEventListener;
        const originalRemove = document.removeEventListener;
        const originalInterval = globalThis.setInterval;
        const originalClear = globalThis.clearInterval;
        let capturedChange = null;
        let poll = null;
        if (source === 'dom-capture') {
            document.addEventListener = (type, fn, capture) => {
                if (type === 'change' && capture === true) capturedChange = fn;
            };
            document.removeEventListener = () => {};
        }
        if (source === 'polling') {
            globalThis.setInterval = fn => { poll = fn; return 12345; };
            globalThis.clearInterval = () => {};
        }
        settings.batchUpdate({ fallbackPolling: source === 'polling', debounceMs: 100, enableSwitchGuard: true });
        await history.initHistoryStore();
        await auto.initAutoSave();
        try {
            controls.change('send_if_empty', second);
            await new Promise(resolve => setTimeout(resolve, 5));
            if (source === 'polling') {
                assert.equal(typeof poll, 'function');
                poll();
            } else {
                if (source === 'switch-event') host.emit('oai_preset_changed_before');
                else {
                    assert.equal(typeof capturedChange, 'function');
                    capturedChange({ target: { matches: () => true } });
                }
            }
            await waitFor(() => host.writes.length === beforeWrites + 1 && !auto.isDirty());
            assert.equal(host.writes.at(-1).preset.send_if_empty, second);
            assert.equal((await history.getSnapshots('openai', 'race'))[0].preset.send_if_empty, second);
        } finally {
            await auto.teardown();
            await history.teardownHistoryStore();
            document.addEventListener = originalAdd;
            document.removeEventListener = originalRemove;
            globalThis.setInterval = originalInterval;
            globalThis.clearInterval = originalClear;
            settings.updateSetting('fallbackPolling', false);
        }
    });
}

test('runtime switch verification waits for exact stored content even when hashes collide', async () => {
    host.live.send_if_empty = first;
    Object.assign(host.stored, host.live);
    await history.initHistoryStore();
    await auto.initAutoSave();
    try {
        host.stored.send_if_empty = second;
        host.emit('preset_changed');
        await new Promise(resolve => setTimeout(resolve, 230));
        assert.equal(auto.getCurrentTracking().ignoring, true);
        host.live.send_if_empty = second;
        await waitFor(() => !auto.getCurrentTracking().ignoring);
        host.live.send_if_empty = first;
        assert.equal((await auto.saveNowDetailed('auto')).status, 'committed');
        assert.equal(host.writes.at(-1).preset.send_if_empty, first);
    } finally {
        await auto.teardown();
        await history.teardownHistoryStore();
    }
});
