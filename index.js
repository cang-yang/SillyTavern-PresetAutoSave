/**
 * SillyTavern Preset Auto Save
 * 主入口 - 编排所有模块的初始化流程
 *
 * @license AGPL-3.0
 * @version 1.0.0
 */

import { logger } from './modules/logger.js';
import {
    initCompatibility, ENV, offAll, on, getEventType,
    savePresetSafe, getPresetManager,
} from './modules/compatibility.js';
import { initSettings, getSettings, resetSettings } from './modules/settings.js';
import { initHistoryStore, getAllSnapshots, clearAll as clearAllSnapshots } from './modules/history-store.js';
import { initAutoSave, teardown as teardownAutoSave } from './modules/auto-save.js';
import { initUIInjector, teardown as teardownUI } from './modules/ui-injector.js';
import {
    initHistoryPanel,
    showHistoryPanel,
    showGroupingFirstScanWizard,
    teardownHistoryPanel,
} from './modules/history-panel.js';
import {
    initPresetTakeover,
    teardown as teardownTakeover,
    refreshTakeover,
    listSeriesFromNativeSelects,
    restoreAllFromArchive,
    getArchiveSummary,
    forceReseedSnapshots,
    listAllPresetsIncludingDetached,
} from './modules/preset-takeover.js';
import { clearAllArchived } from './modules/archive-store.js';
import { runGroupingSelfTest, parsePresetName, groupNamesBySeries } from './modules/preset-grouping.js';
import { initThemeDetector, teardownThemeDetector } from './modules/theme-detector.js';

const VERSION = '1.0.0';

// =====================================================
// 全局状态：跟踪初始化是否已经完成（防重入）
// =====================================================
let _phase1Done = false;
let _takeoverDone = false;
let _phase2Done = false;
let _mainEventsBound = false;       // 防止 main() 中事件重复订阅
let _mainEventUnsubscribers = [];   // main() 中订阅的事件取消函数

// =====================================================
// 阶段 1: UI 基础设施初始化（settings / store / 注入按钮 / 历史面板）
// =====================================================
async function runPhase1() {
    if (_phase1Done) return;
    _phase1Done = true;
    try {
        logger.debug('--- Phase 1: UI infrastructure ---');
        initThemeDetector();
        await initSettings();
        await initHistoryStore();
        await initUIInjector(showHistoryPanel);
        await initHistoryPanel();
        logger.success('Phase 1 ready: settings/store/UI ✓');
    } catch (e) {
        logger.error('Phase 1 init error:', e);
        _phase1Done = false; // 失败时允许重试
    }
}

// =====================================================
// 阶段 1.5: 预设接管（必须等 phase1 + DOM 就绪）
// =====================================================
async function runTakeoverPhase() {
    if (_takeoverDone) return;
    _takeoverDone = true;
    try {
        logger.debug('--- Phase 1.5: Preset takeover ---');
        await initPresetTakeover();
        logger.success('Phase 1.5 ready: takeover ✓');
    } catch (e) {
        logger.error('Takeover init error:', e);
        _takeoverDone = false;
    }
}

// =====================================================
// 阶段 2: 自动保存 + 后续工作
// =====================================================
async function runPhase2() {
    if (_phase2Done) return;
    _phase2Done = true;
    try {
        logger.debug('--- Phase 2: Auto save + grouping wizard ---');
        await initAutoSave();
        logger.success(`All systems operational ✓ [ST=${ENV.stVersion || 'unknown'}]`);

        // 调试模式下运行分组算法自检
        try {
            if (getSettings().debugMode) {
                runGroupingSelfTest(false);
            }
        } catch (_) { /* 忽略 */ }

        // 首次扫描向导：仅在未完成 + 启用分组 时延迟弹出
        try {
            const s = getSettings();
            if (s.groupingEnabled && !s.groupingFirstScanDone) {
                setTimeout(() => {
                    showGroupingFirstScanWizard().catch(e =>
                        logger.warn('Grouping first-scan wizard failed:', e)
                    );
                }, 4000);
            }
        } catch (e) {
            logger.warn('Schedule grouping wizard failed:', e);
        }
    } catch (e) {
        logger.error('Phase 2 init error:', e);
        _phase2Done = false;
    }
}

