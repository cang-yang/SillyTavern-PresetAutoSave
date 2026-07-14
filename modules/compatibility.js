/**
 * SillyTavern Preset Auto Save - Compatibility Layer
 * 兼容性探测与安全调用层
 *
 * 职责:
 *   1. 探测当前 SillyTavern 提供的 API
 *   2. 提供所有外部调用的安全包装
 *   3. 在 API 缺失时提供降级方案
 *   4. 隔离上层模块对 ST 内部的直接依赖
 */

import { logger } from './logger.js';
import { StorageReadError } from './core/storage-integrity.js';
import { describePresetLookup } from './core/preset-lookup-diagnostics.js';
import {
    canonicalizePreset,
    CONNECTION_FIELDS,
    OPENAI_PRESET_FIELDS,
} from './core/preset-schema.js';
export { escapeHtml, escapeAttr, escapeTranslationHtml } from './key-utils.js';
export { formatTime } from './time-utils.js';
export { StorageReadError } from './core/storage-integrity.js';

// =====================================================
// 环境能力标识
// =====================================================
export const ENV = {
    // 核心 API
    hasContext: false,
    hasGetPresetManager: false,
    hasEventSource: false,
    hasEventTypes: false,
    hasSaveSettings: false,

    // 工具 API
    hasPopup: false,
    hasRenderTemplate: false,
    hasToastr: false,
    hasLocalforage: false,
    hasTranslate: false,        // ctx.translate / ctx.t

    // 关键事件类型
    hasOaiPresetChangedBefore: false,
    hasPresetChanged: false,
    hasSettingsUpdated: false,
    hasAppReady: false,
    hasAppInitialized: false,

    // PresetManager 方法
    hasSavePreset: false,
    hasGetPresetSettings: false,
    hasSelectPreset: false,
    hasFindPreset: false,
    hasGetSelectedPresetName: false,

    // 版本与时间
    stVersion: 'unknown',
    probedAt: null,
};

// =====================================================
// 内部状态
// =====================================================
const _registeredListeners = []; // { eventName, handler } - 便于卸载
let _lastSnapshotPath = null;    // 上一次 getPresetSnapshot 走的路径，用于日志降噪

// =====================================================
// 初始化探测
// =====================================================
/**
 * 探测当前环境能力
 * @returns {boolean} 是否满足最低运行要求
 */
export function initCompatibility() {
    logger.group('Environment probe');

    try {
        // 1. 核心: SillyTavern 全局
        ENV.hasContext = typeof window.SillyTavern?.getContext === 'function';
        if (!ENV.hasContext) {
            logger.error('SillyTavern.getContext not available!');
            return false;
        }

        const ctx = SillyTavern.getContext();

        // 2. 核心 API
        ENV.hasGetPresetManager = typeof ctx.getPresetManager === 'function';
        ENV.hasEventSource = !!ctx.eventSource && typeof ctx.eventSource.on === 'function';
        ENV.hasEventTypes = !!ctx.event_types;
        ENV.hasSaveSettings = typeof ctx.saveSettingsDebounced === 'function';

        // 3. 工具 API
        ENV.hasPopup = !!ctx.Popup && !!ctx.Popup.show;
        ENV.hasRenderTemplate = typeof ctx.renderExtensionTemplateAsync === 'function';
        ENV.hasToastr = typeof window.toastr !== 'undefined';
        ENV.hasLocalforage = !!window.SillyTavern?.libs?.localforage;
        ENV.hasTranslate = typeof ctx.translate === 'function' || typeof ctx.t === 'function';

        // 4. 事件类型存在性探测
        if (ENV.hasEventTypes) {
            const et = ctx.event_types;
            ENV.hasOaiPresetChangedBefore = !!et.OAI_PRESET_CHANGED_BEFORE;
            ENV.hasPresetChanged = !!et.PRESET_CHANGED;
            ENV.hasSettingsUpdated = !!et.SETTINGS_UPDATED;
            ENV.hasAppReady = !!et.APP_READY;
            ENV.hasAppInitialized = !!et.APP_INITIALIZED;
        }

        // 5. PresetManager 方法探测
        if (ENV.hasGetPresetManager) {
            try {
                const pm = ctx.getPresetManager('openai');
                if (pm) {
                    ENV.hasSavePreset = typeof pm.savePreset === 'function';
                    ENV.hasGetPresetSettings = typeof pm.getPresetSettings === 'function';
                    ENV.hasSelectPreset = typeof pm.selectPreset === 'function';
                    ENV.hasFindPreset = typeof pm.findPreset === 'function';
                    ENV.hasGetSelectedPresetName = typeof pm.getSelectedPresetName === 'function';
                }
            } catch (_) {
                // ignore
            }
        }

        // 6. 版本探测
        ENV.stVersion = detectVersion();
        ENV.probedAt = Date.now();

        // 输出探测结果
        logger.info('SillyTavern version:', ENV.stVersion);
        logger.debug('Environment:', { ...ENV });

        // 关键能力检查
        const required = [
            ['Context API',         ENV.hasContext],
            ['EventSource',         ENV.hasEventSource],
            ['Preset Manager API',  ENV.hasGetPresetManager],
            ['Save Preset method',  ENV.hasSavePreset],
        ];

        const optional = [
            ['Popup API',           ENV.hasPopup],
            ['Template Render',     ENV.hasRenderTemplate],
            ['Toastr',              ENV.hasToastr],
            ['LocalForage',         ENV.hasLocalforage],
            ['OAI_PRESET_CHANGED_BEFORE', ENV.hasOaiPresetChangedBefore],
        ];

        let criticalMissing = false;
        for (const [name, ok] of required) {
            if (ok) logger.success(`Required: ${name}`);
            else { logger.error(`Required MISSING: ${name}`); criticalMissing = true; }
        }
        for (const [name, ok] of optional) {
            if (ok) logger.debug(`Optional: ${name} ✓`);
            else logger.warn(`Optional missing: ${name} (will use fallback)`);
        }

        if (criticalMissing) {
            logger.error('Critical APIs missing, extension may not work properly');
            return false;
        }

        return true;
    } catch (e) {
        logger.error('Compat probe failed:', e);
        return false;
    } finally {
        logger.groupEnd();
    }
}

