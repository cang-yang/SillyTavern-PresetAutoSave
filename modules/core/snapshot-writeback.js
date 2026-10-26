import { lookupPresetInventory } from './preset-inventory-lookup.js';

function targetKey(apiId, presetName) {
    return JSON.stringify([apiId, presetName]);
}

function emptyResult(failed = 0) {
    return { written: 0, skipped: 0, failed };
}

function findLatestSnapshots(snapshots) {
    const latestByTarget = new Map();
    let failed = 0;
    for (const candidate of snapshots) {
        if (!candidate?.presetName || !candidate?.apiId) {
            failed++;
            continue;
        }
        const key = targetKey(candidate.apiId, candidate.presetName);
        const current = latestByTarget.get(key);
        if (!current || (candidate.timestamp || 0) > (current.timestamp || 0)) {
            latestByTarget.set(key, candidate);
        }
    }
    return { latestByTarget, failed };
}

function presetExists(manager, snapshot, allowSelectorFallback) {
    try {
        return lookupPresetInventory(manager.getPresetList?.(snapshot.apiId), snapshot.presetName).exists;
    } catch (error) {
        // Selector lookup is not sufficient authority for destructive recovery.
        if (!allowSelectorFallback || typeof manager.findPreset !== 'function') throw error;
        return manager.findPreset(snapshot.presetName) != null;
    }
}

/**
 * Create the only recovery writer used by lifecycle orchestration. Dependencies
 * are injected so selection, host existence checks, and failure accounting can
 * be verified without loading SillyTavern or storage globals.
 */
export function createSnapshotWriteback({
    loadSnapshots,
    getPresetManager,
    savePreset,
    logger = {},
}) {
    return async function writeBackLatestSnapshots(options = {}) {
        const { skipExisting = false } = options;
        try {
            const snapshots = await loadSnapshots();
            if (!Array.isArray(snapshots)) throw new TypeError('Recovery snapshot enumeration is not an array');
            if (snapshots.length === 0) return emptyResult();

            const selected = findLatestSnapshots(snapshots);
            let failed = selected.failed;
            // A base series name is also a legitimate canonical preset target.
            let skipped = 0;
            let written = 0;

            for (const snapshot of selected.latestByTarget.values()) {
                if (!snapshot.preset || typeof snapshot.preset !== 'object' || Array.isArray(snapshot.preset)) {
                    failed++;
                    continue;
                }
                try {
                    const manager = getPresetManager(snapshot.apiId);
                    if (!manager) throw new Error(`PresetManager unavailable for ${snapshot.apiId}`);

                    const exists = presetExists(manager, snapshot, !skipExisting);
                    if (exists === skipExisting) {
                        skipped++;
                        continue;
                    }

                    await savePreset(snapshot.presetName, snapshot.preset, {
                        apiId: snapshot.apiId,
                        skipUpdate: true,
                    });
                    written++;
                } catch (error) {
                    logger.debug?.(`writeback failed for ${snapshot.presetName}:`, error);
                    failed++;
                }
            }
            return { written, skipped, failed };
        } catch (error) {
            logger.warn?.('writeBackLatestSnapshots step failed:', error);
            return { ...emptyResult(1), error: String(error) };
        }
    };
}