// =====================================================
// 生命周期 Hooks（manifest.json 声明）
// =====================================================
export async function onInstall() {
    logger.info(`Installing v${VERSION}`);
}

export async function onUpdate() {
    logger.info(`Updating to v${VERSION}`);
}

export async function onActivate() {
    logger.info(`Activating v${VERSION}`);
}

export async function onDelete() {
    logger.info('Uninstalling: restoring presets → clearing all plugin data');

    // ── Step 1: 同步 DOM 还原（瞬时，把被 detach 的 option 放回 select） ──
    try { teardownTakeover(); } catch (e) { logger.warn('teardownTakeover:', e); }

    // ── Step 2: 异步数据恢复 + 存储清理（带 4s 超时保护，防止超出 ST ~5s 限制） ──
    const dataOps = async () => {
        // 2a. 顺序执行：先恢复归档 → 再用快照补缺（有依赖关系）
        await restoreAllFromArchive().catch(e =>
            logger.error('Archive restore on onDelete failed:', e)
        );
        const r = await _writeBackLatestSnapshots({ skipExisting: true, filterGhosts: true });
        logger.success(`onDelete: snapshot writeback · ${r.written || 0} restored · ${r.skipped || 0} skipped`);

        // 2b. 并行执行：清空两个存储（互不依赖）
        const [snapResult, archiveResult] = await Promise.allSettled([
            clearAllSnapshots(),
            clearAllArchived(),
        ]);
        if (snapResult.status === 'rejected') logger.error('Clear snapshots failed:', snapResult.reason);
        if (archiveResult.status === 'rejected') logger.error('Clear archives failed:', archiveResult.reason);
    };

    let dataCleanupSuccess = false;
    try {
        await Promise.race([
            dataOps(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('onDelete timeout (4s)')), 4000)),
        ]);
        dataCleanupSuccess = true;
    } catch (e) {
        logger.warn('onDelete: data ops incomplete:', e.message || e);
    }

    // ── Step 3: 重置扩展设置（仅在数据清理成功时执行，避免残留数据但无设置的不一致状态） ──
    if (!dataCleanupSuccess) {
        logger.warn('onDelete: skipping resetSettings because data cleanup did not complete');
    }
    if (dataCleanupSuccess) {
        try {
            resetSettings();
            const ctx = SillyTavern.getContext();
            if (ctx.extensionSettings) {
                delete ctx.extensionSettings['preset_auto_save'];
                if (typeof ctx.saveSettingsDebounced === 'function') {
                    ctx.saveSettingsDebounced();
                }
                logger.debug('onDelete: extensionSettings.preset_auto_save cleared');
            }
        } catch (e) {
            logger.warn('onDelete: failed to clear extensionSettings:', e);
        }
    }

    // ── Step 4: 同步模块拆除（始终执行，即使上面超时） ──
    try { teardownThemeDetector(); } catch (_) { /* best-effort */ }
    try { teardownAutoSave(); } catch (_) { /* best-effort */ }
    try { teardownUI(); } catch (_) { /* best-effort */ }
    try { teardownHistoryPanel(); } catch (_) { /* best-effort */ }
    try { offAll(); } catch (_) { /* best-effort */ }

    logger.success('onDelete: cleanup complete — all plugin data cleared');
}

export function onEnable() {
    logger.info('Enabled');
}

/**
 * ⚡ C2+C3 重写：把有快照的预设写回 ST
 *
 * 两种模式（通过 opts 控制）：
 *
 *   onDelete 调用（skipExisting=true, filterGhosts=true）：
 *     - 过滤幽灵快照（presetName === 系列名 且同系列有其他真实版本）
 *     - 已存在于 ST 的预设 → 跳过（不覆盖用户的手动修改）
 *     - 不存在于 ST 的预设 → 用最新快照写回（恢复被数据接管删除的）
 *
 *   onDisable 调用（默认，skipExisting=false, filterGhosts=false）：
 *     - 保持旧行为：已存在的预设 → 用最新快照覆盖
 *     - 不存在的预设 → 跳过
 *
 * @param {object} [opts]
 * @param {boolean} [opts.skipExisting=false] true = 不覆盖已存在的预设（onDelete 语义）
 * @param {boolean} [opts.filterGhosts=false] true = 过滤掉系列名幽灵快照
 */
