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
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
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

/**
 * Escape a complete host-provided translation while retaining the project's
 * deliberately small rich-text contract: balanced, attribute-free <b> pairs.
 * Everything else remains literal text, including tags with attributes.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeTranslationHtml(value) {
    if (value === null || value === undefined) return '';

    const source = String(value);
    const tagPattern = /<\/?b>/gi;
    let result = '';
    let offset = 0;
    let emphasisOpen = false;
    let match;

    while ((match = tagPattern.exec(source)) !== null) {
        result += escapeHtml(source.slice(offset, match.index));
        const isClosing = match[0][1] === '/';
        if (!isClosing && !emphasisOpen) {
            result += '<strong>';
            emphasisOpen = true;
        } else if (isClosing && emphasisOpen) {
            result += '</strong>';
            emphasisOpen = false;
        } else {
            result += escapeHtml(match[0]);
        }
        offset = tagPattern.lastIndex;
    }

    result += escapeHtml(source.slice(offset));
    return emphasisOpen ? `${result}</strong>` : result;
}
