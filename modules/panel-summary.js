/**
 * @file Panel summary rendering — pure functions for change summary display
 *
 * Extracted from history-panel.js to reduce file size.
 * All functions are stateless; the only external dependency is `t()` from compatibility.
 */

import { t, escapeHtml, escapeAttr, formatTime } from './compatibility.js';

// Re-export：保持其他模块 `from './panel-summary.js'` 的导入不变
export { escapeHtml, escapeAttr, formatTime };

// =====================================================
// Utility
// =====================================================

// escapeAttr 已从 compatibility.js 导入并 re-export

// =====================================================
// Label dictionaries
// =====================================================

/**
 * 字段名词典：把内部 key 翻译成人话
 * 没在词典里的会回落到 key 原文（小写蛇形）
 */
export const FIELD_LABEL_KEYS = Object.freeze({
    temperature: 'Field temperature',
    top_p: 'Field top_p',
    top_k: 'Field top_k',
    min_p: 'Field min_p',
    top_a: 'Field top_a',
    tfs: 'Field tfs',
    typical_p: 'Field typical_p',
    frequency_penalty: 'Field frequency_penalty',
    presence_penalty: 'Field presence_penalty',
    repetition_penalty: 'Field repetition_penalty',
    reasoning_effort: 'Field reasoning_effort',
    show_thoughts: 'Field show_thoughts',
    max_context_unlocked: 'Field max_context_unlocked',
    openai_max_tokens: 'Field openai_max_tokens',
    openai_max_context: 'Field openai_max_context',
    openai_model: 'Field openai_model',
    stream_response: 'Field stream_response',
    streaming: 'Field streaming',
    function_calling: 'Field function_calling',
    request_images: 'Field request_images',
    continue_prefill: 'Field continue_prefill',
    continue_postfix: 'Field continue_postfix',
    squash_system_messages: 'Field squash_system_messages',
    wrap_in_quotes: 'Field wrap_in_quotes',
    names_behavior: 'Field names_behavior',
    impersonation_prompt: 'Field impersonation_prompt',
    new_chat_prompt: 'Field new_chat_prompt',
    new_group_chat_prompt: 'Field new_group_chat_prompt',
    new_example_chat_prompt: 'Field new_example_chat_prompt',
    continue_nudge_prompt: 'Field continue_nudge_prompt',
    bias_preset_selected: 'Field bias_preset_selected',
    wi_format: 'Field wi_format',
    scenario_format: 'Field scenario_format',
    personality_format: 'Field personality_format',
    group_nudge_prompt: 'Field group_nudge_prompt',
    seed: 'Field seed',
    n: 'Field n',
    chat_completion_source: 'Field chat_completion_source',
    proxy_password: 'Field proxy_password',
    custom_url: 'Field custom_url',
    custom_model: 'Field custom_model',
    assistant_prefill: 'Field assistant_prefill',
    assistant_impersonation: 'Field assistant_impersonation',
    user_name_prefix: 'Field user_name_prefix',
    char_name_prefix: 'Field char_name_prefix',
    image_inlining: 'Field image_inlining',
    inline_image_quality: 'Field inline_image_quality',
    enable_web_search: 'Field enable_web_search',
    send_if_empty: 'Field send_if_empty',
    show_external_models: 'Field show_external_models',
    use_system_prompt: 'Field use_system_prompt',
    stream_fade_in: 'Field stream_fade_in',
    smooth_streaming: 'Field smooth_streaming',
    streaming_fps: 'Field streaming_fps',
    reasoning_max_additions: 'Field reasoning_max_additions',
    reasoning_auto_parse: 'Field reasoning_auto_parse',
    reasoning_auto_expand: 'Field reasoning_auto_expand',
    reasoning_show_hidden: 'Field reasoning_show_hidden',
    reasoning_add_to_prompts: 'Field reasoning_add_to_prompts',
    bypass_status_check: 'Field bypass_status_check',
});

/**
 * 提示词字段名词典（diff 内部用）
 */
export const PROMPT_FIELD_LABEL_KEYS = Object.freeze({
    name: 'Prompt Field name',
    content: 'Prompt Field content',
    role: 'Prompt Field role',
    system_prompt: 'Prompt Field system_prompt',
    marker: 'Prompt Field marker',
    injection_position: 'Prompt Field injection_position',
    injection_depth: 'Prompt Field injection_depth',
    forbid_overrides: 'Prompt Field forbid_overrides',
});

/**
 * 字段标签翻译缓存（模块级，跨多次 renderSummary 复用）
 * 渲染 100 张卡片时可减少 500+ 次 t() 调用
 */
const _fieldLabelCache = new Map();
const _promptFieldLabelCache = new Map();