async function _writeBackLatestSnapshots(opts = {}) {
    const { skipExisting = false, filterGhosts = false } = opts;
    try {
        const allSnaps = await getAllSnapshots();
        if (!Array.isArray(allSnaps) || allSnaps.length === 0) return { written: 0, skipped: 0 };

        // 1. 按 (apiId, presetName) 分组，取每组中 timestamp 最大的快照
        const latestMap = new Map();
        for (const s of allSnaps) {
            if (!s || !s.presetName || !s.apiId) continue;
            const k = `${s.apiId}::${s.presetName}`;
            const cur = latestMap.get(k);
            if (!cur || (s.timestamp || 0) > (cur.timestamp || 0)) {
                latestMap.set(k, s);
            }
        }

        // 2. 过滤幽灵快照（presetName 等于系列名，且该系列有其他版本）
        //    这些是旧版 seedSnapshotsIfNeeded 把代表 option 系列名当预设名存的残留
        if (filterGhosts) {
            const seriesMembers = new Map(); // seriesKey → Set<presetName>
            for (const snap of latestMap.values()) {
                try {
                    const parsed = parsePresetName(snap.presetName);
                    const series = parsed.series || snap.presetName;
                    if (!seriesMembers.has(series)) seriesMembers.set(series, new Set());
                    seriesMembers.get(series).add(snap.presetName);
                } catch (_) { /* 解析失败 → 当独立预设，不过滤 */ }
            }
            for (const [key, snap] of [...latestMap.entries()]) {
                try {
                    const parsed = parsePresetName(snap.presetName);
                    const series = parsed.series || snap.presetName;
                    // 只有当 presetName === 系列名 且同系列还有其他成员时才是幽灵
                    if (snap.presetName === series) {
                        const members = seriesMembers.get(series);
                        if (members && members.size > 1) {
                            latestMap.delete(key);
                            logger.debug(`writeBack: filtered ghost snapshot "${snap.presetName}" (series has ${members.size} real versions)`);
                        }
                    }
                } catch (_) { /* 解析失败 → 保留 */ }
            }
        }

        // 3. 逐个写回 ST
        let written = 0, skipped = 0;
        for (const snap of latestMap.values()) {
            if (!snap.preset || typeof snap.preset !== 'object') {
                skipped++;
                continue;
            }
            try {
                const pm = getPresetManager(snap.apiId);

                if (skipExisting) {
                    // onDelete 语义：只恢复 ST 中不存在的预设（不覆盖已有的）
                    let exists = false;
                    if (pm && typeof pm.getPresetList === 'function') {
                        try {
                            const { preset_names } = pm.getPresetList(snap.apiId);
                            if (Array.isArray(preset_names)) {
                                exists = preset_names.includes(snap.presetName);
                            } else if (preset_names && typeof preset_names === 'object') {
                                exists = Object.hasOwn(preset_names, snap.presetName);
                            }
                        } catch (_) {}
                    }
                    // 兜底：findPreset 检查
                    if (!exists && pm && typeof pm.findPreset === 'function') {
                        exists = pm.findPreset(snap.presetName) !== undefined;
                    }
                    if (exists) { skipped++; continue; }
                } else {
                    // onDisable 语义（旧行为）：只覆盖已存在的预设
                    if (pm && typeof pm.findPreset === 'function') {
                        const found = pm.findPreset(snap.presetName);
                        if (found === undefined) { skipped++; continue; }
                    }
                }

                await savePresetSafe(snap.presetName, snap.preset, { apiId: snap.apiId, skipUpdate: true });
                written++;
            } catch (e) {
                logger.debug(`writeback failed for ${snap.presetName}:`, e);
                skipped++;
            }
        }
        return { written, skipped };
    } catch (e) {
        logger.warn('writeBackLatestSnapshots step failed:', e);
        return { written: 0, skipped: 0, error: String(e) };
    }
}

