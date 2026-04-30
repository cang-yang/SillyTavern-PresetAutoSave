/**
 * SillyTavern Preset Auto Save
 * 主入口 - 编排所有模块的初始化流程
 *
 * @license AGPL-3.0
 * @version 1.0.0
 */

import { logger } from './modules/logger.js';
import {
    initCompatibility, ENV, offAll,
    savePresetSafe, getPresetManager,
} from './modules/compatibility.js';
import { initSettings } from './modules/settings.js';
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
import { getSettings } from './modules/settings.js';
import { runGroupingSelfTest, parsePresetName, groupNamesBySeries } from './modules/preset-grouping.js';

const VERSION = '1.0.0';

// =====================================================
// 全局状态：跟踪初始化是否已经完成（防重入）
// =====================================================
let _phase1Done = false;
let _takeoverDone = false;
let _phase2Done = false;

// =====================================================
// 阶段 1: UI 基础设施初始化（settings / store / 注入按钮 / 历史面板）
// =====================================================
async function runPhase1() {
    if (_phase1Done) return;
    _phase1Done = true;
    try {
        logger.debug('--- Phase 1: UI infrastructure ---');
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
    logger.info('Cleaning up: restoring all presets to ST (snapshots + archives)');
    try {
        // 用户语义（B11）：
        //   - 未修改过的预设（无快照）→ 保留 ST 中的原始数据，什么都不动
        //   - 已修改的预设（有快照） → 把"最新快照数据"写回 ST，让用户卸载插件后
        //                              拿到的是他在面板里编辑的最新版本
        //   - 数据接管模式下被归档的预设 → restoreAllFromArchive 已处理（优先快照、回退归档）
        //
        // DOM 接管模式：select.options 中被 detach 的非代表 option 由 teardownTakeover 自动复原；
        //                ST 内部 oai_settings.preset_names 始终完整 → 预设数据本身不会丢。

        // 1) 数据接管的归档恢复（内部已实现"snapshot 优先 → archive fallback"）
        await restoreAllFromArchive().catch(e =>
            logger.error('Archive restore on onDelete failed:', e)
        );

        // 2) 把所有"有快照的预设"的最新快照写回 ST
        const r = await _writeBackLatestSnapshots();
        logger.success(`onDelete: latest snapshot writeback · ${r.written || 0} written · ${r.skipped || 0} skipped`);

        // 3) 拆下所有 DOM 接管标记，让原下拉恢复完整
        teardownTakeover();
        teardownAutoSave();
        teardownUI();
        teardownHistoryPanel();
        offAll();
        logger.success('onDelete: cleanup complete');
    } catch (e) {
        logger.error('onDelete cleanup error:', e);
    }
}

export function onEnable() {
    logger.info('Enabled');
}

/**
 * 把所有"有快照的预设"的最新快照写回 ST（onDisable / onDelete 共用）
 * 用户语义：未修改的预设保留原始；已修改的预设以最新快照覆盖
 */
async function _writeBackLatestSnapshots() {
    try {
        const allSnaps = await getAllSnapshots();
        if (!Array.isArray(allSnaps) || allSnaps.length === 0) return { written: 0, skipped: 0 };
        const latestMap = new Map();
        for (const s of allSnaps) {
            if (!s || !s.presetName || !s.apiId) continue;
            const k = `${s.apiId}::${s.presetName}`;
            const cur = latestMap.get(k);
            if (!cur || (s.timestamp || 0) > (cur.timestamp || 0)) {
                latestMap.set(k, s);
            }
        }
        let written = 0, skipped = 0;
        for (const snap of latestMap.values()) {
            if (!snap.preset || typeof snap.preset !== 'object') {
                skipped++;
                continue;
            }
            try {
                const pm = getPresetManager(snap.apiId);
                // 只在 ST 实际能找到这个预设时才覆盖；
                //   找不到 = ST 自己也没有 → 不创建（用户没要求新建）
                if (pm && typeof pm.findPreset === 'function') {
                    const found = pm.findPreset(snap.presetName);
                    if (found === undefined) { skipped++; continue; }
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

    // 注册事件监听
    if (eventSource && event_types) {
        try {
            eventSource.on(event_types.APP_INITIALIZED, () => {
                logger.debug('[event] APP_INITIALIZED received');
                runPhase1().then(() => runTakeoverPhase());
            });
        } catch (e) {
            logger.warn('Failed to bind APP_INITIALIZED:', e);
        }

        try {
            eventSource.on(event_types.APP_READY, () => {
                logger.debug('[event] APP_READY received');
                runPhase2();
            });
        } catch (e) {
            logger.warn('Failed to bind APP_READY:', e);
        }
    } else {
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

    // ============ 兜底：浏览器关闭/页面卸载时尝试还原归档 ============
    // 这是关键安全网：即使用户没正确卸载插件，下次启动时如果发现归档没还原，
    // 也会自动还原以防数据丢失
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => {
            // 不能 await，但可以发起 Promise（成功率较低，主要靠 onDelete/onDisable）
            try {
                if (getSettings && getSettings().takeoverMode === 'data') {
                    // 注意：这是 best-effort，浏览器可能不会等
                    restoreAllFromArchive();
                }
            } catch (_) {}
        });
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
                    for (const s of document.querySelectorAll('select[data-preset-manager-for]')) {
                        const apiId = s.getAttribute('data-preset-manager-for');
                        const opts = Array.from(s.options).map(o => o.value || o.textContent);
                        out.push({ apiId, count: opts.length, presetNames: opts });
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
