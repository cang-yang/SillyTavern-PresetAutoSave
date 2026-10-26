import { normalizeBooleanString, normalizeNumberString, normalizeValue, stableStringify } from './value-utils.js';

export const PRESET_CONTRACT_VERSION = 1;
const CREDENTIAL_KEYS = [
    'apikey', 'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken',
    'clientsecret', 'secretkey', 'authorization', 'proxypassword',
    'proxyauthorization', 'xapikey',
];
function normalizeConnectionKey(key) {
    return key.replace(/[_-]/g, '').toLowerCase();
}

function isCredentialKey(normalized, value) {
    return CREDENTIAL_KEYS.some(marker => normalized.startsWith(marker) || normalized.endsWith(marker))
        || (typeof value === 'string' && ['token', 'password'].includes(normalized));
}

export function connectionExclusionReason(key, value) {
    const normalized = normalizeConnectionKey(key);
    if (NORMALIZED_CONNECTION_FIELDS.has(normalized)) return 'connection-setting';
    return isCredentialKey(normalized, value) ? 'connection-credential' : '';
}

function removeConnectionFields(value, path, ignored) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map((item, index) => removeConnectionFields(item, `${path}[${index}]`, ignored));
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        const itemPath = `${path}.${key}`;
        const reason = connectionExclusionReason(key, item);
        if (reason) {
            ignored.push({ path: itemPath, reason });
            continue;
        }
        Object.defineProperty(output, key, {
            value: removeConnectionFields(item, itemPath, ignored),
            enumerable: true, writable: true, configurable: true,
        });
    }
    return output;
}

/** Sanitize structured metadata without inspecting or rewriting literal prose. */
export function sanitizeConnectionData(value) {
    validateJson(value, 'data');
    return removeConnectionFields(value, '', []);
}
export const FIELD_SYNONYMS = new Map([
    ['temp_openai', 'temperature'], ['freq_pen_openai', 'frequency_penalty'],
    ['pres_pen_openai', 'presence_penalty'], ['top_p_openai', 'top_p'],
    ['top_k_openai', 'top_k'], ['top_a_openai', 'top_a'],
    ['min_p_openai', 'min_p'], ['repetition_penalty_openai', 'repetition_penalty'],
    ['streaming', 'stream_openai'],
]);

export function normalizePresetFields(preset) {
    const result = { ...preset };
    for (const [alias, canonical] of FIELD_SYNONYMS) {
        if (!Object.hasOwn(result, alias)) continue;
        if (!Object.hasOwn(result, canonical)) result[canonical] = result[alias];
        delete result[alias];
    }
    return result;
}

export const CONNECTION_FIELDS = new Set([
    'api_key_openai',
    'proxy_password',
    'reverse_proxy',
    'chat_completion_source',
    'group_models',
    'sort_models',
    'api_url_scale',
    'custom_url',
    'custom_api_format',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'custom_claude_prompt_caching',
    'custom_prompt_post_processing',
    'openai_model',
    'openrouter_model',
    'claude_model',
    'google_model',
    'ai21_model',
    'mistralai_model',
    'cohere_model',
    'perplexity_model',
    'groq_model',
    'zerooneai_model',
    'blockentropy_model',
    'custom_model',
    'vertexai_model',
    'deepseek_model',
    'aimlapi_model',
    'xai_model',
    'pollinations_model',
    'cometapi_model',
    'moonshot_model',
    'fireworks_model',
    'zai_model',
    'azure_openai_model',
    'chutes_model',
    'siliconflow_model',
    'electronhub_model',
    'nanogpt_model',
    'minimax_model',
    'workers_ai_model',
    'model_list',
    'openrouter_model_list',
    'azure_base_url',
    'azure_deployment_name',
    'azure_api_version',
    'vertexai_auth_mode',
    'vertexai_region',
    'vertexai_express_project_id',
    'openrouter_use_fallback',
    'openrouter_group_models',
    'openrouter_sort_models',
    'openrouter_providers',
    'openrouter_quantizations',
    'openrouter_allow_fallbacks',
    'openrouter_middleout',
    'chutes_sort_models',
    'chutes_group_models',
    'electronhub_sort_models',
    'electronhub_group_models',
    'zai_endpoint',
    'siliconflow_endpoint',
    'minimax_endpoint',
    'workers_ai_account_id',
    'nanogpt_provider',
    'nanogpt_payg_override',
    'show_external_models',
    'bypass_status_check',
    'bind_preset_to_connection',
    'preset_settings_openai',
]);
const NORMALIZED_CONNECTION_FIELDS = new Set([...CONNECTION_FIELDS].map(normalizeConnectionKey));

