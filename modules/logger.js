/**
 * SillyTavern Preset Auto Save - Logger
 * 统一日志工具（含内存缓冲 + 持久化 + 导出）
 *
 * 特性:
 *   - 统一前缀 [PAS]
 *   - 颜色标识不同级别
 *   - 环形缓冲区保留最近 N 条日志（可面板查看/导出）
 *   - 可选写入 localStorage（页面刷新不丢失）
 *   - 全局错误自动捕获（unhandledrejection / window.onerror）
 *   - debug 级别可通过设置开关
 *   - 监听者机制（面板实时刷新）
 *   - 提供 group/table 等高级输出
 *
 * 使用:
 *   logger.info('something');
 *   logger.error('failed', err);
 *   logger.getLogs({ level: 'error', limit: 100 });
 *   logger.exportLogs();
 *   logger.subscribe(entry => ...);
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

// =====================================================
// 日志级别
// =====================================================
export const LOG_LEVEL = Object.freeze({
    DEBUG:   'debug',
    INFO:    'info',
    SUCCESS: 'success',
    WARN:    'warn',
    ERROR:   'error',
});

const LEVEL_ORDER = ['debug', 'info', 'success', 'warn', 'error'];

// =====================================================
// 配置
// =====================================================
const MAX_BUFFER = 1000;             // 内存中最多保留 1000 条
const PERSIST_KEY = 'pas-log-buffer';
const PERSIST_LIMIT = 200;           // localStorage 最多保留 200 条
const PERSIST_DEBOUNCE_MS = 500;     // 持久化防抖

// =====================================================
// 状态
// =====================================================
let _debugEnabled = false;
let _persistEnabled = true;
const _buffer = [];                  // 环形缓冲区（数组，超出时 shift）
const _listeners = new Set();
let _persistTimer = null;
let _seq = 0;
let _globalHandlerTarget = null;

// =====================================================
// 启动时恢复 localStorage 中的日志（让面板能看到上次会话）
// =====================================================
try {
    if (typeof localStorage !== 'undefined') {
        if (localStorage.getItem('pas-debug') === '1') {
            _debugEnabled = true;
            console.log('%c' + PREFIX, STYLES.primary, 'Debug mode enabled via localStorage');
        }
        const raw = localStorage.getItem(PERSIST_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                for (const e of arr) {
                    if (e && typeof e === 'object') _buffer.push(e);
                }
                _seq = _buffer.length > 0 ? (_buffer[_buffer.length - 1].seq || _buffer.length) : 0;
            }
        }
    }
} catch (_) {
    // 忽略，localStorage 不可用或 JSON 解析失败时不应阻塞插件
}

// =====================================================
// 内部工具
// =====================================================
function levelStyle(level) {
    return STYLES[level] || STYLES.primary;
}

/**
 * 单条日志最大长度（防止意外 log 巨型对象拖垮内存）
 * 1000 条 × 4KB ≈ 4MB（合理上限）
 */
const MAX_ARG_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 8192;

/**
 * 把任意参数序列化为可读字符串（用于面板展示与导出）
 * - Error 对象保留 stack
 * - 普通对象 JSON.stringify（最多 2 层避免循环）
 * - 单参数过长时截断并标注
 */
function stringifyArg(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') {
        return arg.length > MAX_ARG_LENGTH ? arg.slice(0, MAX_ARG_LENGTH) + `…(+${arg.length - MAX_ARG_LENGTH} chars)` : arg;
    }
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) {
        const s = arg.stack || `${arg.name}: ${arg.message}`;
        return s.length > MAX_ARG_LENGTH ? s.slice(0, MAX_ARG_LENGTH) + '…(stack truncated)' : s;
    }
    let result;
    try {
        const seen = new WeakSet();
        result = JSON.stringify(arg, (k, v) => {
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
            if (typeof v === 'bigint') return String(v) + 'n';
            return v;
        }, 0);
    } catch (_) {
        try { result = String(arg); } catch (_) { return '[Unserializable]'; }
    }
    if (typeof result === 'string' && result.length > MAX_ARG_LENGTH) {
        return result.slice(0, MAX_ARG_LENGTH) + `…(+${result.length - MAX_ARG_LENGTH} chars truncated)`;
    }
    return result;
}

