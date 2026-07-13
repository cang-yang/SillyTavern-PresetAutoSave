export const SAVE_STATUS_STATES = Object.freeze([
    'idle',
    'pending',
    'saving',
    'saved',
    'error',
]);

const STATUS_LABEL_KEYS = Object.freeze({
    idle: 'Status Idle',
    pending: 'Status Pending',
    saving: 'Status Saving',
    saved: 'Status Saved',
    error: 'Status Error',
});

let currentStatus = 'idle';

export function getSaveStatus() {
    return currentStatus;
}

export function setSaveStatus(status) {
    if (!SAVE_STATUS_STATES.includes(status)) return false;
    currentStatus = status;
    return true;
}

export function saveStatusLabelKey(status) {
    return STATUS_LABEL_KEYS[status] || STATUS_LABEL_KEYS.idle;
}