// SillyTavern's native Chat Completion preset contract. This mirrors the
// entries in openai.js/settingsToUpdate whose is_connection flag is false.
// OpenAI live settings also contain provider state, UI caches and values
// injected by extensions; those values must never silently become history.
export const OPENAI_PRESET_FIELDS = new Set([
    'temperature', 'frequency_penalty', 'presence_penalty',
    'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
    'max_context_unlocked', 'tool_reasoning_mode',
    'openai_max_context', 'openai_max_tokens', 'names_behavior',
    'send_if_empty', 'impersonation_prompt', 'new_chat_prompt',
    'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt',
    'bias_preset_selected', 'wi_format', 'scenario_format', 'personality_format',
    'group_nudge_prompt', 'stream_openai', 'prompts', 'prompt_order',
    'assistant_prefill', 'assistant_impersonation', 'use_sysprompt',
    'squash_system_messages', 'media_inlining', 'inline_image_quality',
    'continue_prefill', 'continue_postfix', 'function_calling',
    'tool_call_recurse_limit', 'show_thoughts', 'reasoning_effort', 'verbosity',
    'enable_web_search', 'seed', 'n', 'request_images',
    'request_image_aspect_ratio', 'request_image_resolution', 'extensions',
]);

// These are native ST controls, but they are backed by separate global state
// rather than the completion preset payload observed by every save path.
export const OPENAI_HISTORY_EXCLUDED_FIELDS = new Set([
    'bias_preset_selected',
    'bias_presets',
]);

export const EXPORT_EXCLUDED_FIELDS = new Set([...CONNECTION_FIELDS, ...OPENAI_HISTORY_EXCLUDED_FIELDS]);
export const DISPLAY_IGNORED_FIELDS = new Set([
    ...EXPORT_EXCLUDED_FIELDS, 'prompts', 'prompt_order', 'extensions', 'name',
]);

export function presetFieldExclusionReason(key, value, { apiId = 'openai' } = {}) {
    const connectionReason = connectionExclusionReason(key, value);
    if (EXPORT_EXCLUDED_FIELDS.has(key) || connectionReason) {
        return connectionReason || 'separate-global-state';
    }
    return apiId === 'openai' && !OPENAI_PRESET_FIELDS.has(key) ? 'runtime-or-unknown-setting' : '';
}

export function appendPresetPath(parent, key) {
    const segment = String(key);
    return /^[A-Za-z_$][\w$]*$/.test(segment)
        ? `${parent ? `${parent}.` : ''}${segment}`
        : `${parent}[${JSON.stringify(segment)}]`;
}

export function presetValueError(path, valueType, code = 'PRESET_NON_JSON') {
    const safePath = path.length > 240 ? `${path.slice(0, 237)}...` : path;
    const error = new TypeError(`Preset contains a ${code === 'PRESET_CIRCULAR' ? 'circular' : 'non-JSON'} value at ${safePath} (${valueType})`);
    Object.assign(error, { code, path: safePath, valueType });
    return error;
}

export function extractCanonicalForDiff(preset) {
    const canonical = canonicalizePreset(preset).canonical;
    return Object.fromEntries(Object.entries(canonical).filter(([key]) => !DISPLAY_IGNORED_FIELDS.has(key)));
}

