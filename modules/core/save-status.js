export const SAVE_STATUS_STATES = Object.freeze([
    'idle',
    'pending',
    'saving',
    'saved',
    'error',
    'partial',
]);

const STATUS_LABEL_KEYS = Object.freeze({
    idle: 'Status Idle',
    pending: 'Status Pending',
    saving: 'Status Saving',
    saved: 'Status Saved',
    error: 'Status Error',
    partial: 'Status Partial',
});

let currentStatus = 'idle';
const listeners = new Set();

export function getSaveStatus() {
    return currentStatus;
}

export function setSaveStatus(status) {
    if (!SAVE_STATUS_STATES.includes(status)) return false;
    if (currentStatus === status) return true;
    currentStatus = status;
    for (const listener of listeners) {
        try { listener(status); } catch (_) { /* Observers do not own transaction state. */ }
    }
    return true;
}

export function onSaveStatusChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Status listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function saveStatusLabelKey(status) {
    return STATUS_LABEL_KEYS[status] || STATUS_LABEL_KEYS.idle;
}