// =====================================================
// 版本探测（多种方式）
// =====================================================
function detectVersion() {
    // 方式 1: window 全局
    if (window.SillyTavern?.version) return String(window.SillyTavern.version);

    // 方式 2: meta 标签
    const meta = document.querySelector('meta[name="version"]');
    if (meta?.content) return meta.content;

    // 方式 3: #version 元素
    const versionEl = document.getElementById('version');
    if (versionEl?.textContent) return versionEl.textContent.trim();

    return 'unknown';
}

// =====================================================
// 通用安全调用
// =====================================================
/**
 * 安全同步调用
 */
export function safeCall(fn, fallback = null, label = 'call') {
    try {
        return fn();
    } catch (e) {
        logger.warn(`safeCall(${label}) failed:`, e);
        return fallback;
    }
}

/**
 * Return the active SillyTavern context without exposing global lookup or
 * host exceptions to callers. Missing and temporarily unavailable hosts both
 * fail closed with `null`.
 */
export function getContextSafe() {
    return safeCall(() => {
        const host = globalThis.SillyTavern || globalThis.window?.SillyTavern;
        if (typeof host?.getContext !== 'function') return null;
        return host.getContext();
    }, null, 'getContext');
}

/**
 * 安全异步调用
 */
export async function safeCallAsync(fn, fallback = null, label = 'call') {
    try {
        return await fn();
    } catch (e) {
        logger.warn(`safeCallAsync(${label}) failed:`, e);
        return fallback;
    }
}

// =====================================================
// PresetManager 相关
// =====================================================

/**
 * 获取 PresetManager 实例（带降级）
 * @param {string} [apiId] 不指定则使用当前API
 */
export function getPresetManager(apiId) {
    const id = apiId || getCurrentApiId();

    // 优先级 1: 官方 API
    if (ENV.hasGetPresetManager) {
        const pm = safeCall(
            () => SillyTavern.getContext().getPresetManager(id),
            null,
            'getPresetManager-official'
        );
        if (pm) return pm;
    }

    // 优先级 2: 全局变量降级
    if (window.presetManagers && window.presetManagers[id]) {
        return window.presetManagers[id];
    }

    return null;
}

/**
 * 获取当前主API ID
 */
export function getCurrentApiId() {
    return safeCall(() => {
        const ctx = SillyTavern.getContext();
        return ctx.mainApi || window.main_api || 'openai';
    }, 'openai', 'getCurrentApiId');
}

/**
 * 获取当前选中的预设名
 *
 * Custom Dropdown Overlay 架构下，option.textContent 始终是真实预设名，
 * 不再需要 data-pas-orig-text 修正。
 *
 * ⚠️ 防御要点：
 *   某些 ST 版本下 PresetManager.select 可能是非 HTMLSelectElement 对象
 *   （如 sysprompt / reasoning / instruct 这些"非 chat completion" API），
 *   它没有 .options 属性。直接 select.options[select.selectedIndex] 会触发
 *   `undefined[undefined]` → TypeError: Cannot read properties of undefined (reading 'undefined')
 *   这个错误会把面板初始化、auto-save 初始化、面板首次渲染全部打挂。
 */
export function getSelectedPresetName() {
    try {
        const apiId = getCurrentApiId();
        if (!apiId) return null;
        const pm = getPresetManager(apiId);
        if (!pm) return null;

        // pm.select 是 jQuery 对象，需要 [0] 取原生 HTMLSelectElement
        const select = pm.select?.[0];

        // 路径 1：从 select.options[selectedIndex] 获取
        if (select?.options && select.selectedIndex >= 0) {
            const opt = select.options[select.selectedIndex];
            if (opt && typeof opt.textContent === 'string') {
                const name = opt.textContent.trim();
                if (name) return name;
            }
        }

        // 路径 2：从 jQuery .val() + 遍历 option 获取
        //   preset-takeover 隐藏 select 后 selectedIndex 可能为 -1，
        //   但 jQuery .val() 仍能拿到内部记录的值
        if (pm.select) {
            const val = pm.select.val();
            if (val != null && val !== '') {
                // val 是 option.value（通常是数字索引字符串）
                if (select?.options) {
                    for (const opt of select.options) {
                        if (opt.value === String(val)) {
                            const name = opt.textContent?.trim();
                            if (name) return name;
                        }
                    }
                }
            }
        }

        // 路径 3：从 getPresetList().preset_names 获取
        //   适用于 select 完全不可用的场景
        if (typeof pm.getPresetList === 'function') {
            const list = safeCall(() => pm.getPresetList(apiId), null, 'getPresetList-name');
            if (list?.preset_names && list?.settings?.preset != null) {
                const name = list.preset_names[list.settings.preset];
                if (name && typeof name === 'string') return name;
            }
        }

        return null;
    } catch (e) {
        logger.warn('[getSelectedPresetName] fallback failed:', e?.message);
        return null;
    }
}

// =====================================================
// S-1: 预设字段过滤（从 history-store.js 迁移至此，避免循环依赖）
// =====================================================

/**
 * OpenAI 特有字段 → 规范字段名的同义映射。
 * ST 的 oai_settings 中同时存在两套字段名（如 `top_p` 和 `top_p_openai`），
 * 但磁盘 presets[] 数据可能只包含其中一套。
 * 对比前先将 alt 名统一到 canonical 名，避免"从有值变空 / 从空变有值"的误导。
 *
 * 基于 ST openai.js settingsToUpdate 中的映射关系。
 */
