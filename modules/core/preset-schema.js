import { normalizeBooleanString, normalizeNumberString, normalizeValue } from './value-utils.js';

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
]);

function pathRoot(path) {
    const match = String(path ?? '').match(/^[^.[\]]+/);
    return match?.[0] ?? '';
}

export function isHistoryOwnedPath(path, { apiId = 'openai' } = {}) {
    const root = pathRoot(path);
    if (!root) return false;
    if (apiId !== 'openai') return !CONNECTION_FIELDS.has(root);
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
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
        throw new TypeError('Preset root must be a plain object');
    }

    const canonical = {};
    const ignored = [];
    for (const key of Object.keys(preset).sort()) {
        if (CONNECTION_FIELDS.has(key)) {
            ignored.push({ path: key, reason: 'connection-setting' });
            continue;
        }
        if (apiId === 'openai' && !OPENAI_PRESET_FIELDS.has(key)) {
            ignored.push({ path: key, reason: 'runtime-or-unknown-setting' });
            continue;
        }
        canonical[key] = normalizePresetField(key, preset[key]);
    }
    return { canonical, ignored };
}
