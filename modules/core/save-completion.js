export function assessSaveCompletion(request, {
    liveFingerprint,
    liveCanonicalContent,
    mutationGeneration,
    latestRevision,
} = {}) {
    const fingerprintChanged = request.quickFingerprint !== null
        && request.quickFingerprint !== undefined
        && liveFingerprint !== request.quickFingerprint;
    return {
        committedHash: request.newHash,
        committedFingerprint: request.quickFingerprint ?? null,
        committedCanonicalContent: request.canonicalContent ?? null,
        pending: fingerprintChanged
            || (request.quickFingerprint == null
                && (typeof request.canonicalContent !== 'string'
                    || liveCanonicalContent !== request.canonicalContent))
            || mutationGeneration !== request.mutationGeneration
            || latestRevision !== request.revision,
    };
}
