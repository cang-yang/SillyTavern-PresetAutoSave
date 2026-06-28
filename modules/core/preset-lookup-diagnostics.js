function getPresetObjectInfo(value) {
    if (Array.isArray(value)) return { kind: 'array', length: value.length, usable: value.length > 0 };
    if (!value || typeof value !== 'object') return { kind: value === null ? 'null' : typeof value, usable: false };
    const keys = Object.keys(value);
    return { kind: 'object', keyCount: keys.length, sampleKeys: keys.slice(0, 8), usable: keys.length > 0 };
}

function findNameIndex(names, name, predicate) {
    if (Array.isArray(names)) return names.findIndex(item => predicate(String(item ?? '')));
    if (names && typeof names === 'object') {
        const key = Object.keys(names).find(item => predicate(item));
        return key === undefined ? undefined : names[key];
    }
    return undefined;
}

function samplePresetNames(names, limit = 5) {
    if (Array.isArray(names)) return names.slice(0, limit).map(item => String(item ?? ''));
    if (names && typeof names === 'object') return Object.keys(names).slice(0, limit);
    return [];
}

export function describePresetLookup(list, name, currentName = null) {
    const target = String(name ?? '');
    const names = list?.preset_names;
    const presets = list?.presets;
    const exactIndex = findNameIndex(names, target, item => item === target);
    const trimmedIndex = findNameIndex(names, target, item => item.trim() === target.trim());
    const lowerIndex = findNameIndex(names, target, item => item.toLocaleLowerCase() === target.toLocaleLowerCase());
    const indexValue = exactIndex;
    const presetData = indexValue !== undefined && indexValue !== -1 && presets ? presets[indexValue] : undefined;
    const namesCount = Array.isArray(names)
        ? names.length
        : names && typeof names === 'object' ? Object.keys(names).length : 0;
    return {
        targetName: target,
        targetLength: target.length,
        currentName: currentName ?? null,
        currentLength: currentName ? String(currentName).length : 0,
        namesShape: Array.isArray(names) ? 'array' : names && typeof names === 'object' ? 'object' : typeof names,
        namesCount,
        namesSample: samplePresetNames(names),
        exactIndex,
        trimmedIndex,
        lowerIndex,
        indexType: typeof indexValue,
        presetsShape: Array.isArray(presets) ? 'array' : presets && typeof presets === 'object' ? 'object' : typeof presets,
        presetsLength: Array.isArray(presets) ? presets.length : undefined,
        hasPresetAtIndex: !!presetData,
        presetData: getPresetObjectInfo(presetData),
    };
}
