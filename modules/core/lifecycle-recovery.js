function errorText(error) {
    return String(error?.message || error || 'Unknown error');
}

async function safeRestore(operation, fallback) {
    try {
        const result = await operation();
        return result && typeof result === 'object' ? result : fallback;
    } catch (error) {
        return { ...fallback, error: errorText(error) };
    }
}

async function safeClear(operation, label) {
    try {
        const result = await operation();
        if (result === false) return { cleared: false, error: `${label} cleanup was not confirmed` };
        return { cleared: true, error: null };
    } catch (error) {
        return { cleared: false, error: errorText(error) };
    }
}

export async function runDeleteRecovery({
    restoreArchives,
    writeBackSnapshots,
    clearSnapshots,
    clearArchives,
} = {}) {
    for (const [name, dependency] of Object.entries({
        restoreArchives,
        writeBackSnapshots,
        clearSnapshots,
        clearArchives,
    })) {
        if (typeof dependency !== 'function') throw new TypeError(`${name} is required`);
    }

    const archive = await safeRestore(restoreArchives, {
        restored: 0,
        failed: 1,
        cleanupFailed: 0,
        fromSnapshot: 0,
        fromArchive: 0,
    });
    const snapshots = await safeRestore(writeBackSnapshots, {
        written: 0,
        skipped: 0,
        failed: 1,
    });

    const archiveReady = Number(archive.failed || 0) === 0
        && Number(archive.cleanupFailed || 0) === 0
        && !archive.error;
    const snapshotsReady = Number(snapshots.failed || 0) === 0 && !snapshots.error;

    const snapshotCleanup = archiveReady && snapshotsReady
        ? await safeClear(clearSnapshots, 'Snapshot')
        : { cleared: false, error: null };
    const archiveCleanup = archiveReady
        ? await safeClear(clearArchives, 'Archive')
        : { cleared: false, error: null };

    return {
        complete: snapshotCleanup.cleared && archiveCleanup.cleared,
        archive,
        snapshots,
        snapshotsCleared: snapshotCleanup.cleared,
        archivesCleared: archiveCleanup.cleared,
        errors: {
            snapshots: snapshotCleanup.error,
            archives: archiveCleanup.error,
        },
    };
}
