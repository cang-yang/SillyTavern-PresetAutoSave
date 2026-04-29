/**
 * 自动保存模块
 *
 * 工作流程:
 *   1. 监听设置区域内的所有输入事件
 *   2. 防抖处理
 *   3. 检测变化 -> 触发保存
 *   4. 切换前自动备份
 */

import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { getPresetManager, getCurrentApiId, ENV } from './compatibility.js';
import { addSnapshot } from './history-store.js';
import { setStatus } from './ui-injector.js';

let _debounceTimer = null;
let _lastSnapshotHash = null;
let _isInternalSave = false;

/**
 * 初始化自动保存
 */
export async function initAutoSave() {
    const settings = getSettings();
    if (!settings.enabled) {
        logger.info('Auto-save disabled by settings');
        return;
    }

    bindUIListeners();
    bindSwitchGuard();

    logger.info('Auto-save activated');
}

/**
 * 监听UI事件
 */
function bindUIListeners() {
    // TODO: 监听以下区域的 input/change 事件
    //   - #openai_settings (OpenAI设置)
    //   - #completion_prompt_manager (Prompt Manager)
    //   - #range_block (通用滑块区)
    //
    // 注意:
    //   - 滑块: 仅在 mouseup/touchend 时保存（避免拖动时狂存）
    //   - 文本框: input事件 + 较长防抖
    //   - 复选框: change立即触发
}

/**
 * 切换保护
 */
function bindSwitchGuard() {
    if (!getSettings().enableSwitchGuard) return;

    const { eventSource, event_types } = SillyTavern.getContext();
    const beforeEventName = event_types.OAI_PRESET_CHANGED_BEFORE || 'oai_preset_changed_before';

    eventSource.on(beforeEventName, async (data) => {
        // TODO: 切换前检测dirty状态, 必要时备份当前预设
    });
}

/**
 * 触发保存（带防抖）
 */
export function scheduleAutoSave() {
    const settings = getSettings();
    clearTimeout(_debounceTimer);
    setStatus('pending');

    _debounceTimer = setTimeout(async () => {
        await doSave();
    }, settings.debounceMs);
}

/**
 * 立即执行保存
 */
async function doSave() {
    if (_isInternalSave) return;

    try {
        _isInternalSave = true;
        setStatus('saving');

        const apiId = getCurrentApiId();
        const pm = getPresetManager(apiId);
        if (!pm) {
            logger.warn('No preset manager available');
            setStatus('error');
            return;
        }

        const presetName = pm.getSelectedPresetName();
        const settings = pm.getPresetSettings(presetName);

        // 哈希对比，跳过未变化的保存
        const hash = JSON.stringify(settings);
        if (hash === _lastSnapshotHash) {
            setStatus('idle');
            return;
        }

        // 1. 创建历史快照
        await addSnapshot(presetName, apiId, settings, 'auto');

        // 2. 调用 savePreset
        await pm.savePreset(presetName, settings, { skipUpdate: true });

        _lastSnapshotHash = hash;
        setStatus('saved');

        if (getSettings().notifyOnSave && window.toastr) {
            toastr.success('预设已自动保存');
        }
    } catch (e) {
        logger.error('Auto-save failed:', e);
        setStatus('error');
    } finally {
        _isInternalSave = false;
    }
}
