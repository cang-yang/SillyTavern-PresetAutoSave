import { commitPresetSave, PresetSaveTransactionError } from './save-transaction.js';

export function prepareRestoreCommand(target, { canonicalize, hashPreset }) {
    if (!target?.apiId || !target?.presetName || !target.preset
        || typeof target.preset !== 'object' || Array.isArray(target.preset)) {
        throw new TypeError('Restore requires a stable target and preset object');
    }
    const preset = canonicalize(structuredClone(target.preset), { apiId: target.apiId });
    if (Object.keys(preset).length === 0) throw new TypeError('Restore preset has no canonical content');
    return {
        apiId: target.apiId,
        presetName: target.presetName,
        preset,
        newHash: hashPreset(preset, target.apiId),
        quickFingerprint: null,
        kind: 'restore',
        coalesce: false,
        trigger: 'restore',
        reason: 'restore',
    };
}

export async function executePresetWrite(request, { persistPreset, syncMemory, commitHistory }) {
    if (request.kind === 'native-observation') {
        try {
            return { snapshot: await commitHistory(request), diskCommitted: true, historyCommitted: true };
        } catch (cause) {
            throw new PresetSaveTransactionError('Native preset persisted but history commit failed', {
                cause, stage: 'history',
            });
        }
    }
    return commitPresetSave(request, { persistPreset, syncMemory, commitHistory });
}
