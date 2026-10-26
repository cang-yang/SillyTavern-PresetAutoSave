/** Unknown inventory is an error, never proof that recovery may be skipped. */
export function lookupPresetInventory(list, name) {
    const names = list?.preset_names;
    const array = Array.isArray(names);
    const plain = names && typeof names === 'object'
        && [Object.prototype, null].includes(Object.getPrototypeOf(names));
    if ((!array && !plain) || (array && (Object.keys(names).length !== names.length
        || names.some(value => typeof value !== 'string')))) {
        throw new Error('Recovery cannot verify host preset inventory');
    }
    let index;
    if (array) {
        index = names.indexOf(name);
        if (index < 0) return { exists: false };
    } else {
        if (!Object.hasOwn(names, name)) return { exists: false };
        index = names[name];
    }
    const presets = list?.presets;
    if (index == null || !presets || !Object.hasOwn(presets, index)) {
        throw new Error('Recovery cannot verify host preset content');
    }
    const preset = presets[index];
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
        throw new Error('Recovery cannot verify host preset content');
    }
    return { exists: true, preset };
}