export const FIELD_SYNONYMS = new Map([
    ['temp_openai',                  'temperature'],
    ['freq_pen_openai',              'frequency_penalty'],
    ['pres_pen_openai',              'presence_penalty'],
    ['top_p_openai',                 'top_p'],
    ['top_k_openai',                 'top_k'],
    ['top_a_openai',                 'top_a'],
    ['min_p_openai',                 'min_p'],
    ['repetition_penalty_openai',    'repetition_penalty'],
    // 阶段7: 流式开关字段名对齐 —— ST 实际字段名是 stream_openai，
    // 旧快照可能存为 streaming，统一到规范名称
    ['streaming',                    'stream_openai'],
]);

/**
 * 规范化预设字段名：将 OpenAI 特有变体合并到规范名称。
 * 确保来自不同数据源（presets[] 磁盘数据 vs oai_settings 内存数据）的快照可正确比较。
 *
 * 规则：
 *   - alt 字段存在但 canonical 不存在 → 将 alt 值赋给 canonical，删除 alt
 *   - alt 和 canonical 都存在 → 保留 canonical，删除 alt（canonical 是通用显示名）
 *   - 只有 canonical 存在 → 不变
 */
export function normalizePresetFields(preset) {
    if (!preset || typeof preset !== 'object') return preset || {};
    const result = { ...preset };
    for (const [alt, canonical] of FIELD_SYNONYMS) {
        if (alt in result) {
            if (!(canonical in result)) {
                result[canonical] = result[alt];
            }
            delete result[alt];
        }
    }
    return result;
}

// =====================================================
// Canonical 预设字段契约（采集、哈希、存储与 diff 共用）
//
// 基于 ST openai.js settingsToUpdate 的白名单设计：
//   旧方案用黑名单（EXPORT_EXCLUDED_FIELDS）过滤，任何不在黑名单的字段
//   （扩展注入、ST 新字段、字段名拼写差异等）都会被捕获，导致修改 1 个参数
//   却显示 10 个字段变化。
//
//   核心契约定义在 core/preset-schema.js。OpenAI 采用默认拒绝策略：
//   只有 ST 原生 settingsToUpdate 中 isConnection=false 的字段可进入历史；
//   其他 API 暂无统一契约，维持兼容性的默认保留策略。
//
// 来源：ST openai.js settingsToUpdate（约第288-387行）
// 维护：若 ST 新增预设字段，需同步更新此列表
// =====================================================
export const CANONICAL_PRESET_FIELDS = OPENAI_PRESET_FIELDS;

/**
 * 从预设对象中提取 canonical 字段（仅用于 diff 比较阶段）。
 *
 * 基于 ST openai.js settingsToUpdate 的白名单设计：
 *   - 只保留 ST 预设定义中 isConnection=false 的标量字段
 *   - prompts / prompt_order / extensions 由专门 diff 处理，不在此提取
 *
 * 这样任何不在 ST 预设定义中的字段（扩展注入、ST 新字段、字段名拼写差异等）
 * 都不会参与比较，从根本上根治"修改1个参数却显示10个字段变化"的问题。
 *
 * 快照采集阶段也使用相同核心契约；这里仅提取标量字段，结构化的
 * prompts / prompt_order / extensions 仍由专用摘要逻辑处理。
 *
 * @param {object} preset - 规范化后的预设对象
 * @returns {object} 只包含 canonical 字段的新对象
 */
export function extractCanonicalForDiff(preset) {
    if (!preset || typeof preset !== 'object') return {};
    const result = {};
    for (const key of CANONICAL_PRESET_FIELDS) {
        if (key === 'prompts' || key === 'prompt_order' || key === 'extensions' || key === 'bias_preset_selected') {
            continue;
        }
        if (key in preset) {
            result[key] = preset[key];
        }
    }
    return result;
}

// =====================================================
// =====================================================
// ST 内置系统 prompt 标识符（不在 prompt_order 中但属于预设数据）
// 参考 ST 源码 openai.js 中的 OPENAI_PROMPT_IDS / oai_settings.prompts 初始化
// =====================================================
const ST_SYSTEM_PROMPT_IDS = new Set([
    'main',                 // Main Prompt (系统主提示)
    'nsfw',                 // Auxiliary Prompt (NSFW 辅助提示)
    'jailbreak',            // Post-History Instructions (越狱/后置指令)
    'enhanceDefinitions',   // Enhance Definitions (增强定义)
]);

// UUID v4 格式正则（匹配用户自定义 prompt 的 identifier）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// R-1 / S-1: 导出预设时排除的敏感/环境配置字段（黑名单）
// 基于 ST openai.js getChatCompletionPreset() 中不包含的字段。
// 比 HASH_EXCLUDED_FIELDS 更全面，覆盖所有 provider-specific 配置。
// =====================================================
export const EXPORT_EXCLUDED_FIELDS = new Set([
    ...CONNECTION_FIELDS,
    // ---- 安全：绝对不能导出 ----
    'api_key_openai', 'proxy_password',

    // ---- 环境/连接配置 ----
    'reverse_proxy', 'chat_completion_source',
    'api_url_scale', 'custom_url',
    'custom_api_format', 'custom_include_body', 'custom_exclude_body',
    'custom_include_headers', 'custom_claude_prompt_caching',
    'custom_prompt_post_processing',

    // ---- 模型选择（所有 provider） ----
    'openai_model', 'openrouter_model', 'claude_model', 'google_model',
    'ai21_model', 'mistralai_model', 'cohere_model', 'perplexity_model',
    'groq_model', 'zerooneai_model', 'blockentropy_model', 'custom_model',
    'vertexai_model', 'deepseek_model', 'aimlapi_model', 'xai_model',
    'pollinations_model', 'cometapi_model', 'moonshot_model', 'fireworks_model',
    'zai_model', 'azure_openai_model',
    'chutes_model', 'siliconflow_model', 'electronhub_model', 'nanogpt_model',

    // ---- 模型列表（大数组，可能含用户配额信息） ----
    'model_list', 'openrouter_model_list',

    // ---- Azure 配置 ----
    'azure_base_url', 'azure_deployment_name', 'azure_api_version',

    // ---- VertexAI 配置 ----
    'vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id',

    // ---- OpenRouter 配置 ----
    'openrouter_use_fallback', 'openrouter_group_models', 'openrouter_sort_models',
    'openrouter_providers', 'openrouter_quantizations',
    'openrouter_allow_fallbacks', 'openrouter_middleout',

    // ---- 其他 provider 配置 ----
    'chutes_sort_models', 'chutes_group_models',
    'electronhub_sort_models', 'electronhub_group_models',
    'zai_endpoint', 'siliconflow_endpoint',

    // ---- 内部/UI 状态 ----
    'show_external_models', 'bypass_status_check',
    'bind_preset_to_connection',
    'preset_settings_openai',
    // Logit-bias presets are managed by ST as a separate global preset library.
    // They are deliberately omitted from /api/presets/save and must not make a
    // native manual save look like it deleted an object from the active preset.
    'bias_presets', 'bias_preset_selected',
]);

