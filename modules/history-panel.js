/**
 * 历史面板控制器
 *
 * 包含:
 *   - 历史记录列表（带搜索/筛选/分组）
 *   - 设置 Tab（自定义保留条数、防抖等）
 */

import { logger } from './logger.js';
import { getSettings, updateSetting, DEFAULT_SETTINGS } from './settings.js';
import {
    getAllSnapshots,
    deleteSnapshot,
    getSnapshotById,
    getTotalSize,
    clearAll,
} from './history-store.js';
import { getPresetManager, getCurrentApiId } from './compatibility.js';

const EXTENSION_FOLDER = 'third-party/SillyTavern-PresetAutoSave';

let _popup = null;

export async function initHistoryPanel() {
    logger.debug('History panel ready');
}

/**
 * 打开历史面板
 */
export async function showHistoryPanel() {
    const ctx = SillyTavern.getContext();
    const Popup = ctx.Popup;

    const html = await ctx.renderExtensionTemplateAsync(
        EXTENSION_FOLDER,
        'history-panel',
        await buildPanelData()
    );

    _popup = new Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    _popup.show();

    // 绑定事件
    bindPanelEvents();
}

async function buildPanelData() {
    const all = await getAllSnapshots();
    const totalSize = await getTotalSize();

    return {
        snapshots: all,
        totalCount: all.length,
        totalSize: formatSize(totalSize),
        settings: getSettings(),
        defaultSettings: DEFAULT_SETTINGS,
    };
}

function bindPanelEvents() {
    // TODO: 绑定以下事件
    //   - Tab 切换 (历史 / 设置)
    //   - 搜索框输入
    //   - 筛选器点击
    //   - 卡片操作 (恢复/查看/删除)
    //   - 设置项变更
    //   - 清理按钮
}

/**
 * 恢复快照（带二次确认）
 */
export async function restoreSnapshot(snapshotId) {
    const ctx = SillyTavern.getContext();
    const snapshot = await getSnapshotById(snapshotId);
    if (!snapshot) {
        toastr.error('快照不存在');
        return;
    }

    const time = new Date(snapshot.timestamp).toLocaleString('zh-CN');
    const confirmed = await ctx.Popup.show.confirm(
        '确认恢复',
        '将恢复 "' + snapshot.presetName + '" 到 ' + time + ' 的版本，是否继续？'
    );

    if (!confirmed) return;

    try {
        const pm = getPresetManager(snapshot.apiId);
        if (!pm) throw new Error('PresetManager unavailable');

        await pm.savePreset(snapshot.presetName, snapshot.preset);

        // 重新选中该预设
        const optionValue = pm.findPreset(snapshot.presetName);
        if (optionValue !== undefined) {
            pm.selectPreset(optionValue);
        }

        toastr.success('已恢复到 ' + time);
    } catch (e) {
        logger.error('Restore failed:', e);
        toastr.error('恢复失败: ' + e.message);
    }
}

/**
 * 删除快照（带二次确认）
 */
export async function removeSnapshot(snapshotId) {
    const ctx = SillyTavern.getContext();
    const confirmed = await ctx.Popup.show.confirm('删除快照', '确认删除这条历史记录？');
    if (!confirmed) return;

    await deleteSnapshot(snapshotId);
    toastr.success('已删除');
}

// 工具
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
