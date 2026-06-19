function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function normalizeBooleanString(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}

export function normalizeNumberString(value) {
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return value;
}

export function normalizeValue(value) {
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isPlainObject(value)) return value;

    const result = {};
    for (const key of Object.keys(value).sort()) {
        result[key] = normalizeValue(value[key]);
    }
    return result;
}

export function stableStringify(value) {
    return JSON.stringify(normalizeValue(value));
}