// =====================================================
// 显示/对比时统一忽略的字段集合
// 是 EXPORT_EXCLUDED_FIELDS 的超集，额外包含仅用于"显示过滤"的字段
// （如 prompts / prompt_order 由专门的 diff 区段处理，不在标量对比中出现）
// =====================================================
export const DISPLAY_IGNORED_FIELDS = new Set([
    ...EXPORT_EXCLUDED_FIELDS,

    // ---- 由 diff / summary 专门处理，不作为标量字段对比 ----
    'prompts', 'prompt_order', 'extensions',

    // ---- 显示为标题/标签，不参与字段级对比 ----
    'name',

    // ---- 内部/噪音字段 ----
    'bias_presets', 'bias_preset_selected',
    // 注意：names_behavior 已移除——它是"角色行为"栏中的用户可见设置，
    // 修改后应在变更摘要中正常显示。之前被误列为噪音字段导致用户
    // 调整角色名前缀设置后摘要显示"细微改动"而非具体变更。
]);

/**
 * R-1 / S-1: 清理预设数据——过滤掉敏感信息和环境配置字段。
 *
 * 处理流程：
 *   1. 浅拷贝预设对象
 *   2. 通过 normalizePresetFields() 将同义字段名统一为规范名称
 *   3. 删除 EXPORT_EXCLUDED_FIELDS 中的所有字段
 *
 * 导出结果与 ST 原生 getChatCompletionPreset() 保存的格式一致，
 * 只包含预设参数（采样参数、prompts、prompt_order、extensions 等）。
 *
 * @param {object} preset - 原始预设对象（oai_settings 快照）
 * @param {{apiId?: string}} [options] 当前预设 API 类型
 * @returns {object} 清理后的安全预设对象
 */
export function sanitizePresetForExport(preset, { apiId = 'openai' } = {}) {
    if (!preset || typeof preset !== 'object') return {};
    // 1. 规范化字段名（temp_openai → temperature 等）
    const cleaned = normalizePresetFields(preset);
    // 2. 删除所有敏感/环境字段
    for (const field of EXPORT_EXCLUDED_FIELDS) {
        delete cleaned[field];
    }
    // 3. 过滤 prompts 数组中被扩展动态注入的非用户 prompt
    if (Array.isArray(cleaned.prompts)) {
        cleaned.prompts = filterExtensionPrompts(cleaned.prompts, cleaned.prompt_order);
    }
    // 所有哈希、摘要与保存路径必须共享同一份 canonical 数据。
    // canonicalizePreset 只对已知数值/布尔控件做字段感知的类型规范化；
    // Prompt、extensions 和文本框内容保持原类型，避免篡改用户文本。
    return canonicalizePreset(cleaned, { apiId }).canonical;
}

/**
 * 过滤 prompts 数组中被扩展动态注入的非用户 prompt。
 *
 * ST 运行时 oai_settings.prompts 中可能包含其他扩展（如 SPreset 等）
 * 注入的条目，它们的 content 通常包含 HTML/前端代码，不是用户编写的 prompt。
 *
 * 过滤策略：保留以下任一条件成立的 prompt entry：
 *   a) 在 prompt_order 中被引用（用户管理的 prompt）
 *   b) 是 ST 已知的系统 prompt（main/nsfw/jailbreak/enhanceDefinitions）
 *   c) identifier 是 UUID 格式（用户创建的自定义 prompt）
 *
 * 此函数同时用于 sanitizePresetForExport（新快照过滤）和
 * computeChangeSummary（旧快照对比前过滤），确保新旧快照使用相同标准。
 *
 * @param {Array} prompts - prompt 数组
 * @param {Array} [promptOrder] - prompt_order 数组（可选）
 * @returns {Array} 过滤后的 prompts 数组
 */
export function filterExtensionPrompts(prompts, promptOrder) {
    if (!Array.isArray(prompts)) return prompts;

    const orderIds = new Set();
    if (Array.isArray(promptOrder)) {
        for (const group of promptOrder) {
            if (group?.order && Array.isArray(group.order)) {
                for (const entry of group.order) {
                    if (entry?.identifier) orderIds.add(entry.identifier);
                }
            }
        }
    }

    return prompts.filter(p => {
        if (!p || !p.identifier) return false;
        // a) 在 prompt_order 中
        if (orderIds.has(p.identifier)) return true;
        // b) ST 已知系统 prompt
        if (ST_SYSTEM_PROMPT_IDS.has(p.identifier)) return true;
        // c) UUID 格式（用户自定义 prompt）
        if (UUID_RE.test(p.identifier)) return true;
        return false;
    });
}

/**
 * 安全获取预设设置（不含被过滤字段的"干净"数据）
 *
 * ⚠️ 重要：ST 内部 PresetManager.getPresetSettings() 在 apiId='openai' 时
 * **永远返回空对象 `{}`**（switch 语句没有 'openai' case，走 default）。
 * 这会导致我们获取到的 hash 永远是空对象的 hash，自动保存彻底失效！
 *
 * 因此本函数对 openai 走特殊路径：从 pm.getPresetList('openai').settings
 * 拿到完整的 oai_settings（实时对象，包含 prompts、prompt_order、所有用户设置）。
 *
 * @param {string} [presetName] 不指定则用当前
 * @returns {object|null} 完整的预设设置对象（深拷贝），或 null
 */
