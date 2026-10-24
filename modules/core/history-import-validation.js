import { requireCanonicalPreset, PRESET_CONTRACT_VERSION } from './preset-schema.js';

const isObject = value => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isString = value => typeof value === 'string';
const isBoolean = value => typeof value === 'boolean';
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const isCount = value => Number.isInteger(value) && value >= 0;

function requireType(value, predicate, path) {
    if (!predicate(value)) throw new TypeError(`Invalid imported snapshot field: ${path}`);
}

function optional(object, key, predicate, path) {
    if (Object.hasOwn(object, key)) requireType(object[key], predicate, `${path}.${key}`);
}

function objectArray(value, path, inspect = () => {}) {
    requireType(value, Array.isArray, path);
    value.forEach((item, index) => {
        requireType(item, isObject, `${path}[${index}]`);
        inspect(item, `${path}[${index}]`);
    });
}

function jsonValue(value, path, ancestors = new Set()) {
    if (value === null || isString(value) || isBoolean(value) || isNumber(value)) return;
    requireType(value, item => Array.isArray(item) || isObject(item), path);
    if (ancestors.has(value)) throw new TypeError(`Circular imported snapshot field: ${path}`);
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireType(descriptor, item => typeof key === 'string' && item.enumerable && Object.hasOwn(item, 'value'), path);
        jsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
}

function counts(value, path) {
    requireType(value, isObject, path);
    for (const [key, count] of Object.entries(value)) requireType(count, isCount, `${path}.${key}`);
}

function paths(value) {
    return Array.isArray(value) && value.every(isString);
}

function summaryField(item, path) {
    for (const key of ['key', 'kind', 'identifier', 'name', 'groupId']) optional(item, key, isString, path);
    for (const key of ['marker', 'isContent']) optional(item, key, isBoolean, path);
    for (const key of ['count', 'fromLen', 'toLen']) optional(item, key, isCount, path);
    if (Object.hasOwn(item, 'fields')) objectArray(item.fields, `${path}.fields`, summaryField);
}

function summary(value, path) {
    if (value === null) return;
    requireType(value, isObject, path);
    for (const key of ['isFirst', 'unchanged', 'onlyIgnoredChanges']) optional(value, key, isBoolean, path);
    for (const key of ['rawChangedPaths', 'ignoredPaths']) optional(value, key, paths, path);
    if (Object.hasOwn(value, 'counts')) counts(value.counts, `${path}.counts`);
    if (Object.hasOwn(value, 'sections')) {
        objectArray(value.sections, `${path}.sections`, (section, sectionPath) => {
            requireType(section.kind, isString, `${sectionPath}.kind`);
            objectArray(section.items, `${sectionPath}.items`, summaryField);
        });
    }
    if (Object.hasOwn(value, 'details')) objectArray(value.details, `${path}.details`, summaryField);
    if (Object.hasOwn(value, 'tags')) {
        objectArray(value.tags, `${path}.tags`, (tag, tagPath) => {
            optional(tag, 'label', isString, tagPath);
            optional(tag, 'type', isString, tagPath);
            optional(tag, 'count', isCount, tagPath);
        });
    }
}

const NUMBER_FIELDS = new Set([
    'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k',
    'top_a', 'min_p', 'repetition_penalty', 'openai_max_context', 'openai_max_tokens',
    'names_behavior', 'tool_call_recurse_limit', 'seed', 'n',
]);
const BOOLEAN_FIELDS = new Set([
    'max_context_unlocked', 'stream_openai', 'continue_prefill', 'use_sysprompt',
    'squash_system_messages', 'media_inlining', 'function_calling', 'show_thoughts',
    'enable_web_search', 'request_images',
]);

function presetShape(canonical, apiId) {
    for (const [key, value] of Object.entries(canonical)) {
        const path = `preset.${key}`;
        if (key === 'prompts') {
            objectArray(value, path, (prompt, promptPath) => {
                for (const field of ['identifier', 'name', 'content', 'role']) optional(prompt, field, isString, promptPath);
                for (const field of ['system_prompt', 'marker', 'forbid_overrides']) optional(prompt, field, isBoolean, promptPath);
                for (const field of ['injection_position', 'injection_depth', 'injection_order']) optional(prompt, field, isNumber, promptPath);
                optional(prompt, 'injection_trigger', paths, promptPath);
            });
        } else if (key === 'prompt_order') {
            objectArray(value, path, (group, groupPath) => {
                optional(group, 'character_id', item => isString(item) || isNumber(item), groupPath);
                objectArray(group.order, `${groupPath}.order`, (entry, entryPath) => {
                    requireType(entry.identifier, isString, `${entryPath}.identifier`);
                    optional(entry, 'enabled', isBoolean, entryPath);
                });
            });
        } else if (key === 'extensions') {
            requireType(value, isObject, path);
        } else if (apiId === 'openai' && key === 'wi_format') {
            // Legacy enum values and current template strings are both displayed.
            requireType(value, item => isString(item) || isNumber(item), path);
        } else if (apiId === 'openai') {
            requireType(value, NUMBER_FIELDS.has(key) ? isNumber : BOOLEAN_FIELDS.has(key) ? isBoolean : isString, path);
        }
    }
}

/**
 * Strict external boundary only. Existing stored records and rescue exports
 * remain readable without applying new-import acceptance rules.
 */
export function validateImportedSnapshot(snapshot, apiId) {
    jsonValue(snapshot, 'snapshot');
    optional(snapshot, 'pinned', isBoolean, 'snapshot');
    for (const key of ['name', 'hash', 'canonicalHash', 'trigger', 'transactionId']) {
        optional(snapshot, key, isString, 'snapshot');
    }
    optional(snapshot, 'parentSnapshotId', value => value === null || isString(value), 'snapshot');
    optional(snapshot, 'size', value => isNumber(value) && value >= 0, 'snapshot');
    optional(snapshot, 'schemaVersion', value => value === 1 || value === 2, 'snapshot');
    optional(snapshot, 'contractVersion', value => value === PRESET_CONTRACT_VERSION, 'snapshot');
    // Diagnostic status strings are extensible; preserve explicit partial states.
    optional(snapshot, 'saveStatus', value => isString(value) && value.trim() !== '', 'snapshot');
    if (Object.hasOwn(snapshot, 'cause')) {
        requireType(snapshot.cause, isObject, 'snapshot.cause');
        optional(snapshot.cause, 'trigger', isString, 'snapshot.cause');
    }
    if (Object.hasOwn(snapshot, 'summary')) summary(snapshot.summary, 'snapshot.summary');
    if (Object.hasOwn(snapshot, 'changeSet')) {
        const changeSet = snapshot.changeSet;
        requireType(changeSet, isObject, 'snapshot.changeSet');
        optional(changeSet, 'meaningful', isBoolean, 'snapshot.changeSet');
        optional(changeSet, 'changedPaths', paths, 'snapshot.changeSet');
        if (Object.hasOwn(changeSet, 'counts')) counts(changeSet.counts, 'snapshot.changeSet.counts');
    }
    const canonical = requireCanonicalPreset(snapshot.preset, { apiId });
    presetShape(canonical, apiId);
    return canonical;
}
