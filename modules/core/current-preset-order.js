/** Stable presentation priority; caller-owned arrays and identities are untouched. */
export function currentFirst(items, isCurrent) {
    const current = [];
    const remaining = [];
    for (const item of items) (isCurrent(item) ? current : remaining).push(item);
    return [...current, ...remaining];
}

/** Copy a group tree, prioritizing the exact active name at every level. */
export function orderPresetTree(nodes, currentName) {
    const projected = nodes.map(node => {
        const items = currentFirst(node.items || [], name => name === currentName);
        const children = orderPresetTree(node.children || [], currentName);
        return { ...node, items, children,
            containsCurrentPreset: items.includes(currentName) || children.some(child => child.containsCurrentPreset) };
    });
    return currentFirst(projected, node => node.containsCurrentPreset);
}
