import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';
import { restoreArchiveEntries } from '../../modules/core/archive-recovery.js';

const host = installRuntimeHost();
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const { restorePresetVerified } = await import('../../modules/host/preset-recovery.js');

test('recovery refuses conflicting existing presets and preserves the archive', async () => {
    let removed = false;
    const result = await restoreArchiveEntries([{ apiId: 'openai', presetName: 'race', data: { temperature: 0.8 } }], {
        getSnapshots: async () => [],
        persistPreset: entry => restorePresetVerified(entry.presetName, entry.data, { apiId: entry.apiId }),
        removeArchive: async () => { removed = true; return true; },
    });
    assert.equal(result.failed, 1);
    assert.equal(removed, false);
    assert.equal(host.writes.length, 0);
});

test('recovery verifies missing preset registration before allowing cleanup', async () => {
    const names = ['race'];
    const presets = [host.stored];
    const originalList = host.pm.getPresetList;
    const originalSave = host.pm.savePreset;
    host.pm.getPresetList = () => ({ settings: host.live, preset_names: names, presets });
    try {
        host.pm.savePreset = async () => {};
        await assert.rejects(restorePresetVerified('missing', { temperature: 0.8 }, { apiId: 'openai' }), /verif/i);
        host.pm.savePreset = async (name, preset, options) => {
            assert.equal(options.skipUpdate, false);
            names.push(name);
            presets.push(structuredClone(preset));
        };
        assert.equal(await restorePresetVerified('missing', { temperature: 0.8 }, { apiId: 'openai' }), true);
        host.pm.savePreset = async () => { throw new Error('equal recovery must not rewrite'); };
        assert.equal(await restorePresetVerified('missing', { temperature: 0.8 }, { apiId: 'openai' }), true);
    } finally {
        host.pm.getPresetList = originalList;
        host.pm.savePreset = originalSave;
    }
});