export function getPresetSettingsSafe(presetName) {
    return getPresetSnapshot(presetName);
}

/**
 * 获取当前生效的预设快照（深拷贝，避免引用变更影响哈希）
 *
 * ⚠️ 核心修复（M-1）：
 *   旧实现优先从 presets[idx]（磁盘数据）读取，导致 hash 永远不变、自动保存失效。
 *   ST 数据流：
 *     - oai_settings = 内存实时设置，用户拖滑块后立即更新
 *     - presets[] = openai_settings 数组，仅在用户点 Save 后才同步
 *     - pm.getPresetList(apiId).settings === oai_settings（内存引用）
 *     - pm.getPresetSettings(name) 对 openai 返回 {} （switch 无 'openai' case）
 *
 *   正确做法：优先从 pm.getPresetList(apiId).settings 取内存实时数据。
 *
 * @param {string} [presetName] 预设名（可选）
 * @returns {object|null}
 */
export function getPresetSnapshot(presetName, options = {}) {
    const explicitApiId = typeof options === 'string' ? options : options?.apiId;
    const apiId = explicitApiId || getCurrentApiId();
    const pm = getPresetManager(apiId);
    if (!pm) {
        logger.warn('[getPresetSnapshot] no preset manager');
        return null;
    }

    const name = presetName || getSelectedPresetName();
    if (!name) {
        logger.warn('[getPresetSnapshot] no preset name');
        return null;
    }

    const isUsable = (obj) => obj && typeof obj === 'object' && Object.keys(obj).length > 0;
    const currentName = getSelectedPresetName();
    const currentApiId = getCurrentApiId();
    const isCurrentPreset = (name === currentName && apiId === currentApiId);

    // ===== 路径 1（核心，M-1 修复）：从 getPresetList().settings 获取内存实时数据 =====
    // pm.getPresetList(apiId).settings 就是 oai_settings / textgen_settings 的引用，
    // 用户修改滑块后这个对象会被 ST 原生代码立即更新。
    // 对"当前生效的预设"来说，这是唯一可靠的数据源。
    if (isCurrentPreset && typeof pm.getPresetList === 'function') {
        const list = safeCall(() => pm.getPresetList(apiId), null, 'getPresetList-settings');
        const live = list?.settings;
        if (isUsable(live)) {
            if (_lastSnapshotPath !== `live:${apiId}`) {
                logger.debug(`[getPresetSnapshot] using getPresetList(${apiId}).settings (live memory data)`);
                _lastSnapshotPath = `live:${apiId}`;
            }
            return sanitizePresetForExport(cloneDeepSafe(live), { apiId });
        }
    }

    // ===== 路径 2（后备）：getContext().chatCompletionSettings =====
    // 也是 oai_settings 的引用，在某些 ST 版本中可用
    if (isCurrentPreset) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx?.chatCompletionSettings && isUsable(ctx.chatCompletionSettings)) {
                if (_lastSnapshotPath !== 'ctx-ccs') {
                    logger.debug('[getPresetSnapshot] using ctx.chatCompletionSettings (fallback)');
                    _lastSnapshotPath = 'ctx-ccs';
                }
                return sanitizePresetForExport(cloneDeepSafe(ctx.chatCompletionSettings), { apiId });
            }
        } catch (_) { /* ignore */ }
    }

    // ===== 路径 3（后备）：window.oai_settings =====
    // 仅当 openai API 且查询当前预设时可用
    if (isCurrentPreset && apiId === 'openai') {
        try {
            const oai = window.oai_settings;
            if (isUsable(oai)) {
                if (_lastSnapshotPath !== 'oai-global') {
                    logger.debug('[getPresetSnapshot] using window.oai_settings (fallback)');
                    _lastSnapshotPath = 'oai-global';
                }
                return sanitizePresetForExport(cloneDeepSafe(oai), { apiId });
            }
        } catch (_) { /* ignore */ }
    }

    // ===== 路径 4（非当前预设）：从 presets[] 数组读磁盘数据 =====
    // 仅用于读取非当前选中的预设（如历史对比）。
    // 注意：这里读的是 openai_settings 数组中的磁盘副本，不是实时数据。
    if (!isCurrentPreset && typeof pm.getPresetList === 'function') {
        try {
            const list = pm.getPresetList(apiId);
            const { presets, preset_names } = list || {};
            if (presets && preset_names) {
                let presetData = null;

                if (Array.isArray(preset_names)) {
                    const idx = preset_names.indexOf(name);
                    if (idx >= 0 && presets[idx]) {
                        presetData = presets[idx];
                    }
                } else if (typeof preset_names === 'object') {
                    const idx = preset_names[name];
                    if (idx !== undefined && presets[idx]) {
                        presetData = presets[idx];
                    }
                }

                if (isUsable(presetData)) {
                    return sanitizePresetForExport(cloneDeepSafe(presetData), { apiId });
                }
                logger.debug('[getPresetSnapshot] non-current lookup unusable:', describePresetLookup(list, name, currentName));
            }
            if (!presets || !preset_names) {
                logger.debug('[getPresetSnapshot] non-current lookup missing list parts:', describePresetLookup(list, name, currentName));
            }
        } catch (e) {
            logger.debug('[getPresetSnapshot] path 4 getPresetList error:', e);
        }
    }

    // ===== 路径 5：pm.getPresetSettings(name) =====
    // 对 openai 返回 {}，但对其他 API（textgenerationwebui 等）可能有效
    if (typeof pm.getPresetSettings === 'function') {
        const raw = safeCall(() => pm.getPresetSettings(name), null, 'getPresetSettings');
        if (isUsable(raw)) {
            return sanitizePresetForExport(cloneDeepSafe(raw), { apiId });
        }
    }

    // 失败：log 详情
    logger.warn(`[getPresetSnapshot] failed: apiId=${apiId} name="${name}" isCurrent=${isCurrentPreset} pm=${!!pm}`);
    return null;
}

