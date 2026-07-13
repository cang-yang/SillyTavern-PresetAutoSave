/**
 * Build a resolver that maps canonical/automatic series identities back to
 * the display key already used by a history Map.
 */
export function buildSeriesKeyResolver(seriesMap, normalize) {
    const normalizedToDisplay = new Map();
    const register = (identity, displayKey) => {
        if (identity === null || identity === undefined || identity === '') return;
        normalizedToDisplay.set(normalize(identity), displayKey);
    };

    for (const [displayKey, series] of seriesMap || []) {
        register(displayKey, displayKey);
        register(series?.canonicalKey, displayKey);
        register(series?.automaticName, displayKey);
    }

    return rawKey => {
        const normalized = normalize(rawKey);
        const existing = normalizedToDisplay.get(normalized);
        if (existing !== undefined) return existing;
        register(rawKey, rawKey);
        return rawKey;
    };
}
