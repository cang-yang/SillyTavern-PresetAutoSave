export function createJsonFingerprint(value) {
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : null;
    } catch (_) {
        return null;
    }
}
