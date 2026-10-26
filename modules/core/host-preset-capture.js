import {
    appendPresetPath, canonicalizePreset, connectionExclusionReason, FIELD_SYNONYMS,
    presetFieldExclusionReason, presetValueError,
} from './preset-schema.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object'
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function defineValue(object, key, value) {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function copyValue(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!Array.isArray(value) && !isPlainObject(value)) {
        const type = typeof value === 'number' ? 'non-finite-number'
            : typeof value === 'object' ? 'non-plain-object' : typeof value;
        throw presetValueError(path, type);
    }
    if (ancestors.has(value)) throw presetValueError(path, 'object', 'PRESET_CIRCULAR');
    ancestors.add(value);
    const array = Array.isArray(value);
    const output = array ? [] : {};
    if (array) {
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor.enumerable) continue;
            if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
                throw presetValueError(path, 'array-property');
            }
        }
        // JSON preserves array positions: unset items and holes become null.
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            const itemPath = `${path}[${index}]`;
            if (descriptor && !Object.hasOwn(descriptor, 'value')) throw presetValueError(itemPath, 'accessor');
            output.push(descriptor?.value === undefined ? null
                : copyValue(descriptor.value, itemPath, ancestors));
        }
    } else {
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor.enumerable) continue;
            if (typeof key !== 'string') throw presetValueError(path, 'symbol-key');
            if (connectionExclusionReason(key, descriptor.value)) continue;
            const itemPath = appendPresetPath(path, key);
            if (!Object.hasOwn(descriptor, 'value')) throw presetValueError(itemPath, 'accessor');
            if (descriptor.value === undefined) continue;
            defineValue(output, key, copyValue(descriptor.value, itemPath, ancestors));
        }
    }
    ancestors.delete(value);
    return output;
}

/**
 * Host objects are not JSON documents. Only unset properties receive JSON's
 * omission/null semantics; malformed owned values must never be coerced.
 */
export function captureHostPreset(preset, { apiId = 'openai' } = {}) {
    if (!isPlainObject(preset)) throw presetValueError('preset', 'non-plain-object');
    const projected = {};
    for (const key of Object.keys(preset)) {
        const canonicalKey = FIELD_SYNONYMS.get(key) ?? key;
        if (canonicalKey !== key && Object.hasOwn(preset, canonicalKey)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(preset, key);
        if (presetFieldExclusionReason(canonicalKey, descriptor.value, { apiId })) continue;
        const path = appendPresetPath('', canonicalKey);
        if (!Object.hasOwn(descriptor, 'value')) throw presetValueError(path, 'accessor');
        if (descriptor.value === undefined) continue;
        defineValue(projected, canonicalKey,
            copyValue(descriptor.value, path, new Set([preset])));
    }
    return canonicalizePreset(projected, { apiId }).canonical;
}
