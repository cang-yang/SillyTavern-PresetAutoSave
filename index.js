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
import { initHistoryPanel, showHistoryPanel } from './modules/history-panel.js';

const VERSION = '1.0.0';

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
    // activate 在加载阶段同步执行；此处仅做轻量级标记，
    // 真正的兼容性探测由 main() 统一负责，避免重复调用。
    logger.info(`Activating v${VERSION}`);
}

export async function onDelete() {
    logger.info('Cleaning up');
    try {
        teardownAutoSave();
        teardownUI();
        offAll();
    } catch (e) {
        logger.error('onDelete cleanup error:', e);
    }
}

export function onEnable() {
    logger.info('Enabled');
}

export function onDisable() {
    logger.info('Disabled');
    try {
        teardownAutoSave();
        teardownUI();
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

    const { eventSource, event_types } = SillyTavern.getContext();

    // ============ 阶段 1: APP_INITIALIZED ============
    // UI 已加载，loader 仍在显示
    eventSource.on(event_types.APP_INITIALIZED, async () => {
        try {
            logger.debug('--- APP_INITIALIZED phase ---');
            await initSettings();
            await initHistoryStore();
            await initUIInjector(showHistoryPanel);
            await initHistoryPanel();
            logger.success('UI ready ✓');
        } catch (e) {
            logger.error('APP_INITIALIZED phase error:', e);
        }
    });

    // ============ 阶段 2: APP_READY ============
    // 全部就绪，可以开始监听用户操作
    eventSource.on(event_types.APP_READY, async () => {
        try {
            logger.debug('--- APP_READY phase ---');
            await initAutoSave();
            logger.success('All systems operational ✓');
            logger.info(`Tracking [${ENV.stVersion}] - 历史按钮已就位`);
        } catch (e) {
            logger.error('APP_READY phase error:', e);
        }
    });

    // ============ 调试接口（开发期间）============
    if (typeof window !== 'undefined') {
        window.__pas = {
            version: VERSION,
            ENV,
            showHistoryPanel,
            logger,
        };
        logger.debug('Debug interface available at window.__pas');
    }
})();
