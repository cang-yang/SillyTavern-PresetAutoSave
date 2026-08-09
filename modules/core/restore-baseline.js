function clonePreset(preset) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
        throw new TypeError('Restore baseline requires preset data');
    }
    if (typeof structuredClone === 'function') return structuredClone(preset);
    return JSON.parse(JSON.stringify(preset));
}

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

export function prepareRestoreBaseline({ apiId, presetName, preset } = {}, { hashPreset } = {}) {
    if (typeof apiId !== 'string' || apiId.trim() === '') {
        throw new TypeError('Restore baseline requires a stable API identity');
    }
    if (typeof presetName !== 'string' || presetName.trim() === '') {
        throw new TypeError('Restore baseline requires a stable preset identity');
    }
    if (typeof hashPreset !== 'function') {
        throw new TypeError('Restore baseline requires a hash function');
    }

    const immutablePreset = clonePreset(preset);
    const restoreHash = hashPreset(immutablePreset, apiId);
    if (typeof restoreHash !== 'string' || restoreHash.length === 0) {
        throw new Error('Restore baseline did not produce a usable hash');
    }

    return deepFreeze({
        apiId,
        presetName,
        preset: immutablePreset,
        restoreHash,
    });
}
