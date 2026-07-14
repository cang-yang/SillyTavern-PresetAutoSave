function targetKey(apiId, presetName) {
    return JSON.stringify([apiId, presetName]);
}

function seriesKey(apiId, seriesName) {
    return JSON.stringify([apiId, seriesName]);
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

function removeGhostSnapshots(latestByTarget, parsePresetName, logger) {
    const membersBySeries = new Map();
    for (const snapshot of latestByTarget.values()) {
        try {
            const parsed = parsePresetName(snapshot.presetName);
            const series = parsed?.series || snapshot.presetName;
            const key = seriesKey(snapshot.apiId, series);
            if (!membersBySeries.has(key)) membersBySeries.set(key, new Set());
            membersBySeries.get(key).add(snapshot.presetName);
        } catch (_) {
            // An unparseable name remains an independent stable preset target.
        }
    }

    let skipped = 0;
    for (const [target, snapshot] of [...latestByTarget.entries()]) {
        try {
            const parsed = parsePresetName(snapshot.presetName);
            const series = parsed?.series || snapshot.presetName;
            const members = membersBySeries.get(seriesKey(snapshot.apiId, series));
            if (snapshot.presetName === series && members?.size > 1) {
                latestByTarget.delete(target);
                skipped++;
                logger.debug?.(`writeBack: filtered ghost snapshot "${snapshot.presetName}" (series has ${members.size} real versions)`);
            }
        } catch (_) {
            // Parse failures fail open here so recovery data is never discarded.
        }
    }
    return skipped;
}

function presetExists(manager, snapshot) {
    let exists = false;
    let known = false;
    if (typeof manager.getPresetList === 'function') {
        try {
            const { preset_names: names } = manager.getPresetList(snapshot.apiId) || {};
            if (Array.isArray(names)) {
                exists = names.includes(snapshot.presetName);
                known = true;
            } else if (names && typeof names === 'object') {
                exists = Object.hasOwn(names, snapshot.presetName);
                known = true;
            }
        } catch (_) {
            // A second host capability may still provide a reliable answer.
        }
    }
    if (!exists && typeof manager.findPreset === 'function') {
        try {
            exists = manager.findPreset(snapshot.presetName) !== undefined;
            known = true;
        } catch (_) {
            // Unknown existence is handled by the caller as a recovery failure.
        }
    }
    return { exists, known };
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
    parsePresetName,
    logger = {},
}) {
    return async function writeBackLatestSnapshots(options = {}) {
        const { skipExisting = false, filterGhosts = false } = options;
        try {
            const snapshots = await loadSnapshots();
            if (!Array.isArray(snapshots) || snapshots.length === 0) return emptyResult();

            const selected = findLatestSnapshots(snapshots);
            let failed = selected.failed;
            let skipped = filterGhosts
                ? removeGhostSnapshots(selected.latestByTarget, parsePresetName, logger)
                : 0;
            let written = 0;

            for (const snapshot of selected.latestByTarget.values()) {
                if (!snapshot.preset || typeof snapshot.preset !== 'object' || Array.isArray(snapshot.preset)) {
                    failed++;
                    continue;
                }
                try {
                    const manager = getPresetManager(snapshot.apiId);
                    if (!manager) throw new Error(`PresetManager unavailable for ${snapshot.apiId}`);

                    if (skipExisting) {
                        const existence = presetExists(manager, snapshot);
                        if (!existence.known) throw new Error(`Could not verify whether preset exists: ${snapshot.presetName}`);
                        if (existence.exists) {
                            skipped++;
                            continue;
                        }
                    } else {
                        if (typeof manager.findPreset !== 'function') {
                            throw new Error(`Could not verify existing preset: ${snapshot.presetName}`);
                        }
                        if (manager.findPreset(snapshot.presetName) === undefined) {
                            skipped++;
                            continue;
                        }
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
