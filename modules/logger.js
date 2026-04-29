/**
 * SillyTavern Preset Auto Save - Logger
 * 统一日志工具
 *
 * 特性:
 *   - 统一前缀 [PAS]
 *   - 颜色标识不同级别
 *   - debug 级别可通过设置开关
 *   - 提供 group/table 等高级输出
 */

const PREFIX = '[PAS]';

const STYLES = {
    primary: 'color: #b794f6; font-weight: bold;',
    info:    'color: #60a5fa; font-weight: bold;',
    success: 'color: #4ade80; font-weight: bold;',
    warn:    'color: #fbbf24; font-weight: bold;',
    error:   'color: #ef4444; font-weight: bold;',
    debug:   'color: #94a3b8;',
};

let _debugEnabled = false;

export const logger = {
    /**
     * 启用/禁用 debug 输出
     * @param {boolean} enabled
     */
    setDebugMode(enabled) {
        _debugEnabled = !!enabled;
        if (_debugEnabled) {
            console.log('%c' + PREFIX, STYLES.primary, 'Debug mode enabled');
        }
    },

    isDebugMode() {
        return _debugEnabled;
    },

    /** 普通信息（始终输出） */
    info(...args) {
        console.log('%c' + PREFIX, STYLES.primary, ...args);
    },

    /** 成功提示 */
    success(...args) {
        console.log('%c' + PREFIX + ' ✓', STYLES.success, ...args);
    },

    /** 调试信息（仅 debugMode 时输出） */
    debug(...args) {
        if (_debugEnabled) {
            console.debug('%c' + PREFIX, STYLES.debug, ...args);
        }
    },

    /** 警告 */
    warn(...args) {
        console.warn('%c' + PREFIX, STYLES.warn, ...args);
    },

    /** 错误 */
    error(...args) {
        console.error('%c' + PREFIX, STYLES.error, ...args);
    },

    /** 开始一个分组（仅 debugMode） */
    group(label) {
        if (_debugEnabled) {
            console.group('%c' + PREFIX + ' ' + label, STYLES.primary);
        }
    },

    /** 结束分组 */
    groupEnd() {
        if (_debugEnabled) {
            console.groupEnd();
        }
    },

    /** 表格输出（仅 debugMode） */
    table(data, label) {
        if (_debugEnabled) {
            if (label) {
                console.log('%c' + PREFIX + ' ' + label, STYLES.primary);
            }
            console.table(data);
        }
    },

    /**
     * 性能计时开始
     * @param {string} label 标签
     */
    time(label) {
        if (_debugEnabled) {
            console.time(`${PREFIX} ${label}`);
        }
    },

    /** 性能计时结束 */
    timeEnd(label) {
        if (_debugEnabled) {
            console.timeEnd(`${PREFIX} ${label}`);
        }
    },
};