/**
 * 把字段 key 翻成显示名（i18n 优先，回落到原 key）
 */
export function fieldLabel(key) {
    if (_fieldLabelCache.has(key)) return _fieldLabelCache.get(key);
    const i18nKey = FIELD_LABEL_KEYS[key];
    let label = key;
    if (i18nKey) {
        const tr = t(i18nKey);
        if (tr && tr !== i18nKey) label = tr;
    }
    _fieldLabelCache.set(key, label);
    return label;
}

export function promptFieldLabel(key) {
    if (_promptFieldLabelCache.has(key)) return _promptFieldLabelCache.get(key);
    const i18nKey = PROMPT_FIELD_LABEL_KEYS[key];
    let label = key;
    if (i18nKey) {
        const tr = t(i18nKey);
        if (tr && tr !== i18nKey) label = tr;
    }
    _promptFieldLabelCache.set(key, label);
    return label;
}

// =====================================================
// Summary renderers
// =====================================================

/**
 * 渲染修改摘要——按"每条改动一行"的方式展开
 *
 * compact: 卡片紧凑模式（限制行数 + 折叠）
 * 完整模式（false）用在查看 JSON 弹窗里。
 */
export function renderSummary(summary, opts = {}) {
    const compact = opts.compact !== false; // 默认紧凑
    if (!summary || typeof summary !== 'object') {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-info"></i>
            <span>${escapeHtml(t('Summary Unknown'))}</span>
        </div>`;
    }
    if (summary.isFirst) {
        return `<div class="pas-card-summary pas-summary-first">
            <i class="fa-solid fa-flag"></i>
            <span>${escapeHtml(t('Summary Initial'))}</span>
        </div>`;
    }

    // 旧格式（带 tags 的）兼容性处理
    if (Array.isArray(summary.tags) && !Array.isArray(summary.sections)) {
        return renderLegacySummary(summary);
    }

    const sections = Array.isArray(summary.sections) ? summary.sections : [];
    if (sections.length === 0) {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-dot"></i>
            <span>${escapeHtml(t('Summary Minor'))}</span>
        </div>`;
    }

    // 把所有 sections 拍平成"行"
    const lines = [];
    for (const sec of sections) {
        const segs = renderSection(sec);
        for (const s of segs) lines.push(s);
    }

    if (lines.length === 0) {
        return `<div class="pas-card-summary pas-summary-empty">
            <i class="fa-solid fa-circle-dot"></i>
            <span>${escapeHtml(t('Summary Minor'))}</span>
        </div>`;
    }

    // 紧凑模式：默认显示前 4 行 + "more"
    const COMPACT_LIMIT = 4;
    const visible = compact ? lines.slice(0, COMPACT_LIMIT) : lines;
    const hidden = compact ? lines.length - visible.length : 0;

    const linesHtml = visible.map(l => `<div class="pas-summary-line pas-summary-line-${escapeAttr(l.cls)}">
        <i class="fa-solid ${escapeAttr(l.icon)} pas-summary-line-icon"></i>
        <span class="pas-summary-line-text">${l.html}</span>
    </div>`).join('');

    const moreHtml = hidden > 0
        ? `<div class="pas-summary-more-line">${escapeHtml(t('Summary More', { count: hidden }))}</div>`
        : '';

    return `<div class="pas-card-summary">${linesHtml}${moreHtml}</div>`;
}

/**
 * 把一个 section 渲染成一组行
 * 每行 = { cls, icon, html }
 */
