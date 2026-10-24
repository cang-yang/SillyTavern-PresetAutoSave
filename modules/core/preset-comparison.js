import { canonicalizePreset } from './preset-schema.js';
import { createChangeSet, assertExplainableChange } from './change-set.js';
import { stableStringify } from './value-utils.js';

function promptName(prompt) {
    return typeof prompt?.name === 'string' && prompt.name.trim()
        ? prompt.name.trim() : '';
}

function uniquePromptMap(prompts) {
    if (!Array.isArray(prompts)) return new Map();
    const map = new Map();
    for (const prompt of prompts) {
        if (!prompt?.identifier || map.has(prompt.identifier)) return null;
        map.set(prompt.identifier, prompt);
    }
    return map;
}

export function indexPromptOrder(groups) {
    const result = new Map();
    if (!Array.isArray(groups)) return result;
    const counts = new Map();
    for (const group of groups) {
        const id = JSON.stringify(group?.character_id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    groups.forEach((group, groupIndex) => {
        const id = JSON.stringify(group?.character_id);
        const groupId = group?.character_id !== undefined && counts.get(id) === 1
            ? `character:${id}` : `index:${groupIndex}`;
        const entries = Array.isArray(group?.order) ? group.order : [];
        const ids = new Map();
        for (const entry of entries) ids.set(entry?.identifier, (ids.get(entry?.identifier) ?? 0) + 1);
        entries.forEach((entry, index) => {
            const identifier = entry?.identifier;
            const key = JSON.stringify([groupId, identifier && ids.get(identifier) === 1 ? identifier : index]);
            result.set(key, { groupId, groupIndex, identifier, index, enabled: entry?.enabled, entry });
        });
    });
    return result;
}

function summarize(before, after, changeSet, ignoredPaths, isFirst) {
    const summary = {
        isFirst, sections: [],
        counts: { promptAdded: 0, promptRemoved: 0, promptModified: 0, promptReordered: 0,
            promptToggledOn: 0, promptToggledOff: 0, fieldChanged: 0 },
        rawChangedPaths: changeSet.changed.map(item => item.path),
        ignoredPaths,
        unchanged: !changeSet.meaningful,
        onlyIgnoredChanges: !changeSet.meaningful && ignoredPaths.length > 0,
    };
    if (isFirst || !changeSet.meaningful) return summary;
    const represented = new Set();
    const addSection = (kind, items, countKey) => {
        if (!items.length) return;
        summary.sections.push({ kind, items });
        summary.counts[countKey] = items.length;
    };
    const previous = uniquePromptMap(before.prompts);
    const current = uniquePromptMap(after.prompts);
    if (previous && current) {
        const added = [], removed = [], edited = [];
        for (const identifier of new Set([...previous.keys(), ...current.keys()])) {
            const a = previous.get(identifier), b = current.get(identifier);
            const path = `prompts[${identifier}]`;
            if (!a || !b) {
                (b ? added : removed).push({ identifier, name: promptName(b ?? a), marker: !!(b ?? a).marker });
                represented.add(path);
                continue;
            }
            const fields = [];
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
                if (stableStringify(a[key]) === stableStringify(b[key])) continue;
                fields.push(key === 'content'
                    ? { key, isContent: true, fromLen: typeof a[key] === 'string' ? a[key].length : 0,
                        toLen: typeof b[key] === 'string' ? b[key].length : 0 }
                    : { key, from: a[key], to: b[key] });
                for (const change of changeSet.changed) {
                    if (change.path === `${path}.${key}` || change.path.startsWith(`${path}.${key}[`)
                        || change.path.startsWith(`${path}.${key}.`)) represented.add(change.path);
                }
            }
            if (fields.length) edited.push({ identifier, name: promptName(b), fields });
        }
        addSection('prompt-add', added, 'promptAdded');
        addSection('prompt-del', removed, 'promptRemoved');
        addSection('prompt-edit', edited, 'promptModified');
    }
    const previousOrder = indexPromptOrder(before.prompt_order);
    const currentOrder = indexPromptOrder(after.prompt_order);
    const toggledOn = [], toggledOff = [];
    let reordered = 0;
    for (const [key, entry] of currentOrder) {
        const prior = previousOrder.get(key);
        if (!prior) continue;
        if (prior.index !== entry.index) reordered++;
        if (!!prior.enabled !== !!entry.enabled) {
            (entry.enabled ? toggledOn : toggledOff).push({
                identifier: entry.identifier,
                name: promptName(current?.get(entry.identifier)),
                groupId: entry.groupId,
            });
            const path = entry.groupId.startsWith('character:')
                ? `prompt_order[${entry.groupId}].order[${entry.index}].enabled`
                : `prompt_order[${entry.groupIndex}].order[${entry.index}].enabled`;
            represented.add(path);
        }
    }
    addSection('prompt-toggle-on', toggledOn, 'promptToggledOn');
    addSection('prompt-toggle-off', toggledOff, 'promptToggledOff');
    if (reordered) {
        summary.sections.push({ kind: 'prompt-reorder', items: [{ count: reordered }] });
        summary.counts.promptReordered = reordered;
    }
    // Generic paths guarantee that unfamiliar prompt/order/extension fields
    // remain visible even when the friendly sections have no special renderer.
    const fields = changeSet.changed.filter(change => !represented.has(change.path)).map(change => ({
        key: change.path, kind: 'scalar', from: change.before, to: change.after,
    }));
    if (fields.length) {
        summary.sections.push({ kind: 'field', items: fields });
        summary.counts.fieldChanged = fields.length;
    }
    return summary;
}

export function comparePresetStates(before, after, { apiId = 'openai' } = {}) {
    const canonicalBefore = canonicalizePreset(before ?? {}, { apiId }).canonical;
    const canonicalAfter = canonicalizePreset(after ?? {}, { apiId }).canonical;
    const changeSet = createChangeSet(canonicalBefore, canonicalAfter);
    assertExplainableChange(canonicalBefore, canonicalAfter, changeSet);
    const owned = new Set(changeSet.changed.map(item => item.path));
    const ignoredPaths = createChangeSet(before ?? {}, after ?? {}).changed
        .map(item => item.path).filter(path => !owned.has(path));
    return {
        before: canonicalBefore,
        after: canonicalAfter,
        changeSet,
        summary: summarize(canonicalBefore, canonicalAfter, changeSet, ignoredPaths, before == null),
    };
}
