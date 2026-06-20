function normalizeQuery(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

export function buildGroupManagerSummary(nodes) {
    return (nodes || []).reduce((summary, node) => {
        const items = Array.isArray(node.items) ? node.items : [];
        summary.groups += 1;
        summary.presets += items.length;
        summary.manual += items.filter(item => item.manualOverride).length;
        return summary;
    }, { groups: 0, presets: 0, manual: 0 });
}

export function filterGroupingNodes(nodes, query) {
    const needle = normalizeQuery(query);
    return (nodes || []).flatMap(node => {
        const items = Array.isArray(node.items) ? node.items : [];
        const groupMatches = normalizeQuery(node.displayName).includes(needle);
        const matchingItems = needle && !groupMatches
            ? items.filter(item => normalizeQuery(item.presetName).includes(needle))
            : items;

        if (needle && !groupMatches && matchingItems.length === 0) return [];
        return [{ ...node, items: [...matchingItems] }];
    });
}
