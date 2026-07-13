/**
 * SillyTavern Preset Auto Save - Theme Detector
 * 
 * SillyTavern 通过动态修改 :root 上的 --SmartTheme* CSS 变量来切换主题，
 * 不使用 body.light / [data-theme] 等选择器。
 * 
 * 本模块监测 --SmartThemeBodyColor 的相对亮度，
 * 当检测到"亮色文字"（亮度 < 0.4）时在 body 上切换 .pas-light class，
 * 供 style.css 中的亮色主题覆盖规则生效。
 * 
 * 原理：亮色主题 → 背景浅色 → 文字深色（SmartThemeBodyColor 亮度低）
 *       暗色主题 → 背景深色 → 文字浅色（SmartThemeBodyColor 亮度高）
 */

import { logger } from './logger.js';

const LIGHT_CLASS = 'pas-light';
const CHECK_INTERVAL = 2000;  // 每 2 秒检测一次
const LUMINANCE_THRESHOLD = 0.4; // 低于此值视为"深色文字" → 亮色主题

let _intervalId = null;
let _observer = null;
let _isLight = false;

/**
 * 解析 CSS 颜色字符串为 [r, g, b]（0-255）
 * 支持 rgb(...) / rgba(...) / #hex 格式
 */
function parseColor(colorStr) {
    if (!colorStr) return null;
    colorStr = colorStr.trim();

    // rgb(r, g, b) or rgba(r, g, b, a)
    const rgbMatch = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    }

    // #hex
    const hexMatch = colorStr.match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
        ];
    }

    return null;
}

/**
 * 计算相对亮度 (0 = 纯黑, 1 = 纯白)
 * 使用 sRGB 亮度公式: Y = 0.2126*R + 0.7152*G + 0.0722*B
 */
function relativeLuminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * 检测当前主题亮度并切换 class
 */
function detectAndApply() {
    const bodyColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--SmartThemeBodyColor')
        .trim();

    if (!bodyColor) return;

    const rgb = parseColor(bodyColor);
    if (!rgb) return;

    const lum = relativeLuminance(...rgb);
    const isLight = lum < LUMINANCE_THRESHOLD;

    if (isLight !== _isLight) {
        _isLight = isLight;
        document.body.classList.toggle(LIGHT_CLASS, isLight);
        logger.debug(`Theme detector: bodyColor="${bodyColor}" lum=${lum.toFixed(3)} → ${isLight ? 'LIGHT' : 'DARK'}`);
    }
}

/**
 * 初始化主题检测器
 * - 立即检测一次
 * - 设置定时轮询（因 ST 用 JS 改 style property，MutationObserver 对 CSS 变量不可靠）
 * - 监听 style 属性变化作为辅助
 */
export function initThemeDetector() {
    if (_intervalId !== null || _observer !== null) {
        detectAndApply();
        return;
    }

    // 立即检测
    detectAndApply();

    // 定时轮询
    _intervalId = setInterval(detectAndApply, CHECK_INTERVAL);

    // MutationObserver 辅助：监听 documentElement 的 style 属性变化
    try {
        _observer = new MutationObserver(() => detectAndApply());
        _observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['style'],
        });
    } catch (e) {
        logger.debug('Theme detector: MutationObserver not available, using polling only');
    }

    logger.debug('Theme detector initialized');
}

/**
 * 清理
 */
export function teardownThemeDetector() {
    if (_intervalId !== null) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
    if (_observer) {
        _observer.disconnect();
        _observer = null;
    }
    document.body.classList.remove(LIGHT_CLASS);
    _isLight = false;
}
