export class PresetSaveTransactionError extends Error {
    constructor(message, { cause, stage } = {}) {
        super(message, { cause });
        this.name = 'PresetSaveTransactionError';
        this.stage = stage ?? 'unknown';
        this.diskCommitted = true;
        this.historyCommitted = false;
    }
}

export async function commitPresetSave(request, {
    persistPreset,
    syncMemory,
    commitHistory,
} = {}) {
    if (typeof persistPreset !== 'function' || typeof syncMemory !== 'function' || typeof commitHistory !== 'function') {
        throw new TypeError('commitPresetSave requires persistence, memory, and history operations');
    }

    await persistPreset(request);
    try {
        const synchronized = await syncMemory(request);
        if (synchronized === false) {
            throw new Error('Preset memory synchronization returned false');
        }
    } catch (cause) {
        throw new PresetSaveTransactionError('Preset persisted but memory synchronization failed', {
            cause,
            stage: 'memory',
        });
    }

    try {
        const snapshot = await commitHistory(request);
        return {
            snapshot,
            diskCommitted: true,
            historyCommitted: true,
        };
    } catch (cause) {
        throw new PresetSaveTransactionError('Preset persisted but history commit failed', {
            cause,
            stage: 'history',
        });
    }
}
