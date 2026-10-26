/** Immutable organization commands; computed properties keep all keys literal. */
export function updateGroupAlias(aliases, key, value, automaticName, normalize) {
    const canonicalKey = normalize(key);
    const next = Object.fromEntries(Object.entries(aliases || {})
        .filter(([entryKey]) => normalize(entryKey) !== canonicalKey));
    return value === automaticName ? next : { ...next, [key]: value };
}

export function setGroupParent(tree, child, parent) {
    const next = { ...tree };
    if (parent === null) {
        delete next[child];
        return next;
    }
    return { ...next, [child]: parent };
}

export function removeGroupParent(tree, key) {
    const parent = Object.hasOwn(tree, key) && typeof tree[key] === 'string' ? tree[key] : null;
    return Object.fromEntries(Object.entries(tree).flatMap(([child, value]) => {
        if (child === key) return [];
        if (value !== key) return [[child, value]];
        return parent ? [[child, parent]] : [];
    }));
}

export function selectGroupDefault(defaults, key, presetName, { toggle = false } = {}) {
    if (toggle && Object.hasOwn(defaults || {}, key) && defaults[key] === presetName) {
        const next = { ...defaults };
        delete next[key];
        return next;
    }
    return { ...defaults, [key]: presetName };
}
