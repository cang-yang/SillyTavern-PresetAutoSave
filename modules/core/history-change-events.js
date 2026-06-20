const listeners = new Set();

export function onHistoryChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitHistoryChange(change) {
    for (const listener of [...listeners]) {
        try {
            listener(change);
        } catch (_) {
            // A view subscriber must never make a persisted history mutation fail.
        }
    }
}
