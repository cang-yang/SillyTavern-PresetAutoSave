import { stableStringify } from './value-utils.js';

const PREVIEW_LIMIT = 80;

function describeValue(value) {
    if (typeof value === 'string' && value.length > PREVIEW_LIMIT) {
        return { length: value.length, preview: value.slice(0, PREVIEW_LIMIT) };
    }
    if (typeof value === 'string') {
        return { length: value.length, preview: value };
    }
    return value;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function joinPath(parent, key) {
    return parent ? `${parent}.${key}` : key;
}

function pushChange(changed, path, kind, before, after) {
    changed.push({
        path,
        kind,
        before: describeValue(before),
        after: describeValue(after),
    });
}

function diffPromptArray(before, after, path, changed) {
    const beforeMap = new Map(before.map(item => [item?.identifier, item]).filter(([id]) => id));
    const afterMap = new Map(after.map(item => [item?.identifier, item]).filter(([id]) => id));
    const identifiers = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();

    for (const identifier of identifiers) {
        const itemPath = `${path}[${identifier}]`;
        if (!beforeMap.has(identifier)) {
            pushChange(changed, itemPath, 'added', undefined, afterMap.get(identifier));
        } else if (!afterMap.has(identifier)) {
            pushChange(changed, itemPath, 'removed', beforeMap.get(identifier), undefined);
        } else {
            diffValue(beforeMap.get(identifier), afterMap.get(identifier), itemPath, changed);
        }
    }
}

function diffArray(before, after, path, changed) {
    if (path === 'prompts' && [...before, ...after].every(item => !item || item.identifier)) {
        diffPromptArray(before, after, path, changed);
        return;
    }

    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) {
        const itemPath = `${path}[${index}]`;
        if (index >= before.length) {
            pushChange(changed, itemPath, 'added', undefined, after[index]);
        } else if (index >= after.length) {
            pushChange(changed, itemPath, 'removed', before[index], undefined);
        } else {
            diffValue(before[index], after[index], itemPath, changed);
        }
    }
}

function diffObject(before, after, path, changed) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
        const itemPath = joinPath(path, key);
        if (!Object.hasOwn(before, key)) {
            pushChange(changed, itemPath, 'added', undefined, after[key]);
        } else if (!Object.hasOwn(after, key)) {
            pushChange(changed, itemPath, 'removed', before[key], undefined);
        } else {
            diffValue(before[key], after[key], itemPath, changed);
        }
    }
}

function diffValue(before, after, path, changed) {
    if (stableStringify(before) === stableStringify(after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
        diffArray(before, after, path, changed);
        return;
    }
    if (isObject(before) && isObject(after)) {
        diffObject(before, after, path, changed);
        return;
    }
    const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    pushChange(changed, path, kind, before, after);
}

export function createChangeSet(before, after) {
    const changed = [];
    diffValue(before ?? {}, after ?? {}, '', changed);
    const counts = { added: 0, removed: 0, modified: 0 };
    for (const item of changed) counts[item.kind]++;
    return {
        meaningful: changed.length > 0,
        changed,
        counts,
    };
}

export function assertExplainableChange(before, after, changeSet) {
    if (stableStringify(before) !== stableStringify(after) && !changeSet?.changed?.length) {
        throw new Error('Unexplained canonical change');
    }
}
