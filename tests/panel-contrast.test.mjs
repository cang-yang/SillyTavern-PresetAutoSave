import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const panelCss = await readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8');

function hexToRgb(hex) {
    const value = hex.replace('#', '');
    assert.match(value, /^[0-9a-f]{6}$/i, `expected a six-digit hex color, received ${hex}`);
    return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function luminance(hex) {
    const channels = hexToRgb(hex).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

function lightThemeToken(name) {
    const block = panelCss.match(/body\.pas-light \.pas-panel\s*\{(?<declarations>[\s\S]*?)\n\}/)?.groups?.declarations ?? '';
    const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
    assert.ok(value, `light theme must define ${name} as a six-digit hex color`);
    return value;
}

function darkThemeToken(name) {
    const block = panelCss.match(/\.pas-panel\s*\{(?<declarations>[\s\S]*?)\n\}/)?.groups?.declarations ?? '';
    const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
    assert.ok(value, `dark theme must define ${name} as a six-digit hex color`);
    return value;
}

test('light theme active controls retain WCAG AA text contrast', () => {
    const foreground = lightThemeToken('--pas-v4-accent-readable');
    const surface = lightThemeToken('--pas-v4-surface-raised');

    assert.ok(contrastRatio(foreground, surface) >= 4.5);
    assert.match(panelCss, /\.pas-tab-active\s*\{[^}]*color:\s*var\(--pas-v4-accent-readable\)/s);
    assert.match(panelCss, /\.pas-filter-active\s*\{[^}]*color:\s*var\(--pas-v4-accent-readable\)/s);
});

test('light theme primary action keeps white text readable across its gradient', () => {
    const white = '#ffffff';
    const start = lightThemeToken('--pas-v4-primary-start');
    const end = lightThemeToken('--pas-v4-primary-end');

    assert.ok(contrastRatio(white, start) >= 4.5);
    assert.ok(contrastRatio(white, end) >= 4.5);
    assert.match(panelCss, /\.pas-primary-action\s*\{[^}]*linear-gradient\(135deg,\s*var\(--pas-v4-primary-start\),\s*var\(--pas-v4-primary-end\)\)/s);
});

test('empty, loading and recovery text use readable semantic colors in both themes', () => {
    assert.ok(contrastRatio(lightThemeToken('--pas-v4-text-muted'), lightThemeToken('--pas-v4-bg')) >= 4.5);
    assert.ok(contrastRatio(darkThemeToken('--pas-v4-text-muted'), darkThemeToken('--pas-v4-bg')) >= 4.5);
    assert.ok(contrastRatio(lightThemeToken('--pas-v4-danger'), lightThemeToken('--pas-v4-bg')) >= 4.5);
    assert.ok(contrastRatio(darkThemeToken('--pas-v4-danger'), darkThemeToken('--pas-v4-bg')) >= 4.5);
    assert.match(panelCss, /\.pas-panel \.pas-empty\s*\{[^}]*color:\s*var\(--pas-v4-text-muted\)/s);
    assert.match(panelCss, /\.pas-panel \.pas-panel-error \.pas-empty-text\s*\{[^}]*color:\s*var\(--pas-v4-danger\)/s);
    assert.match(panelCss, /\.pas-panel \.pas-panel-error \.pas-empty-hint\s*\{[^}]*opacity:\s*1/s);
});
