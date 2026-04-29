/**
 * SillyTavern Preset Auto Save
 * 主入口文件 - 编排所有模块的初始化
 *
 * @license AGPL-3.0
 */

import { initCompatibility, ENV } from './modules/compatibility.js';
import { initSettings } from './modules/settings.js';
import { initHistoryStore } from './modules/history-store.js';
import { initAutoSave } from './modules/auto-save.js';
import { initUIInjector } from './modules/ui-injector.js';
import { initHistoryPanel } from './modules/history-panel.js';
import { logger } from './modules/logger.js';

export const EXTENSION_NAME = 'preset_auto_save';
export const EXTENSION_FOLDER = 'third-party/SillyTavern-PresetAutoSave';

// =====================================================
// 生命周期 Hooks（manifest.json 声明）
// =====================================================

export async function onInstall() {
    logger.info('Installing...');
    // TODO: 初始化默认配置
}

export async function onUpdate() {
    logger.info('Updating...');
    // TODO: 版本迁移逻辑
}

export async function onActivate() {
    logger.info('Activating...');
    initCompatibility();
}

export async function onDelete() {
    logger.info('Removing data...');
    // TODO: 清理 IndexedDB
}

// =====================================================
// 主初始化流程
// =====================================================

(async function main() {
    logger.info('SillyTavern-PresetAutoSave v' + '1.0.0' + ' loading...');

    if (!window.SillyTavern || typeof window.SillyTavern.getContext !== 'function') {
        logger.error('SillyTavern context not available, abort.');
        return;
    }

    const { eventSource, event_types } = SillyTavern.getContext();

    // 阶段1: UI 已加载（loader 仍可见）
    eventSource.on(event_types.APP_INITIALIZED, async () => {
        logger.debug('APP_INITIALIZED');
        try {
            await initSettings();
            await initHistoryStore();
            await initUIInjector();
            await initHistoryPanel();
            logger.info('UI ready');
        } catch (e) {
            logger.error('APP_INITIALIZED phase error:', e);
        }
    });

    // 阶段2: 应用就绪
    eventSource.on(event_types.APP_READY, async () => {
        logger.debug('APP_READY');
        try {
            await initAutoSave();
            logger.info('All systems ready ✓');
        } catch (e) {
            logger.error('APP_READY phase error:', e);
        }
    });
})();