function formatArgs(args) {
    if (!Array.isArray(args) || args.length === 0) return '';
    let msg = args.map(stringifyArg).join(' ');
    // 整条消息再做一次封顶（防止多个大参数 join 后膨胀）
    if (msg.length > MAX_MESSAGE_LENGTH) {
        msg = msg.slice(0, MAX_MESSAGE_LENGTH) + `…(+${msg.length - MAX_MESSAGE_LENGTH} chars)`;
    }
    return msg;
}

/**
 * 决定一条日志是否应该被记录到缓冲区
 * - error / warn: 始终记录（这是问题排查的关键证据）
 * - 其他级别（info/success/debug）: 仅在 _debugEnabled 时记录
 *
 * 这是一个重要的性能优化：debug 关闭时（默认状态）我们完全
 * 不进行 formatArgs（涉及大对象 JSON.stringify）+ 不写缓冲 +
 * 不调度持久化 + 不通知订阅者。整个链路在用户日常使用时为零开销。
 */
function shouldBuffer(level) {
    if (level === 'error' || level === 'warn') return true;
    return _debugEnabled;
}

function pushEntry(level, args) {
    if (!shouldBuffer(level)) return null;
    const entry = {
        seq: ++_seq,
        ts: Date.now(),
        level,
        message: formatArgs(args),
    };
    _buffer.push(entry);
    if (_buffer.length > MAX_BUFFER) {
        _buffer.splice(0, _buffer.length - MAX_BUFFER);
    }
    schedulePersist();
    notifyListeners(entry);
    return entry;
}

function schedulePersist() {
    if (!_persistEnabled) return;
    if (_persistTimer) return;
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        persistNow();
    }, PERSIST_DEBOUNCE_MS);
}

function persistNow() {
    if (!_persistEnabled) return;
    try {
        if (typeof localStorage === 'undefined') return;
        const slice = _buffer.slice(-PERSIST_LIMIT);
        localStorage.setItem(PERSIST_KEY, JSON.stringify(slice));
    } catch (_) {
        // 配额满或被禁用都安静失败，不能反过来打日志造成递归
    }
}

function notifyListeners(entry) {
    if (_listeners.size === 0) return;
    for (const fn of _listeners) {
        try { fn(entry); } catch (_) {}
    }
}

function handleGlobalError(ev) {
    if (!ev) return;
    const msg = ev.message || (ev.error && ev.error.message) || 'Unknown error';
    // 仅捕获我们插件内的脚本错误（避免把整个 ST 报错都收进来）
    const src = ev.filename || '';
    if (src && /SillyTavern-PresetAutoSave|\/extensions\/.+PresetAutoSave/i.test(src)) {
        pushEntry('error', ['[GlobalError]', msg, ev.error?.stack || `${src}:${ev.lineno}:${ev.colno}`]);
    }
}

function handleUnhandledRejection(ev) {
    if (!ev) return;
    const reason = ev.reason;
    // 同样限制为我们的栈
    const stack = (reason && reason.stack) || '';
    if (/SillyTavern-PresetAutoSave|PresetAutoSave/.test(stack) || /pas-/i.test(String(reason))) {
        pushEntry('error', ['[UnhandledRejection]', reason?.message || String(reason), stack]);
    }
}

/**
 * Install extension-scoped global error capture for the active runtime.
 * Repeated calls for the same target are no-ops; switching targets first
 * detaches the previous handlers so hot reloads cannot accumulate listeners.
 */
export function initLogger(target = typeof window !== 'undefined' ? window : null) {
    if (!target || typeof target.addEventListener !== 'function') return false;
    if (_globalHandlerTarget === target) return false;
    if (_globalHandlerTarget) teardownLogger();

    let errorHandlerInstalled = false;
    try {
        target.addEventListener('error', handleGlobalError);
        errorHandlerInstalled = true;
        target.addEventListener('unhandledrejection', handleUnhandledRejection);
        _globalHandlerTarget = target;
        return true;
    } catch (_) {
        if (errorHandlerInstalled && typeof target.removeEventListener === 'function') {
            try { target.removeEventListener('error', handleGlobalError); } catch (_) {}
        }
        return false;
    }
}

/** Detach exactly the handlers installed by initLogger. */
export function teardownLogger() {
    const target = _globalHandlerTarget;
    if (!target) return false;
    _globalHandlerTarget = null;
    if (typeof target.removeEventListener === 'function') {
        try { target.removeEventListener('error', handleGlobalError); } catch (_) {}
        try { target.removeEventListener('unhandledrejection', handleUnhandledRejection); } catch (_) {}
    }
    return true;
}

