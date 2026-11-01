import { OPENAI_PRESET_FIELDS, EXPORT_EXCLUDED_FIELDS } from '../core/preset-schema.js';

// Native OpenAI settingsToUpdate selectors, plus its counter/radio handlers.
// DOM aliases belong here, not in the serialized preset field contract.
const OPENAI_CONTROLS = new Map([
    ['temperature', 'temp_openai'],
    ['frequency_penalty', 'freq_pen_openai'],
    ['presence_penalty', 'pres_pen_openai'],
    ['top_p', 'top_p_openai'],
    ['top_k', 'top_k_openai'],
    ['top_a', 'top_a_openai'],
    ['min_p', 'min_p_openai'],
    ['repetition_penalty', 'repetition_penalty_openai'],
    ['max_context_unlocked', 'oai_max_context_unlocked'],
    ['openai_max_context', 'openai_max_context'],
    ['openai_max_tokens', 'openai_max_tokens'],
    ['names_behavior', 'names_behavior', 'character_names_none', 'character_names_default',
        'character_names_completion', 'character_names_content'],
    ['send_if_empty', 'send_if_empty_textarea'],
    ['impersonation_prompt', 'impersonation_prompt_textarea'],
    ['new_chat_prompt', 'newchat_prompt_textarea'],
    ['new_group_chat_prompt', 'newgroupchat_prompt_textarea'],
    ['new_example_chat_prompt', 'newexamplechat_prompt_textarea'],
    ['continue_nudge_prompt', 'continue_nudge_prompt_textarea'],
    ['wi_format', 'wi_format_textarea'],
    ['scenario_format', 'scenario_format_textarea'],
    ['personality_format', 'personality_format_textarea'],
    ['group_nudge_prompt', 'group_nudge_prompt_textarea'],
    ['stream_openai', 'stream_toggle'],
    ['assistant_prefill', 'claude_assistant_prefill'],
    ['assistant_impersonation', 'claude_assistant_impersonation'],
    ['use_sysprompt', 'use_sysprompt'],
    ['squash_system_messages', 'squash_system_messages'],
    ['media_inlining', 'openai_media_inlining'],
    ['inline_image_quality', 'openai_inline_image_quality'],
    ['continue_prefill', 'continue_prefill'],
    ['continue_postfix', 'continue_postfix', 'continue_postifx', 'continue_postfix_none',
        'continue_postfix_space', 'continue_postfix_newline', 'continue_postfix_double_newline'],
    ['function_calling', 'openai_function_calling'],
    ['tool_call_recurse_limit', 'tool_call_recurse_limit'],
    ['tool_reasoning_mode', 'tool_reasoning_mode'],
    ['show_thoughts', 'openai_show_thoughts'],
    ['reasoning_effort', 'openai_reasoning_effort'],
    ['verbosity', 'openai_verbosity'],
    ['enable_web_search', 'openai_enable_web_search'],
    ['seed', 'seed_openai'],
    ['n', 'n_openai'],
    ['request_images', 'openai_request_images'],
    ['request_image_aspect_ratio', 'request_image_aspect_ratio'],
    ['request_image_resolution', 'request_image_resolution'],
].flatMap(([key, ...ids]) => [key, ...ids].map(id => [id, key])));

const NOVEL_ALIASES = new Map([
    ['temp', 'temperature'], ['rep_pen', 'repetition_penalty'],
    ['rep_pen_size', 'repetition_penalty_range'], ['rep_pen_slope', 'repetition_penalty_slope'],
    ['rep_pen_freq', 'repetition_penalty_frequency'], ['rep_pen_presence', 'repetition_penalty_presence'],
]);

export function resolvePresetControlField(id, { apiId = 'openai', preset } = {}) {
    const controlId = String(id || '').replace(/_counter(?=_|$)/, '');
    if (apiId === 'openai') {
        const key = OPENAI_CONTROLS.get(controlId);
        return OPENAI_PRESET_FIELDS.has(key) && !EXPORT_EXCLUDED_FIELDS.has(key) ? key : null;
    }
    const suffix = apiId === 'textgenerationwebui' ? '_textgenerationwebui'
        : apiId === 'novel' ? '_novel' : '';
    const plainId = controlId.replace(/_text$/, '');
    const nativeKey = suffix && plainId.endsWith(suffix) ? plainId.slice(0, -suffix.length) : plainId;
    const key = apiId === 'novel' ? NOVEL_ALIASES.get(nativeKey) || nativeKey : nativeKey;
    const value = preset?.[key];
    return Object.hasOwn(preset || {}, key) && !EXPORT_EXCLUDED_FIELDS.has(key)
        && (value == null || ['string', 'number', 'boolean'].includes(typeof value)) ? key : null;
}