export function renderSection(sec) {
    const out = [];
    if (!sec || !sec.kind) return out;

    switch (sec.kind) {
        case 'prompt-add': {
            // 单条："新增『XXX』"；多条聚合："新增 N 个条目（XXX, YYY...）"
            for (const item of sec.items) {
                out.push({
                    cls: 'add',
                    icon: 'fa-circle-plus',
                    html: t('Summary Line PromptAdd', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-del': {
            for (const item of sec.items) {
                out.push({
                    cls: 'del',
                    icon: 'fa-circle-minus',
                    html: t('Summary Line PromptDel', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-edit': {
            for (const item of sec.items) {
                const fieldsDesc = describePromptFieldDiffs(item.fields || []);
                out.push({
                    cls: 'edit',
                    icon: 'fa-pen-to-square',
                    html: t('Summary Line PromptEdit', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                        fields: fieldsDesc,
                    }),
                });
            }
            break;
        }
        case 'prompt-toggle-on': {
            for (const item of sec.items) {
                out.push({
                    cls: 'toggle-on',
                    icon: 'fa-toggle-on',
                    html: t('Summary Line PromptOn', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-toggle-off': {
            for (const item of sec.items) {
                out.push({
                    cls: 'toggle-off',
                    icon: 'fa-toggle-off',
                    html: t('Summary Line PromptOff', {
                        name: `<b>${escapeHtml(item.name || t('Unnamed Prompt'))}</b>`,
                    }),
                });
            }
            break;
        }
        case 'prompt-reorder': {
            const cnt = sec.items?.[0]?.count || 0;
            out.push({
                cls: 'reorder',
                icon: 'fa-arrows-up-down',
                html: t('Summary Line Reorder', { count: cnt }),
            });
            break;
        }
        case 'field': {
            for (const item of sec.items) {
                out.push({
                    cls: 'field',
                    icon: 'fa-sliders',
                    html: describeFieldChange(item),
                });
            }
            break;
        }
    }
    return out;
}

/**
 * 把 prompt 内部 fields diff 转成短句
 * 例：name: 旧 → 新 / content: 1024→1100 字符 / role: user→system
 */
export function describePromptFieldDiffs(fields) {
    if (!fields || fields.length === 0) return '';
    const parts = fields.slice(0, 3).map(f => {
        const label = promptFieldLabel(f.key);
        if (f.isContent) {
            return t('Prompt Field Content Change', {
                label,
                from: f.fromLen,
                to: f.toLen,
            });
        }
        return `<span class="pas-summary-fkey">${escapeHtml(label)}</span>: <code>${escapeHtml(formatSummaryValue(f.from))}</code> → <code>${escapeHtml(formatSummaryValue(f.to))}</code>`;
    });
    if (fields.length > 3) {
        parts.push(`<span class="pas-summary-fmore">+${fields.length - 3}</span>`);
    }
    return parts.join('<span class="pas-summary-sep">,</span> ');
}

/**
 * 描述一个标量字段变更
 * - scalar: 字段名: 旧 → 新
 * - array-length: 字段名: 长度 N → M
 * - object: 字段名: (对象更新)
 */
export function describeFieldChange(item) {
    const label = fieldLabel(item.key);
    if (item.kind === 'array-length') {
        return t('Summary Line ArrayLen', {
            label: `<span class="pas-summary-fkey">${escapeHtml(label)}</span>`,
            from: item.from,
            to: item.to,
        });
    }
    if (item.kind === 'object') {
        return t('Summary Line ObjectChange', {
            label: `<span class="pas-summary-fkey">${escapeHtml(label)}</span>`,
        });
    }
    // scalar
    const fromStr = formatSummaryValue(item.from);
    const toStr = formatSummaryValue(item.to);
    return `<span class="pas-summary-fkey">${escapeHtml(label)}</span>: <code class="pas-summary-from">${escapeHtml(fromStr)}</code> <span class="pas-summary-arrow">→</span> <code class="pas-summary-to">${escapeHtml(toStr)}</code>`;
}

/**
 * 旧格式（带 tags / details）的兼容渲染——保留向下兼容，避免历史快照打不开
 */
export function renderLegacySummary(summary) {
    const tagHtml = (summary.tags || []).map(tag => {
        const labelKey = `Summary Tag ${tag.label}`;
        const text = t(labelKey, { count: tag.count ?? '' });
        return `<span class="pas-summary-tag pas-summary-tag-${escapeAttr(tag.type)}" title="${escapeAttr(text)}">${escapeHtml(text)}${tag.count != null && tag.count > 0 ? ` <b>${tag.count}</b>` : ''}</span>`;
    }).join('');

    let detailsHtml = '';
    if (summary.details && summary.details.length > 0) {
        const items = summary.details.slice(0, 4).map(d => {
            const fromStr = formatSummaryValue(d.from);
            const toStr = formatSummaryValue(d.to);
            return `<span class="pas-summary-detail"><span class="pas-summary-key">${escapeHtml(d.key)}</span> <span class="pas-summary-arrow">${escapeHtml(fromStr)} → ${escapeHtml(toStr)}</span></span>`;
        }).join('');
        const more = summary.details.length > 4
            ? `<span class="pas-summary-more">+${summary.details.length - 4}</span>`
            : '';
        detailsHtml = `<div class="pas-summary-details">${items}${more}</div>`;
    }

    if (!tagHtml && !detailsHtml) {
        return `<div class="pas-card-summary pas-summary-empty">${escapeHtml(t('Summary Minor'))}</div>`;
    }
    return `<div class="pas-card-summary">
        ${tagHtml ? `<div class="pas-summary-tags">${tagHtml}</div>` : ''}
        ${detailsHtml}
    </div>`;
}

export function formatSummaryValue(v) {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '∞';
        return Number.isInteger(v) ? String(v) : v.toFixed(2);
    }
    if (typeof v === 'string') {
        if (v === '') return '∅';
        return v.length > 24 ? v.slice(0, 22) + '…' : v;
    }
    return String(v);
}
