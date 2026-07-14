const SUPPORTED_VIEWS = new Set(['series', 'flat']);

/**
 * Stores rendered list markup only for a view-only transition. Callers clear
 * the cache before any render driven by data or interaction state changes.
 */
export function createPanelViewMarkupCache() {
    const entries = new Map();

    return Object.freeze({
        capture(view, markup, scrollTop = 0) {
            if (!SUPPORTED_VIEWS.has(view) || typeof markup !== 'string'
                || !Number.isFinite(scrollTop) || scrollTop < 0) {
                return false;
            }
            entries.set(view, Object.freeze({ markup, scrollTop }));
            return true;
        },

        read(view) {
            return entries.get(view) || null;
        },

        clear() {
            entries.clear();
        },
    });
}