// =====================================================
// 主 API
// =====================================================
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

    /** 是否将日志持久化到 localStorage */
    setPersistEnabled(enabled) {
        _persistEnabled = !!enabled;
        if (_persistEnabled) persistNow();
    },

    /** 普通信息（debug 关闭时仅 console.log，不写缓冲） */
    info(...args) {
        console.log('%c' + PREFIX, STYLES.primary, ...args);
        if (_debugEnabled) pushEntry('info', args);
    },

    /** 成功提示 */
    success(...args) {
        console.log('%c' + PREFIX + ' ✓', STYLES.success, ...args);
        if (_debugEnabled) pushEntry('success', args);
    },

    /**
     * 调试信息
     * 性能关键：debug 关闭时（默认状态）整个调用直接 return —
     * 不调用 console.debug、不 formatArgs、不入缓冲。
     * 这意味着代码里铺满 logger.debug(...) 也几乎零开销。
     */
    debug(...args) {
        if (!_debugEnabled) return;
        console.debug('%c' + PREFIX, STYLES.debug, ...args);
        pushEntry('debug', args);
    },

    /** 警告（始终记录到缓冲区） */
    warn(...args) {
        console.warn('%c' + PREFIX, STYLES.warn, ...args);
        pushEntry('warn', args);
    },

    /** 错误（始终记录到缓冲区） */
    error(...args) {
        console.error('%c' + PREFIX, STYLES.error, ...args);
        pushEntry('error', args);
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

    // ---------------------------------------------
    // 缓冲区/查询 API（供日志面板使用）
    // ---------------------------------------------

    /**
     * 获取缓冲区中的日志条目
     * @param {object} [filter]
     * @param {string} [filter.level]   仅取指定级别
     * @param {string} [filter.minLevel] 仅取该级别及以上（按 LEVEL_ORDER）
     * @param {string} [filter.search]  关键字模糊匹配
     * @param {number} [filter.limit]   返回最近 N 条（默认全部）
     * @returns {Array<{seq,ts,level,message}>}
     */
    getLogs(filter = {}) {
        let arr = _buffer.slice();

        if (filter.level) {
            arr = arr.filter(e => e.level === filter.level);
        } else if (filter.minLevel) {
            const idx = LEVEL_ORDER.indexOf(filter.minLevel);
            if (idx >= 0) {
                arr = arr.filter(e => LEVEL_ORDER.indexOf(e.level) >= idx);
            }
        }

        if (filter.search) {
            const q = String(filter.search).toLowerCase();
            arr = arr.filter(e => (e.message || '').toLowerCase().includes(q));
        }

        if (Number.isFinite(filter.limit) && filter.limit > 0) {
            arr = arr.slice(-filter.limit);
        }

        return arr;
    },

    /** 缓冲区当前条数 */
    getLogCount() {
        return _buffer.length;
    },

    /** 清空缓冲区 */
    clearLogs() {
        _buffer.length = 0;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(PERSIST_KEY);
            }
        } catch (_) {}
        notifyListeners(null);
    },

    /**
     * 订阅日志事件
     * @param {(entry: {seq,ts,level,message}|null) => void} fn 收到新日志时调用；clearLogs 时收到 null
     * @returns {() => void} 取消订阅函数
     */
    subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        _listeners.add(fn);
        return () => _listeners.delete(fn);
    },

    /**
     * 导出为纯文本（每行一条）
     * @param {object} [filter] 见 getLogs
     */
    exportText(filter = {}) {
        const entries = this.getLogs(filter);
        const lines = entries.map(e => {
            const d = new Date(e.ts);
            const pad = n => String(n).padStart(2, '0');
            const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
            return `[${ts}] [${(e.level || '').toUpperCase().padEnd(7)}] ${e.message}`;
        });
        return lines.join('\n');
    },

    /**
     * 导出为 JSON 字符串
     * @param {object} [filter]
     */
    exportJSON(filter = {}) {
        const payload = {
            version: 1,
            exportedAt: Date.now(),
            count: this.getLogCount(),
            logs: this.getLogs(filter),
        };
        return JSON.stringify(payload, null, 2);
    },

    LEVELS: LOG_LEVEL,
    LEVEL_ORDER,
};
