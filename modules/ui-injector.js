/**
 * UI 注入器
 *
 * 任务:
 *   1. 在预设栏最右侧注入历史按钮
 *   2. 注入状态指示器
 *   3. 监听原生预设UI变化, 重新注入
 */

import { logger } from './logger.js';
import { getSettings } from './settings.js';
import { showHistoryPanel } from './history-panel.js';

const HISTORY_BTN_ID = 'pas_history_btn';
const STATUS_DOT_ID = 'pas_status_dot';

export async function initUIInjector() {
    injectHistoryButton();
    if (getSettings().showStatusIndicator) {
        injectStatusIndicator();
    }
    observeUIChanges();
    logger.debug('UI injected');
}

/**
 * 注入历史按钮（预设栏最右边）
 */
function injectHistoryButton() {
    if (document.getElementById(HISTORY_BTN_ID)) return;

    // 目标: #settings_preset_openai 旁边的按钮组
    // TODO: 找到 OpenAI 预设栏的容器, append 按钮
    //
    // 参考的兄弟按钮:
    //   #new_oai_preset (➕)
    //   #update_oai_preset (💾)
    //   #delete_oai_preset (🗑)

    const btn = document.createElement('div');
    btn.id = HISTORY_BTN_ID;
    btn.className = 'menu_button menu_button_icon fa-solid fa-clock-rotate-left';
    btn.title = '历史记录';
    btn.addEventListener('click', () => showHistoryPanel());

    // TODO: 找到合适的父容器并插入
    // const container = document.querySelector('#settings_preset_openai').parentElement;
    // container.appendChild(btn);
}

/**
 * 注入状态指示器（预设名右侧的小圆点）
 */
function injectStatusIndicator() {
    if (document.getElementById(STATUS_DOT_ID)) return;

    const dot = document.createElement('span');
    dot.id = STATUS_DOT_ID;
    dot.className = 'pas-status-dot pas-status-idle';
    dot.title = '空闲';

    // TODO: 找到合适的位置插入
}

/**
 * 设置状态指示器状态
 * @param {'idle'|'pending'|'saving'|'saved'|'error'} state
 */
export function setStatus(state) {
    const dot = document.getElementById(STATUS_DOT_ID);
    if (!dot) return;

    dot.className = 'pas-status-dot pas-status-' + state;

    const titles = {
        idle: '空闲',
        pending: '等待保存...',
        saving: '保存中...',
        saved: '已保存',
        error: '保存失败',
    };
    dot.title = titles[state] || '';

    // saved 状态 2 秒后自动回到 idle
    if (state === 'saved') {
        setTimeout(() => setStatus('idle'), 2000);
    }
}

/**
 * 监听UI变化, 防止按钮被原生重渲染抹掉
 */
function observeUIChanges() {
    // TODO: 使用 MutationObserver 监听 settings panel,
    // 一旦发现按钮丢失则重新注入
}
