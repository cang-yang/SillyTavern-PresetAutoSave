import { findCanonicalGroup } from './group-projection.js';

/** Return a fresh override map for one organization operation. */
export function movePresetMembership({
    presetName, targetKey, automaticKey, groups, overrides, newGroupName = null,
}) {
    const next = { ...overrides };
    if (targetKey === '__auto__' || targetKey === automaticKey) {
        delete next[presetName];
        return next;
    }
    const target = findCanonicalGroup(groups, targetKey);
    next[presetName] = target?.automaticName || newGroupName || targetKey;
    return next;
}

export function removeGroupMembership({ canonicalKey, groups, overrides }) {
    const next = { ...overrides };
    const group = findCanonicalGroup(groups, canonicalKey);
    for (const item of group?.items || []) delete next[item.presetName];
    return next;
}
