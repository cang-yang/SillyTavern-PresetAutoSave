export function isStorageQuotaError(error) {
    return Boolean(error && (
        error.name === 'QuotaExceededError'
        || error.code === 22
        || error.code === 1014
        || /quota|exceed/i.test(error.message || '')
    ));
}

export function createPreservedHistoryQuotaError(cause) {
    const error = new Error(
        'History storage quota exceeded; existing history was preserved. Free storage or remove unneeded history, then retry.',
        { cause },
    );
    error.name = 'StorageQuotaError';
    return error;
}
