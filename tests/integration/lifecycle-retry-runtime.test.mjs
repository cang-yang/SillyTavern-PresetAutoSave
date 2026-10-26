import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';

let unavailable = false;
const host = installRuntimeHost({ storageGet: async storeName => {
    if (unavailable && storeName === 'history_v2') throw new Error('temporary storage outage');
} });
const names = ['race'];
const presets = [host.stored];
const originalSave = host.pm.savePreset;
host.pm.getPresetList = () => ({ settings: host.live, preset_names: names, presets });
host.pm.savePreset = async (name, preset, options) => {
    await originalSave(name, preset, options);
    const index = names.indexOf(name);
    if (index < 0) { names.push(name); presets.push(structuredClone(preset)); }
    else presets[index] = structuredClone(preset);
};
host.pm.findPreset = name => names.includes(name) ? names.indexOf(name) : undefined;
const runtime = await import('../../index.js');
const history = await import('../../modules/history-store.js');

test('disable recovery can retry after storage failure without re-enabling or losing history', async () => {
    await runtime.onEnable();
    const saved = await history.addSnapshot('missing', 'openai', { temperature: 0.8 }, history.TRIGGER.MANUAL);
    unavailable = true;
    const first = await runtime.onDisable();
    assert.equal(first.complete, false);
    unavailable = false;
    const second = await runtime.onDisable();
    assert.equal(second.complete, true);
    assert.equal(host.writes.at(-1).preset.temperature, 0.8);
    const entries = host.stores.get('history_v2').get('openai::missing');
    assert.ok(entries.some(entry => entry.id === saved.id));
});

test('disabling never overwrites an existing host preset with older historical content', async () => {
    await runtime.onEnable();
    await history.addSnapshot('race', 'openai', { temperature: 0.1 }, history.TRIGGER.MANUAL);
    host.stored.temperature = 0.9;
    const before = host.writes.length;
    const result = await runtime.onDisable();
    assert.equal(result.complete, true);
    assert.equal(host.writes.slice(before).some(write => write.name === 'race'), false);
    assert.equal(host.stored.temperature, 0.9);
});

test('delete recovery preserves missing-target history on write failure and retries before clearing it', async () => {
    await runtime.onEnable();
    const saved = await history.addSnapshot('recovery-only', 'openai', { temperature: 0.6 }, history.TRIGGER.MANUAL);
    const find = host.pm.findPreset;
    const persist = host.pm.savePreset;
    host.pm.findPreset = () => null;
    host.pm.savePreset = async () => { throw new Error('recovery write unavailable'); };
    try {
        const failed = await runtime.onDelete();
        assert.equal(failed.complete, false);
        assert.equal(failed.snapshots.failed, 1);
        assert.ok(host.stores.get('history_v2').get('openai::recovery-only').some(item => item.id === saved.id));
        host.pm.savePreset = persist;
        const retried = await runtime.onDelete();
        assert.equal(retried.complete, true);
        assert.equal(retried.snapshots.written, 1);
        assert.ok(names.includes('recovery-only'));
        assert.equal(presets[names.indexOf('recovery-only')].temperature, 0.6);
        assert.equal(host.stores.get('history_v2').has('openai::recovery-only'), false);
    } finally {
        host.pm.findPreset = find;
        host.pm.savePreset = persist;
    }
});
