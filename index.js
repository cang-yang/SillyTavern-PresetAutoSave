/**
 * SillyTavern Preset Auto Save
 * 主入口 - 编排所有模块的初始化流程
 *
 * @license AGPL-3.0
 * @version 1.0.0
 */

import { initLogger, logger, teardownLogger } from './modules/logger.js';
import {
    initCompatibility, ENV, offAll, on, getEventType,
    savePresetSafe, getPresetManager, getContextSafe,
} from './modules/compatibility.js';
import { initSettings, getSettings, resetSettings } from './modules/settings.js';
import {
    initHistoryStore,
    teardownHistoryStore,
    getAllSnapshots,
    clearAll as clearAllSnapshots,
} from './modules/history-store.js';
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
import { runDeleteRecovery } from './modules/core/lifecycle-recovery.js';
import { RuntimeTimerRegistry } from './modules/core/runtime-timers.js';
import { createDebugInterface } from './modules/debug-interface.js';
import { createSnapshotWriteback } from './modules/core/snapshot-writeback.js';

const VERSION = '1.0.0';

// =====================================================
// 全局状态：跟踪初始化是否已经完成（防重入）
// =====================================================
let _phase1Done = false;
let _takeoverDone = false;
let _phase2Done = false;
let _runtimeReadyPromise = null;
let _mainEventsBound = false;       // 防止 main() 中事件重复订阅
let _mainEventUnsubscribers = [];   // main() 中订阅的事件取消函数
const _runtimeTimers = new RuntimeTimerRegistry();
let _domReadyHandler = null;
const _writeBackLatestSnapshots = createSnapshotWriteback({
    loadSnapshots: getAllSnapshots,
    getPresetManager,
    savePreset: savePresetSafe,
    parsePresetName,
    logger,
});

function resetLifecycleState() {
    _runtimeTimers.clearAll();
    if (_domReadyHandler && typeof document !== 'undefined') {
        document.removeEventListener('DOMContentLoaded', _domReadyHandler);
        _domReadyHandler = null;
    }
    _phase1Done = false;
    _takeoverDone = false;
    _phase2Done = false;
    _runtimeReadyPromise = null;
    _mainEventsBound = false;
    _mainEventUnsubscribers = [];
}

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
        try { await teardownHistoryStore(); } catch (_) { /* best-effort */ }
        _phase1Done = false; // 失败时允许重试
    }
}