/**
 * 深拷贝（优先 structuredClone，失败回退 JSON）
 */
function cloneDeepSafe(obj) {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(obj);
        }
    } catch (_) { /* 不支持时回退 */ }
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch (_) {
        // JSON 序列化失败（BigInt、循环引用等），回退到浅拷贝
        logger.warn('[cloneDeepSafe] JSON fallback failed, using shallow copy');
        if (Array.isArray(obj)) {
            return Array.from(obj);
        }
        if (obj && typeof obj === 'object') {
            return { ...obj };
        }
        return obj; // 原始类型直接返回
    }
}

/**
 * 安全保存预设
 * @param {string} presetName 预设名
 * @param {object} [settings] 不指定则使用当前预设设置
 * @param {object} [options] { skipUpdate, apiId }
 */
/**
 * 安全删除预设
 * @param {string} presetName 要删除的预设名
 * @param {string} [apiId] API 标识（默认当前）
 * @returns {Promise<boolean>} 是否成功
 */
export async function deletePresetSafe(presetName, apiId = null) {
    const pm = apiId ? getPresetManager(apiId) : getPresetManager();
    if (!pm || typeof pm.deletePreset !== 'function') {
        logger.warn('deletePresetSafe: PresetManager.deletePreset unavailable');
        return false;
    }
    try {
        const ok = await pm.deletePreset(presetName);
        return !!ok;
    } catch (e) {
        logger.warn(`deletePresetSafe(${presetName}) failed:`, e);
        return false;
    }
}

export async function savePresetSafe(presetName, settings = null, options = {}) {
    const pm = getPresetManager(options.apiId);
    if (!pm || typeof pm.savePreset !== 'function') {
        throw new Error('PresetManager.savePreset not available');
    }

    await pm.savePreset(presetName, settings, {
        skipUpdate: options.skipUpdate ?? true,
    });
    // SillyTavern's PresetManager.savePreset resolves with undefined on success.
    // A resolved call is the success signal; callers must not coerce its value.
    return true;
}

/**
 * Capture the active API's live settings without consulting the select's new value.
 * This is used during the capture phase of a native preset change: the browser has
 * already selected the next option, while SillyTavern still holds the old preset's
 * unsaved live settings.
 */
export function getLivePresetSnapshot(apiId = null) {
    const id = apiId || getCurrentApiId();
    const pm = getPresetManager(id);
    if (!pm || typeof pm.getPresetList !== 'function') return null;
    const list = safeCall(() => pm.getPresetList(id), null, 'getPresetList-live-capture');
    const live = list?.settings;
    if (!live || typeof live !== 'object' || Object.keys(live).length === 0) return null;
    return sanitizePresetForExport(cloneDeepSafe(live), { apiId: id });
}

/**
 * 将预设数据同步到 ST 内存中的 presets[] 数组（不触发 UI 更新）。
 *
 * 背景：doSave 使用 skipUpdate:true 写磁盘以避免 PromptManager DOM 重建（性能），
 * 但 ST 内存中 presets[] 数组不会被 skipUpdate:true 更新。当用户切换预设时，
 * ST 从 presets[] 加载预设数据，如果 presets[] 还是旧版本就会导致修改丢失。
 *
 * 此函数直接操作内存引用（presets[idx] = newData），没有任何 DOM 操作或事件触发，
 * 开销极低（仅对象赋值），确保切换预设时 ST 加载的是最新保存的版本。
 *
 * @param {string} presetName 预设名
 * @param {object} presetData 要同步的预设数据
 * @param {string} [apiId] API 标识（默认当前）
 * @returns {boolean} 是否成功同步
 */
export function syncPresetToMemory(presetName, presetData, apiId) {
    const id = apiId || getCurrentApiId();
    const pm = getPresetManager(id);
    if (!pm || typeof pm.getPresetList !== 'function') {
        return false;
    }

    try {
        const list = pm.getPresetList(id);
        if (!list || !list.presets || !list.preset_names) return false;

        const { presets, preset_names } = list;
        let idx = -1;

        if (Array.isArray(preset_names)) {
            idx = preset_names.indexOf(presetName);
        } else if (typeof preset_names === 'object') {
            idx = preset_names[presetName];
            if (typeof idx !== 'number') idx = -1;
        }

        if (idx < 0 || !presets[idx]) {
            logger.debug(`[syncPresetToMemory] preset "${presetName}" not found in presets[] (apiId=${id})`);
            return false;
        }

        // 直接替换内存引用：将 presets[idx] 的所有属性更新为新数据
        // 使用 Object.assign 保留 presets[idx] 的引用不变（ST 其他代码可能也持有该引用）
        // 先清除旧属性，再合入新属性
        const target = presets[idx];
        for (const key of Object.keys(target)) {
            delete target[key];
        }
        Object.assign(target, presetData);

        logger.debug(`[syncPresetToMemory] synced "${presetName}" to presets[${idx}] (apiId=${id})`);
        return true;
    } catch (e) {
        logger.debug(`[syncPresetToMemory] failed for "${presetName}":`, e);
        return false;
    }
}

/**
 * 安全选中预设
 *
 * Custom Dropdown Overlay 架构下，所有 option 始终存在于 select 中，
 * findPreset() 一定能找到。不再需要临时 option、detached option 查找等。
 */
export function selectPresetSafe(presetName) {
    const apiId = getCurrentApiId();
    if (!apiId) { logger.warn('[selectPresetSafe] no apiId'); return false; }
    const pm = getPresetManager(apiId);
    if (!pm) { logger.warn('[selectPresetSafe] no PM for', apiId); return false; }

    const value = pm.findPreset(presetName);
    if (value == null) {
        logger.warn('[selectPresetSafe] preset not found:', presetName);
        return false;
    }

    pm.selectPreset(value);
    logger.debug('[selectPresetSafe] switched to', presetName, 'value=', value);
    return true;
}