export function onDisable() {
    logger.info('Disabled - restoring presets to ST (snapshots + archives)');
    // onDisable 是同步钩子，但还原必须异步
    // 这里 fire-and-forget：先归档恢复，再快照写回
    (async () => {
        try {
            await restoreAllFromArchive();
        } catch (e) {
            logger.error('Archive restore on onDisable failed:', e);
        }
        try {
            const r = await _writeBackLatestSnapshots();
            logger.info(`onDisable writeback: ${r.written || 0} written, ${r.skipped || 0} skipped`);
        } catch (e) {
            logger.error('Snapshot writeback on onDisable failed:', e);
        }
    })();
    try {
        teardownThemeDetector();
        teardownTakeover();
        teardownAutoSave();
        teardownUI();
        teardownHistoryPanel();
        offAll();
    } catch (e) {
        logger.error('onDisable cleanup error:', e);
    }
}

// =====================================================
// 主初始化流程
// =====================================================
(async function main() {
    logger.info(`SillyTavern-PresetAutoSave v${VERSION} loading...`);

    if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
        logger.error('SillyTavern context not available, abort.');
        return;
    }

    // 兼容性探测（唯一入口）
    if (!initCompatibility()) {
        logger.error('Compatibility check failed, extension may not work properly');
    }

    const ctx = SillyTavern.getContext();
    const { eventSource, event_types } = ctx;

    // ============ 关键修复：检测当前 ST 是否已经过了 APP_INITIALIZED 阶段 ============
    // 之前 BUG：如果用户第一次安装/启用插件、ST 已加载完毕（事件已发出），
    //         我们的 eventSource.on(APP_INITIALIZED) 监听器会永远不会被触发，
    //         导致 settings / store / UI / takeover 全部不初始化。
    //
    // 修复策略：
    //   1) 立即注册事件监听器（捕获后续事件）
    //   2) 同时探测 DOM 状态：如果 #left-nav-panel 或 #completion_prompt_manager 已存在，
    //      说明 ST 已经初始化过了，立即手动调用初始化逻辑

    // 注册事件监听（幂等：只绑一次，使用 compatibility.on 确保可追踪 + offAll 可清理）
    if (!_mainEventsBound && eventSource && event_types) {
        _mainEventsBound = true;
        try {
            const evtInit = getEventType('APP_INITIALIZED', 'app_initialized');
            const unsub1 = on(evtInit, () => {
                logger.debug('[event] APP_INITIALIZED received');
                runPhase1().then(() => runTakeoverPhase());
            });
            if (typeof unsub1 === 'function') _mainEventUnsubscribers.push(unsub1);
        } catch (e) {
            logger.warn('Failed to bind APP_INITIALIZED:', e);
        }

        try {
            const evtReady = getEventType('APP_READY', 'app_ready');
            const unsub2 = on(evtReady, () => {
                logger.debug('[event] APP_READY received');
                runPhase2();
            });
            if (typeof unsub2 === 'function') _mainEventUnsubscribers.push(unsub2);
        } catch (e) {
            logger.warn('Failed to bind APP_READY:', e);
        }
    } else if (!eventSource || !event_types) {
        logger.warn('eventSource/event_types unavailable, fallback to DOM-ready bootstrap');
    }

    // 防御性兜底：用 DOM 状态判断 ST 是否已就绪
    //   如果以下任一信号成立，立即跑初始化（不等事件）：
    //     - document.readyState === 'complete'
    //     - 存在 select[data-preset-manager-for]（ST 已经渲染了预设栏）
    //     - 存在 #completion_prompt_manager_list（ST 的 prompt manager 已渲染）
    function isStAlreadyInitialized() {
        if (typeof document === 'undefined') return false;
        if (document.readyState !== 'complete') return false;
        if (document.querySelector('select[data-preset-manager-for]')) return true;
        if (document.querySelector('#completion_prompt_manager_list')) return true;
        if (document.querySelector('#preset_setting_select')) return true;
        return false;
    }

    function bootstrapIfReady() {
        if (isStAlreadyInitialized()) {
            logger.info('ST already initialized (detected via DOM), running phases manually');
            runPhase1()
                .then(() => runTakeoverPhase())
                .then(() => runPhase2());
            return true;
        }
        return false;
    }

    if (!bootstrapIfReady()) {
        // ST 还没就绪，监听 DOM 加载和定时检查
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(bootstrapIfReady, 500);
            });
        }

        // 兜底：每 1 秒检查一次，最多 30 秒
        let retries = 0;
        const fallbackTimer = setInterval(() => {
            retries++;
            if (_phase1Done || retries > 30) {
                clearInterval(fallbackTimer);
                if (!_phase1Done && retries > 30) {
                    logger.warn('Initialization timeout - ST DOM never appeared. Phase1 not started.');
                }
                return;
            }
            bootstrapIfReady();
        }, 1000);
    }

    // ============ 调试接口 ============
    if (typeof window !== 'undefined') {
        window.__pas = {
            version: VERSION,
            ENV,
            showHistoryPanel,
            refreshTakeover,
            logger,
            // 诊断接口：让用户能在控制台快速自查问题
            debug: {
                phase1Done: () => _phase1Done,
                takeoverDone: () => _takeoverDone,
                phase2Done: () => _phase2Done,
                listSeries: () => listSeriesFromNativeSelects(),
                forceInit: async () => {
                    await runPhase1();
                    await runTakeoverPhase();
                    await runPhase2();
                    return { phase1: _phase1Done, takeover: _takeoverDone, phase2: _phase2Done };
                },
                parse: (name) => parsePresetName(name),
                group: (names) => groupNamesBySeries(names || [], {}, {}),
                listAllOptions: () => {
                    const out = [];
                    try {
                        for (const s of document.querySelectorAll('select[data-preset-manager-for]')) {
                            const apiId = s.getAttribute('data-preset-manager-for');
                            // P1 fix: select.options 在某些 ST 版本/API 类型下可能为 undefined
                            const optsCol = (s && s.options) ? Array.from(s.options) : [];
                            const opts = optsCol
                                .map(o => {
                                    if (!o) return '';
                                    const v = (typeof o.value === 'string') ? o.value : '';
                                    const t = (typeof o.textContent === 'string') ? o.textContent.trim() : '';
                                    return v || t;
                                })
                                .filter(Boolean);
                            out.push({ apiId, count: opts.length, presetNames: opts });
                        }
                    } catch (e) {
                        logger.warn('[debug.listAllOptions] failed:', e);
                    }
                    return out;
                },
                // ⭐ 数据接管诊断：查看归档 + 手动恢复
                listArchived: () => getArchiveSummary(),
                restoreArchives: () => restoreAllFromArchive(),
                // ⭐ 一键清空所有插件数据并重新种子（用户报告残留数据时使用）
                fullReset: async () => {
                    logger.warn('[fullReset] clearing all snapshots + archives, then re-seeding...');
                    try { await clearAllSnapshots(); } catch (e) { logger.error('clear snapshots failed:', e); }
                    try { await clearAllArchived(); } catch (e) { logger.error('clear archives failed:', e); }
                    logger.info('[fullReset] data cleared, refreshing takeover and reseeding...');
                    try { refreshTakeover(); } catch (e) { logger.error('refreshTakeover failed:', e); }
                    try { await forceReseedSnapshots(); } catch (e) { logger.error('reseed failed:', e); }
                    logger.success('[fullReset] complete · 请刷新页面或重新打开历史面板');
                    return { ok: true };
                },
                // ⭐ 仅重新种子快照（不清数据）
                reseed: () => forceReseedSnapshots(),
                // ⭐ 显示当前面板看到的预设列表（用于诊断"乱七八糟数字"等问题）
                listPanelPresets: () => listAllPresetsIncludingDetached(),
            },
        };
        logger.debug('Debug interface available at window.__pas');
        logger.info('Tip: window.__pas.debug.fullReset() 一键清空+重新种子（推荐残留数据时使用） · window.__pas.debug.listPanelPresets() 查看面板能看到的预设 · window.__pas.debug.forceInit() 强制启动');
    }
})();