export function filterExtensionPrompts(prompts) {
    // Identifier shape is not proof that a persisted user definition is transient.
    return Array.isArray(prompts) ? structuredClone(prompts) : prompts;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateJson(value, path, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !isPlainObject(value)) {
        const type = typeof value === 'number' ? 'non-finite-number'
            : typeof value === 'object' ? 'non-plain-object' : typeof value;
        throw presetValueError(path, type);
    }
    if (ancestors.has(value)) throw presetValueError(path, 'object', 'PRESET_CIRCULAR');
    ancestors.add(value);
    const array = Array.isArray(value);
    const keys = Reflect.ownKeys(value).filter(key => Object.getOwnPropertyDescriptor(value, key).enumerable);
    if (array && keys.length !== value.length) throw presetValueError(path, 'sparse-or-extended-array');
    for (const key of keys) {
        if (typeof key !== 'string') throw presetValueError(path, 'symbol-key');
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
            throw presetValueError(path, 'array-property');
        }
        const itemPath = Array.isArray(value) ? `${path}[${key}]` : appendPresetPath(path, key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, 'value')) throw presetValueError(itemPath, 'accessor');
        validateJson(descriptor.value, itemPath, ancestors);
    }
    ancestors.delete(value);
}

export function requireCanonicalPreset(preset, options = {}) {
    const canonical = canonicalizePreset(preset, options).canonical;
    if (Object.keys(canonical).length === 0) throw new TypeError('Preset contains no canonical fields');
    return canonical;
}

export function hashCanonicalPreset(preset, options = {}) {
    const serialized = stableStringify(canonicalizePreset(preset, options).canonical);
    return hashPresetSerialization(serialized);
}

export function hashPresetSerialization(serialized) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index++) {
        hash ^= serialized.charCodeAt(index);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

function pathRoot(path) {
    const match = String(path ?? '').match(/^[^.[\]]+/);
    return match?.[0] ?? '';
}

export function isHistoryOwnedPath(path, { apiId = 'openai' } = {}) {
    const root = pathRoot(path);
    if (!root) return false;
    if (apiId !== 'openai') return !EXPORT_EXCLUDED_FIELDS.has(root);
    return OPENAI_PRESET_FIELDS.has(root) && !OPENAI_HISTORY_EXCLUDED_FIELDS.has(root);
}

const NUMBER_FIELDS = new Set([
    'temperature', 'frequency_penalty', 'presence_penalty',
    'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
    'openai_max_context', 'openai_max_tokens', 'names_behavior',
    'tool_call_recurse_limit', 'seed', 'n',
]);

const BOOLEAN_FIELDS = new Set([
    'max_context_unlocked', 'stream_openai', 'continue_prefill',
    'use_sysprompt', 'squash_system_messages', 'media_inlining',
    'function_calling', 'show_thoughts', 'enable_web_search',
    'request_images',
]);

function normalizePresetField(key, value) {
    if (typeof value === 'string' && NUMBER_FIELDS.has(key)) {
        return normalizeNumberString(value);
    }
    if (typeof value === 'string' && BOOLEAN_FIELDS.has(key)) {
        return normalizeBooleanString(value);
    }
    return normalizeValue(value);
}

export function canonicalizePreset(preset, { apiId = 'openai' } = {}) {
    if (!isPlainObject(preset)) {
        throw new TypeError('Preset root must be a plain object');
    }

    const canonical = {};
    const ignored = [];
    for (const key of Object.getOwnPropertySymbols(preset)) {
        if (Object.getOwnPropertyDescriptor(preset, key).enumerable) throw presetValueError('preset', 'symbol-key');
    }
    const fields = Object.keys(preset).flatMap(source => {
        const key = FIELD_SYNONYMS.get(source) || source;
        if (key !== source && Object.hasOwn(preset, key)) return [];
        return [{ key, descriptor: Object.getOwnPropertyDescriptor(preset, source) }];
    }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    for (const { key, descriptor } of fields) {
        const reason = presetFieldExclusionReason(key, descriptor.value, { apiId });
        if (reason) {
            ignored.push({ path: key, reason });
            continue;
        }
        if (!Object.hasOwn(descriptor, 'value')) throw presetValueError(appendPresetPath('', key), 'accessor');
        validateJson(descriptor.value, appendPresetPath('', key));
        const value = removeConnectionFields(descriptor.value, key, ignored);
        Object.defineProperty(canonical, key, {
            value: normalizePresetField(key, value), enumerable: true, writable: true, configurable: true,
        });
    }
    return { canonical, ignored };
}