/**
 * 获取所有预设名（真实预设名，不是数字索引）
 *
 * AK-1 重构：旧实现调用 pm.getAllPresets()，它返回 select.options 的 value 属性，
 * 在 openai API 下 value 是数组索引（"0","1","2",...），不是预设名。
 *
 * 新实现优先从 pm.getPresetList(apiId).preset_names 获取真实预设名数组。
 * 后备路径从 select.options 的 textContent 获取（textContent 是渲染给用户看的文本）。
 *
 * @param {string} [apiId] 指定 API 的 PresetManager；不传 = 当前 mainApi
 * @returns {string[]} 真实预设名数组
 */
export function getAllPresetNames(apiId) {
    const id = apiId || getCurrentApiId();
    const pm = getPresetManager(id);
    if (!pm) {
        logger.debug('[getAllPresetNames] no PM for', id);
        return [];
    }

    // 路径 1（推荐）：从 getPresetList().preset_names 获取
    // preset_names 是 ST 内部维护的真实预设名数组
    if (typeof pm.getPresetList === 'function') {
        const list = safeCall(() => pm.getPresetList(id), null, 'getPresetList-names');
        if (list?.preset_names && Array.isArray(list.preset_names)) {
            const names = list.preset_names.filter(n => n && typeof n === 'string');
            if (names.length > 0) {
                logger.debug(`[getAllPresetNames] via getPresetList(${id}).preset_names: ${names.length} presets`);
                return names;
            }
        }
    }

    // 路径 2（后备）：从 select.options 的 textContent 获取
    // textContent 是 ST 渲染给用户看的预设名，而不是 value（数组索引）
    try {
        const select = pm.select?.[0]; // jQuery → 原生 HTMLSelectElement
        if (select?.options) {
            const names = Array.from(select.options)
                .map(o => o.textContent?.trim())
                .filter(n => n && typeof n === 'string');
            if (names.length > 0) {
                logger.debug(`[getAllPresetNames] via select.textContent: ${names.length} presets`);
                return names;
            }
        }
    } catch (e) {
        logger.debug('[getAllPresetNames] select textContent fallback failed:', e);
    }

    // 路径 3（最终后备）：旧 API getAllPresets()
    // 某些非 openai API 的 PM 可能没有 getPresetList 但有 getAllPresets
    if (typeof pm.getAllPresets === 'function') {
        const result = safeCall(() => pm.getAllPresets(), [], 'getAllPresets-legacy');
        logger.debug(`[getAllPresetNames] via legacy getAllPresets: ${result.length} items`);
        return result;
    }

    logger.warn(`[getAllPresetNames] all paths failed for apiId=${id}`);
    return [];
}

// =====================================================
// 事件相关
// =====================================================

/**
 * 安全订阅事件（自动记录便于卸载）
 * @returns {Function} 取消订阅函数
 */
export function on(eventName, handler) {
    if (!ENV.hasEventSource) {
        logger.warn('EventSource not available, cannot subscribe to:', eventName);
        return () => {};
    }
    if (!eventName || typeof handler !== 'function') {
        return () => {};
    }

    try {
        const { eventSource } = SillyTavern.getContext();
        eventSource.on(eventName, handler);
        _registeredListeners.push({ eventName, handler });
        logger.debug('Event subscribed:', eventName);

        return () => off(eventName, handler);
    } catch (e) {
        logger.error('Failed to subscribe event:', eventName, e);
        return () => {};
    }
}

/**
 * 安全取消订阅
 */
export function off(eventName, handler) {
    if (!ENV.hasEventSource) return;

    try {
        const { eventSource } = SillyTavern.getContext();

        if (typeof eventSource.removeListener === 'function') {
            eventSource.removeListener(eventName, handler);
        } else if (typeof eventSource.off === 'function') {
            eventSource.off(eventName, handler);
        }

        const idx = _registeredListeners.findIndex(
            l => l.eventName === eventName && l.handler === handler
        );
        if (idx >= 0) _registeredListeners.splice(idx, 1);
    } catch (e) {
        logger.warn('Failed to unsubscribe event:', eventName, e);
    }
}

/**
 * 卸载所有由本扩展注册的事件
 */
export function offAll() {
    for (const { eventName, handler } of [..._registeredListeners]) {
        off(eventName, handler);
    }
    _registeredListeners.length = 0;
}

/**
 * 获取事件类型常量（带降级）
 * @param {string} name 常量名（如 'PRESET_CHANGED'）
 * @param {string} [fallback] 找不到时使用的字符串
 */
export function getEventType(name, fallback = null) {
    const fb = fallback ?? name.toLowerCase();
    if (!ENV.hasEventTypes) return fb;

    return safeCall(() => {
        const et = SillyTavern.getContext().event_types;
        return et[name] || fb;
    }, fb, `getEventType:${name}`);
}

// =====================================================
// UI 工具
// =====================================================

/**
 * 安全 toastr
 */
export const toast = {
    success(msg, title = '') {
        if (ENV.hasToastr) toastr.success(msg, title);
        else logger.info(`[toast] ${title} ${msg}`);
    },
    error(msg, title = '') {
        if (ENV.hasToastr) toastr.error(msg, title);
        else logger.error(`[toast] ${title} ${msg}`);
    },
    warning(msg, title = '') {
        if (ENV.hasToastr) toastr.warning(msg, title);
        else logger.warn(`[toast] ${title} ${msg}`);
    },
    info(msg, title = '') {
        if (ENV.hasToastr) toastr.info(msg, title);
        else logger.info(`[toast] ${title} ${msg}`);
    },
};

/**
 * 安全 confirm 弹窗
 * @returns {Promise<boolean>}
 */
