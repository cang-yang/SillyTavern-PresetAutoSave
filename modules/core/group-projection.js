/**
 * Project parsed preset membership into canonical groups. Display collisions
 * can only change labels; they can never change a group key or its members.
 */
export function projectPresetGroups(entries, { normalize, resolveName, compareVersion }) {
    const groupsByKey = new Map();
    for (const entry of entries) {
        const automaticName = entry.series || entry.presetName;
        const canonicalKey = normalize(automaticName);
        if (!groupsByKey.has(canonicalKey)) {
            const resolved = resolveName(automaticName);
            groupsByKey.set(canonicalKey, {
                key: canonicalKey,
                canonicalKey,
                automaticName,
                displayName: resolved.displayName,
                series: resolved.displayName,
                customized: resolved.customized,
                items: [],
            });
        }
        groupsByKey.get(canonicalKey).items.push({
            presetName: entry.presetName,
            version: entry.version,
            duplicate: entry.duplicate,
            kind: entry.kind,
            manualOverride: entry.manualOverride,
        });
    }

    const groups = [...groupsByKey.values()];
    // Falling back can expose another collision with an automatic name.
    // Each iteration removes at least one alias, so this reaches a fixed point.
    let changed;
    do {
        changed = false;
        const counts = new Map();
        for (const group of groups) {
            const key = normalize(group.displayName);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (const group of groups) {
            if (!group.customized || counts.get(normalize(group.displayName)) < 2) continue;
            group.displayName = group.automaticName;
            group.series = group.automaticName;
            group.customized = false;
            changed = true;
        }
    } while (changed);

    for (const group of groups) {
        group.items.sort((left, right) => compareVersion(right.version, left.version));
    }
    return groups.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Exact preset names are identities, even when their group names normalize. */
export function indexPresetMembership(groups) {
    const membership = new Map();
    for (const group of groups) {
        for (const item of group.items) membership.set(item.presetName, group);
    }
    return membership;
}

/** Commands accept canonical keys, never labels or aliases. */
export function findCanonicalGroup(groups, canonicalKey) {
    return groups.find(group => group.canonicalKey === canonicalKey) || null;
}
