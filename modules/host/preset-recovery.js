import { getPresetManager, savePresetSafe } from '../compatibility.js';
import { captureHostPreset } from '../core/host-preset-capture.js';
import { requireCanonicalPreset } from '../core/preset-schema.js';
import { stableStringify } from '../core/value-utils.js';
import { lookupPresetInventory } from '../core/preset-inventory-lookup.js';

function lookup(manager, apiId, name) {
    const found = lookupPresetInventory(manager?.getPresetList?.(apiId), name);
    return found.exists
        ? { exists: true, preset: captureHostPreset(found.preset, { apiId }) }
        : found;
}

/** Lifecycle recovery is not permission to overwrite a newer native preset. */
export async function restorePresetVerified(presetName, preset, { apiId } = {}) {
    if (!apiId || !presetName) throw new TypeError('Recovery requires a stable preset target');
    const captured = requireCanonicalPreset(preset, { apiId });
    const expected = stableStringify(captured);
    const manager = getPresetManager(apiId);
    const existing = lookup(manager, apiId, presetName);
    if (existing.exists) {
        if (stableStringify(existing.preset) !== expected) {
            const error = new Error('Recovery target already exists with different content; backup preserved');
            error.code = 'RECOVERY_TARGET_CONFLICT';
            throw error;
        }
        return true;
    }
    await savePresetSafe(presetName, captured, { apiId, skipUpdate: false });
    const restored = lookup(manager, apiId, presetName);
    if (!restored.exists || stableStringify(restored.preset) !== expected) {
        throw new Error('Recovery write verification failed; backup preserved');
    }
    return true;
}