export async function confirmSafe(title, message) {
    if (ENV.hasPopup) {
        try {
            const ctx = SillyTavern.getContext();
            const result = await ctx.Popup.show.confirm(title, message);
            return Boolean(result);
        } catch (e) {
            logger.warn('Popup.confirm failed, fallback to native:', e);
        }
    }
    // Fallback: native confirm 不支持 HTML，去掉所有标签防止显示原始 markup
    const stripHtml = (s) => String(s || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return window.confirm(`${stripHtml(title)}\n\n${stripHtml(message)}`);
}

/**
 * 安全创建 Popup 实例
 *
 * 集中防御 5+ 处 `new ctx.Popup(html, ctx.POPUP_TYPE.XXX, ...)` 调用，
 * 避免任一调用点因 ctx / Popup / POPUP_TYPE / 指定 type 缺失而抛出。
 *
 * ⚠️ 调用方必须检查返回值是否为 null，并按业务回退：
 *   - 显示用：可改为 `toast.warning(...)` 或 `confirmSafe(...)`
 *   - 输入用：可改为 `prompt(...)` 或直接 return
 *
 * SillyTavern Popup 构造签名：
 *   `new Popup(content, type, inputValue = '', options = {})`
 *
 * 第三个参数 inputValue：
 *   - INPUT 类型：作为输入框的默认值
 *   - 其他类型：通常被忽略（部分版本作为 inlineMessage）
 *
 * @param {string} html - Popup 显示的 HTML 内容
 * @param {string} [type='DISPLAY'] - POPUP_TYPE 键名，如 'DISPLAY' / 'INPUT' / 'CONFIRM' / 'TEXT'
 * @param {object} [options={}] - 透传给 ctx.Popup 构造函数的选项（wide / large / okButton 等）
 * @param {string} [inputValue=''] - INPUT 类型的默认输入值（其他类型通常忽略）
 * @returns {object|null} Popup 实例，失败时返回 null
 */
export function createPopupSafe(html, type = 'DISPLAY', options = {}, inputValue = '') {
    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx || typeof ctx.Popup !== 'function' || !ctx.POPUP_TYPE) {
            logger.warn('[createPopupSafe] Popup API not available · ctx/Popup/POPUP_TYPE missing');
            return null;
        }
        // 优先用调用方指定的 type，未定义时回退到 DISPLAY
        const popupType = (typeof ctx.POPUP_TYPE[type] !== 'undefined')
            ? ctx.POPUP_TYPE[type]
            : ctx.POPUP_TYPE.DISPLAY;
        if (typeof popupType === 'undefined') {
            logger.warn(`[createPopupSafe] POPUP_TYPE['${type}'] and DISPLAY both undefined`);
            return null;
        }
        return new ctx.Popup(html, popupType, inputValue || '', options || {});
    } catch (e) {
        logger.error('[createPopupSafe] failed:', e);
        return null;
    }
}

/**
 * 渲染扩展模板
 * @param {string} folder 扩展文件夹（如 'third-party/SillyTavern-PresetAutoSave'）
 * @param {string} template 模板名（不含 .html）
 * @param {object} [data] 模板数据
 */
export async function renderTemplate(folder, template, data = {}) {
    if (!ENV.hasRenderTemplate) {
        logger.error('renderExtensionTemplateAsync not available');
        return '';
    }

    return safeCallAsync(
        () => SillyTavern.getContext().renderExtensionTemplateAsync(folder, template, data),
        '',
        `renderTemplate:${template}`
    );
}

// =====================================================
// 国际化辅助
// =====================================================
/**
 * 翻译辅助函数
 * 优先使用 SillyTavern 的 ctx.translate / ctx.t；不可用时返回 key 本身
 * 支持 {{var}} 占位符替换
 *
 * @param {string} key 翻译键
 * @param {object} [vars] 占位符替换变量
 * @returns {string} 翻译后的字符串
 */
export function t(key, vars = null) {
    let result = key;
    if (ENV.hasTranslate) {
        try {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.translate === 'function') {
                result = ctx.translate(key);
            } else if (typeof ctx.t === 'function') {
                // 部分版本暴露的是模板字符串风格的 t``，回退到字符串风格
                result = ctx.t(key);
            }
        } catch (_) {
            result = key;
        }
    }

    // 占位符替换 {{var}}
    if (vars && typeof result === 'string') {
        for (const [k, v] of Object.entries(vars)) {
            const escapedKey = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(`{{\\s*${escapedKey}\\s*}}`, 'g'), () => String(v));
        }
    }
    return result;
}

// =====================================================
// localforage 包装（带降级）
// =====================================================
/**
 * 创建 localforage 实例（不可用时降级到 localStorage 适配器）
 */
export function createStorage(name, storeName) {
    if (ENV.hasLocalforage) {
        try {
            return SillyTavern.libs.localforage.createInstance({ name, storeName });
        } catch (e) {
            logger.warn('localforage createInstance failed, fallback:', e);
        }
    }
    return createLocalStorageAdapter(name + '_' + storeName);
}

function createLocalStorageAdapter(prefix) {
    logger.warn('Using localStorage adapter (5MB limit)');
    return {
        async getItem(key) {
            const v = localStorage.getItem(prefix + ':' + key);
            try { return v ? JSON.parse(v) : null; }
            catch (error) { throw new StorageReadError(key, error); }
        },
        async setItem(key, val) {
            try {
                localStorage.setItem(prefix + ':' + key, JSON.stringify(val));
                return val;
            } catch (e) {
                logger.error('localStorage setItem failed (quota?):', e);
                throw e;
            }
        },
        async removeItem(key) {
            localStorage.removeItem(prefix + ':' + key);
        },
        async keys() {
            const result = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix + ':')) {
                    result.push(k.slice(prefix.length + 1));
                }
            }
            return result;
        },
        async clear() {
            const keys = await this.keys();
            for (const k of keys) {
                await this.removeItem(k);
            }
        },
    };
}

// =====================================================
// 通用 HTML / 时间工具 — 已迁移至 key-utils.js 和 time-utils.js
// 上方通过 re-export 保持向后兼容
// =====================================================

// =====================================================
// 诊断报告
// =====================================================
/**
 * 输出当前环境的兼容性报告
 */
export function getCompatReport() {
    return {
        env: { ...ENV },
        registeredListeners: _registeredListeners.length,
        timestamp: new Date().toISOString(),
    };
}
