// modules/time-utils.js
// 时间格式化工具——从 compatibility.js 提取
// 所有 12 个外部模块的导入语句完全不动，compatibility.js 会 re-export

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss
 * @param {number} ts  Unix 毫秒时间戳
 * @returns {string}
 */
export function formatTime(ts) {
    if (!ts) return '\u2014';
    try {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) {
        return String(ts);
    }
}
