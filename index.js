/**
 * SillyTavern Preset Auto Save
 * 主入口 - 编排所有模块的初始化流程
 *
 * @license AGPL-3.0
 * @version 1.0.0
 */

import { logger } from './modules/logger.js';
import { initCompatibility, ENV, offAll } from './modules/compatibility.js';
import { initSettings } from './modules/settings.js';
import { initHistoryStore } from './modules/history-store.js';
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
} from './modules/preset-takeover.js';
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
    logger.info('Cleaning up + restoring archived presets to ST');
    try {
        // 关键：卸载前必须把所有"被数据接管"归档的预设回写到 ST
        //         否则用户卸载插件后，他的预设会消失
        await restoreAllFromArchive().catch(e =>
            logger.error('Archive restore on onDelete failed:', e)
        );
        teardownTakeover();
        teardownAutoSave();
        teardownUI();
        teardownHistoryPanel();
        offAll();
    } catch (e) {
        logger.error('onDelete cleanup error:', e);
    }
}

export function onEnable() {
    logger.info('Enabled');
}

export function onDisable() {
    logger.info('Disabled - restoring archived presets to ST');
    // onDisable 是同步钩子，但归档恢复必须异步
    // 这里发起异步恢复，但不阻塞 disable 流程
    Promise.resolve(restoreAllFromArchive()).catch(e =>
        logger.error('Archive restore on onDisable failed:', e)
    );
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
            },
        };
        logger.debug('Debug interface available at window.__pas');
        logger.info('Tip: window.__pas.debug.forceInit() 强制启动 · window.__pas.debug.listAllOptions() 查看下拉 · window.__pas.debug.listArchived() 查看归档');
    }
})();
