export function getDeferredSaveDelay({
    now = Date.now(),
    suspendUntil = 0,
    ignoreInput = false,
    ignoreFallbackMs = 0,
    safetyMs = 50,
} = {}) {
    const suspensionRemaining = Math.max(0, suspendUntil - now);
    const ignoreRemaining = ignoreInput && suspensionRemaining === 0
        ? Math.max(0, ignoreFallbackMs)
        : 0;
    return Math.max(suspensionRemaining, ignoreRemaining) + Math.max(0, safetyMs);
}
