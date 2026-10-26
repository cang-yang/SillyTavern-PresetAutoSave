import { stableStringify } from './value-utils.js';

const targetKey = target => JSON.stringify([target?.apiId, target?.presetName]);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {}, key))
    .map(key => [key, value[key]]));

export function selectEditScope(preset, scope) {
    if (!scope) return undefined;
    if (scope.kind === 'field') return preset?.[scope.key];
    if (scope.kind === 'fields') return pick(preset, scope.keys || []);
    if (scope.kind === 'prompts') return preset?.prompts;
    if (scope.kind === 'prompt') {
        const entries = preset?.prompts?.filter(item => item?.identifier === scope.identifier) || [];
        return scope.fields ? entries.map(item => pick(item, scope.fields)) : entries;
    }
    if (scope.kind === 'order') {
        const groups = (preset?.prompt_order || []).filter(group =>
            scope.characterId === undefined || group?.character_id === scope.characterId);
        return groups.map(group => ({
            character_id: group.character_id,
            order: scope.identifier === undefined ? group.order
                : (group.order || []).flatMap((entry, index) => entry?.identifier === scope.identifier
                    ? [{ ...entry, index }] : []),
        }));
    }
    return undefined;
}

export function editScopeChanged(before, after, scope) {
    return stableStringify(selectEditScope(before, scope)) !== stableStringify(selectEditScope(after, scope));
}

function freeze(value) {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
}

/** Observations cannot mint requests; only a scoped editing delta can. */
export function createEditIntentOwner() {
    const pending = new Map();
    let revision = 0;
    return Object.freeze({
        record({ target, before, after, scope, source }) {
            if (!target?.apiId || !target?.presetName || !editScopeChanged(before, after, scope)) return null;
            const edit = freeze(structuredClone({
                apiId: target.apiId, presetName: target.presetName, preset: after,
                editRevision: ++revision, source, scope,
            }));
            pending.set(targetKey(target), { edit, submitted: false });
            return edit;
        },
        peek(target) {
            const entry = pending.get(targetKey(target));
            return entry && !entry.submitted ? entry.edit : null;
        },
        has(target) { return pending.has(targetKey(target)); },
        latest(target) { return pending.get(targetKey(target))?.edit || null; },
        submitted(edit) {
            const entry = pending.get(targetKey(edit));
            if (entry?.edit.editRevision === edit.editRevision) entry.submitted = true;
        },
        acknowledge(edit) {
            const entry = pending.get(targetKey(edit));
            if (entry && entry.edit.editRevision <= edit.editRevision) pending.delete(targetKey(edit));
        },
        discard(target) { pending.delete(targetKey(target)); },
        clear() { pending.clear(); },
    });
}
