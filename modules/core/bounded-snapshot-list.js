export const INITIAL_SNAPSHOT_RENDER_LIMIT = 5;
export const BULK_SNAPSHOT_RENDER_LIMIT = 0;
export const SNAPSHOT_RENDER_INCREMENT = 10;

function normalizeLimit(value, total) {
    const parsed = Number.isFinite(value) ? Math.floor(value) : INITIAL_SNAPSHOT_RENDER_LIMIT;
    return Math.max(0, Math.min(parsed, total));
}

export function getBoundedSnapshotWindow(snapshots, requestedLimit) {
    const source = Array.isArray(snapshots) ? snapshots : [];
    const limit = normalizeLimit(requestedLimit, source.length);
    return Object.freeze({
        items: Object.freeze(source.slice(0, limit)),
        total: source.length,
        visible: limit,
        remaining: Math.max(0, source.length - limit),
    });
}

export function increaseSnapshotRenderLimit(currentLimit, total) {
    const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    const current = normalizeLimit(currentLimit, safeTotal);
    return Math.min(safeTotal, current + SNAPSHOT_RENDER_INCREMENT);
}
