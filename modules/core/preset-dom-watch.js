/** Containers that own editable preset-generation controls in SillyTavern. */
export const PRESET_WATCH_SELECTORS = Object.freeze([
    '#common-gen-settings-block',
    '#openai_settings',
    '#completion_prompt_manager',
    '#range_block_openai',
    '#textgenerationwebui_api-settings',
    '#range_block_textgenerationwebui',
    '#kobold_api-settings',
    '#range_block_kobold',
    '#novel_api-settings',
    '#range_block_novel',
]);

export function isInsidePresetWatchArea(element) {
    if (!element?.closest) return false;
    for (const selector of PRESET_WATCH_SELECTORS) {
        try {
            if (element.closest(selector)) return true;
        } catch (_) {
            // A malformed host selector must not break user input handling.
        }
    }
    return false;
}