// =====================================================
// 阶段 1.5: 预设接管（必须等 phase1 + DOM 就绪）
// =====================================================
async function runTakeoverPhase() {
    if (_takeoverDone) return;
    if (!_phase1Done) {
        logger.warn('Takeover phase deferred because Phase 1 is not ready');
        return;
    }
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
    if (!_phase1Done || !_takeoverDone) {
        logger.debug('Auto-save phase is waiting for storage/takeover initialization');
        return;
    }
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
                _runtimeTimers.schedule(() => {
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
    logger.info('Uninstalling: quiescing saves → restoring presets → clearing verified recovery data');

    let saveQuiesced = false;
    try {
        await teardownAutoSave();
        saveQuiesced = true;
    } catch (e) {
        logger.error('onDelete: could not quiesce auto-save; recovery data will be preserved', e);
    }
    try { await teardownTakeover(); } catch (e) { logger.warn('teardownTakeover:', e); }

    const recovery = saveQuiesced
        ? await runDeleteRecovery({
            restoreArchives: restoreAllFromArchive,
            writeBackSnapshots: () => _writeBackLatestSnapshots({ skipExisting: true, filterGhosts: true }),
            clearSnapshots: clearAllSnapshots,
            clearArchives: clearAllArchived,
        })
        : {
            complete: false,
            archive: { failed: 1 },
            snapshots: { failed: 1 },
            snapshotsCleared: false,
            archivesCleared: false,
            errors: { snapshots: 'Auto-save did not quiesce', archives: 'Auto-save did not quiesce' },
        };

    logger.info(
        `onDelete recovery: archives=${recovery.archive?.restored || 0} restored/` +
        `${recovery.archive?.failed || 0} failed, snapshots=${recovery.snapshots?.written || 0} written/` +
        `${recovery.snapshots?.failed || 0} failed`
    );
    if (recovery.errors?.snapshots) logger.warn('Snapshot recovery data preserved:', recovery.errors.snapshots);
    if (recovery.errors?.archives) logger.warn('Archive recovery data preserved:', recovery.errors.archives);

    let settingsCleared = false;
    if (recovery.complete) {
        try {
            resetSettings();
            const ctx = getContextSafe();
            if (!ctx) throw new Error('SillyTavern context unavailable');
            if (ctx.extensionSettings) {
                delete ctx.extensionSettings['preset_auto_save'];
                if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            }
            settingsCleared = true;
        } catch (e) {
            logger.warn('onDelete: failed to clear extension settings:', e);
        }
    } else {
        logger.warn('onDelete: recovery was incomplete; settings and remaining recovery data were preserved');
    }

    try { teardownThemeDetector(); } catch (_) { /* best-effort */ }
    try { teardownUI(); } catch (_) { /* best-effort */ }
    try { teardownHistoryPanel(); } catch (_) { /* best-effort */ }
    try { await teardownHistoryStore(); } catch (e) { logger.warn('teardownHistoryStore:', e); }
    try { offAll(); } catch (_) { /* best-effort */ }
    resetLifecycleState();

    if (recovery.complete && settingsCleared) logger.success('onDelete: verified recovery and cleanup complete');
    else logger.warn('onDelete: partial cleanup completed; no unverified recovery data was deleted');
    teardownLogger();
    return { ...recovery, settingsCleared };
}

/**
 * One serialized initialization path for DOM fallback and both ST lifecycle events.
 * APP_READY can be emitted while APP_INITIALIZED work is still awaiting storage;
 * sharing this promise turns that normal race into an await instead of a warning.
 */
function ensureRuntimeReady() {
    if (_phase1Done && _takeoverDone && _phase2Done) return Promise.resolve(true);
    if (_runtimeReadyPromise) return _runtimeReadyPromise;

    _runtimeReadyPromise = (async () => {
        await runPhase1();
        if (!_phase1Done) return false;
        await runTakeoverPhase();
        if (!_takeoverDone) return false;
        await runPhase2();
        return _phase1Done && _takeoverDone && _phase2Done;
    })().finally(() => {
        _runtimeReadyPromise = null;
    });
    return _runtimeReadyPromise;
}

export async function onEnable() {
    initLogger();
    logger.info('Enabled - initializing extension runtime');
    if (!initCompatibility()) {
        logger.error('Required SillyTavern capabilities unavailable; enable aborted');
        return { ready: false };
    }
    await ensureRuntimeReady();
    const ready = _phase1Done && _takeoverDone && _phase2Done;
    if (!ready) logger.warn('Enable completed with one or more initialization phases unavailable');
    return { ready };
}

export async function onDisable() {
    logger.info('Disabled - restoring presets to ST (snapshots + archives)');
    let saveQuiesced = false;
    try {
        await teardownAutoSave();
        saveQuiesced = true;
    } catch (e) {
        logger.error('onDisable: could not quiesce auto-save; preset recovery skipped', e);
    }
    try { await teardownTakeover(); } catch (e) { logger.warn('teardownTakeover:', e); }

    let archive = { restored: 0, failed: 1, cleanupFailed: 0 };
    let snapshots = { written: 0, skipped: 0, failed: 1 };
    if (saveQuiesced) {
        archive = await restoreAllFromArchive();
        snapshots = await _writeBackLatestSnapshots();
    }

    try { teardownThemeDetector(); } catch (_) { /* best-effort */ }
    try { teardownUI(); } catch (_) { /* best-effort */ }
    try { teardownHistoryPanel(); } catch (_) { /* best-effort */ }
    try { await teardownHistoryStore(); } catch (e) { logger.warn('teardownHistoryStore:', e); }
    try { offAll(); } catch (_) { /* best-effort */ }
    resetLifecycleState();

    const complete = saveQuiesced
        && Number(archive.failed || 0) === 0
        && Number(archive.cleanupFailed || 0) === 0
        && Number(snapshots.failed || 0) === 0;
    logger.info(
        `onDisable recovery: ${archive.restored || 0} archives restored, ` +
        `${snapshots.written || 0} snapshots written, ${snapshots.skipped || 0} skipped, ` +
        `${(archive.failed || 0) + (archive.cleanupFailed || 0) + (snapshots.failed || 0)} failed`
    );
    teardownLogger();
    return { complete, archive, snapshots };
}

// =====================================================
// 主初始化流程
// =====================================================
(async function main() {
    initLogger();
    logger.info(`SillyTavern-PresetAutoSave v${VERSION} loading...`);

    // 兼容性探测（唯一入口）
    if (!initCompatibility()) {
        logger.error('Required SillyTavern capabilities unavailable; startup aborted');
        return;
    }

    const ctx = getContextSafe();
    if (!ctx) {
        logger.error('SillyTavern context not available; startup aborted');
        return;
    }
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
                ensureRuntimeReady();
            });
            if (typeof unsub1 === 'function') _mainEventUnsubscribers.push(unsub1);
        } catch (e) {
            logger.warn('Failed to bind APP_INITIALIZED:', e);
        }

        try {
            const evtReady = getEventType('APP_READY', 'app_ready');
            const unsub2 = on(evtReady, () => {
                logger.debug('[event] APP_READY received');
                ensureRuntimeReady();
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
            ensureRuntimeReady();
            return true;
        }
        return false;
    }

    if (!bootstrapIfReady()) {
        // ST 还没就绪，监听 DOM 加载和定时检查
        if (document.readyState === 'loading') {
            _domReadyHandler = () => {
                _domReadyHandler = null;
                _runtimeTimers.schedule(bootstrapIfReady, 500);
            };
            document.addEventListener('DOMContentLoaded', _domReadyHandler, { once: true });
        }

        // 兜底：每 1 秒检查一次，最多 30 秒
        let retries = 0;
        const fallbackTimer = _runtimeTimers.repeat(() => {
            retries++;
            if (_phase1Done || retries > 30) {
                _runtimeTimers.cancel(fallbackTimer);
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
        window.__pas = createDebugInterface({
            version: VERSION,
            env: ENV,
            showHistoryPanel,
            refreshTakeover,
            logger,
            phaseState: () => ({ phase1: _phase1Done, takeover: _takeoverDone, phase2: _phase2Done }),
            ensureRuntimeReady,
            listSeries: listSeriesFromNativeSelects,
            parsePresetName,
            groupNamesBySeries,
            listArchived: getArchiveSummary,
            restoreArchives: restoreAllFromArchive,
            reseed: forceReseedSnapshots,
            listPanelPresets: listAllPresetsIncludingDetached,
            documentObject: document,
        });
        logger.debug('Debug interface available at window.__pas');
        logger.info('Tip: window.__pas.debug.reseed() 补种缺失快照 · window.__pas.debug.listPanelPresets() 查看面板能看到的预设 · window.__pas.debug.forceInit() 强制启动');
    }
})();
