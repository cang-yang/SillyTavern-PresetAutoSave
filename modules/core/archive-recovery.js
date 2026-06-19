function isPresetObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function newestUsableSnapshot(snapshots) {
    if (!Array.isArray(snapshots)) return null;
    return snapshots
        .filter(snapshot => snapshot && isPresetObject(snapshot.preset))
        .sort((left, right) => {
            const timestampOrder = Number(right.timestamp || 0) - Number(left.timestamp || 0);
            if (timestampOrder !== 0) return timestampOrder;
            return String(right.id || '').localeCompare(String(left.id || ''));
        })[0] || null;
}

export async function restoreArchiveEntries(entries, {
    getSnapshots,
    persistPreset,
    removeArchive,
    onError = () => {},
} = {}) {
    if (typeof getSnapshots !== 'function') throw new TypeError('getSnapshots is required');
    if (typeof persistPreset !== 'function') throw new TypeError('persistPreset is required');
    if (typeof removeArchive !== 'function') throw new TypeError('removeArchive is required');

    const result = {
        restored: 0,
        failed: 0,
        cleanupFailed: 0,
        fromSnapshot: 0,
        fromArchive: 0,
    };

    for (const archive of Array.isArray(entries) ? entries : []) {
        if (!archive?.apiId || !archive?.presetName) {
            result.failed++;
            onError({ phase: 'validate', archive, error: new TypeError('Invalid archive entry') });
            continue;
        }

        let snapshot = null;
        try {
            snapshot = newestUsableSnapshot(await getSnapshots(archive.apiId, archive.presetName));
        } catch (error) {
            onError({ phase: 'snapshot', archive, error });
        }

        const source = snapshot ? 'snapshot' : 'archive';
        const preset = snapshot?.preset ?? archive.data;
        if (!isPresetObject(preset)) {
            result.failed++;
            onError({ phase: 'validate-data', archive, error: new TypeError('No usable preset data') });
            continue;
        }

        try {
            await persistPreset(archive, preset, { source, snapshot });
        } catch (error) {
            result.failed++;
            onError({ phase: 'persist', archive, error });
            continue;
        }

        result.restored++;
        if (source === 'snapshot') result.fromSnapshot++;
        else result.fromArchive++;

        try {
            const removed = await removeArchive(archive);
            if (removed !== true) {
                result.cleanupFailed++;
                onError({ phase: 'cleanup', archive, error: new Error('Archive removal was not confirmed') });
            }
        } catch (error) {
            result.cleanupFailed++;
            onError({ phase: 'cleanup', archive, error });
        }
    }

    return result;
}
