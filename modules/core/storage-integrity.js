export function fingerprintStorageKey(key) {
    const input = String(key ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `key-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class StorageReadError extends Error {
    constructor(key, cause) {
        const keyFingerprint = fingerprintStorageKey(key);
        super(`Stored value could not be decoded (${keyFingerprint})`, { cause });
        this.name = 'StorageReadError';
        this.code = 'STORAGE_VALUE_CORRUPT';
        this.keyFingerprint = keyFingerprint;
    }
}
