export function parseComputedColor(value) {
    const text = String(value || '').trim();
    const channels = text.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) return null;
    if (/^rgba?\(/.test(text)) return [...channels.slice(0, 3), channels[3] ?? 1];
    if (/^color\(srgb /.test(text)) return [...channels.slice(0, 3).map(channel => channel * 255), channels[3] ?? 1];
    return null;
}

function over(foreground, background) {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (!alpha) return [0, 0, 0, 0];
    return [
        ...foreground.slice(0, 3).map((channel, index) => (
            (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha
        )),
        alpha,
    ];
}

function luminance(channels) {
    const linear = channels.slice(0, 3).map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}

/** Layers run from the text element outward; CSS opacity applies to each subtree. */
export function compositeTextContrast(foreground, layers) {
    let text = parseComputedColor(foreground);
    let background = [0, 0, 0, 0];
    if (!text) return Number.NaN;
    for (const layer of layers) {
        const color = parseComputedColor(layer.backgroundColor);
        const opacity = Number(layer.opacity ?? 1);
        if (!color || !Number.isFinite(opacity)) return Number.NaN;
        if (layer.backgroundImage && layer.backgroundImage !== 'none' && background[3] < 1) return Number.NaN;
        text = over(text, color);
        background = over(background, color);
        text[3] *= opacity;
        background[3] *= opacity;
    }
    const canvas = [255, 255, 255, 1];
    const a = luminance(over(text, canvas));
    const b = luminance(over(background, canvas));
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export function collectTextContrast(element, styleOf = getComputedStyle) {
    const style = styleOf(element);
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
        const current = styleOf(node);
        layers.push({
            backgroundColor: current.backgroundColor,
            backgroundImage: current.backgroundImage,
            opacity: current.opacity,
        });
    }
    return {
        fontSize: Number.parseFloat(style.fontSize),
        contrast: compositeTextContrast(style.color, layers),
    };
}
