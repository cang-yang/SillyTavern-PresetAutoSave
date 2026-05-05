// modules/key-utils.js
// 字符串工具（HTML转义等）——从 compatibility.js 提取
// 所有 12 个外部模块的导入语句完全不动，compatibility.js 会 re-export

/**
 * HTML 转义 — 防止 XSS，适用于标签内文本与属性值
 * @param {*} s
 * @returns {string}
 */
export function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#039;');
}

/**
 * HTML 属性转义 — 当前实现等价于 escapeHtml，语义别名便于模板中区分用途
 * @param {*} s
 * @returns {string}
 */
export function escapeAttr(s) {
    return escapeHtml(s);
}
