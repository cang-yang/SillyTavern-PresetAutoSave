const FOCUSABLE_SELECTOR = [
    'button', 'input', 'select', 'textarea', 'a[href]', '[tabindex]', '[role="button"]',
].join(',');
const CONTROL_KEY_ATTRIBUTES = [
    'data-id', 'data-preset-name', 'data-preset-key', 'data-series-key',
    'data-filter', 'data-view', 'data-level',
];

function sameValue(left, right, key) {
    return left?.[key] !== undefined && left?.[key] !== null && left[key] === right?.[key];
}

function candidateScore(anchor, candidate) {
    let score = 0;
    if (sameValue(anchor, candidate, 'id')) score += 1200;
    if (sameValue(anchor, candidate, 'controlKey')) score += 700;
    if (sameValue(anchor, candidate, 'action')) score += 80;

    if (anchor.snapshotId) {
        score += candidate.snapshotId === anchor.snapshotId ? 600 : candidate.snapshotId ? -1000 : 0;
    }
    if (sameValue(anchor, candidate, 'versionKey')) score += 300;
    if (sameValue(anchor, candidate, 'presetKey')) score += 300;
    if (sameValue(anchor, candidate, 'seriesKey')) score += 100;

    if (candidate.action === 'toggle-version' && sameValue(anchor, candidate, 'versionKey')) score += 250;
    if (candidate.action === 'toggle-group' && sameValue(anchor, candidate, 'presetKey')) score += 250;
    if (candidate.action === 'toggle-series' && sameValue(anchor, candidate, 'seriesKey')) score += 100;
    return score;
}

export function chooseFocusCandidate(anchor, candidates) {
    if (!anchor || !Array.isArray(candidates) || candidates.length === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
        const score = candidateScore(anchor, candidate);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

function attribute(element, name) {
    const value = element?.getAttribute?.(name);
    return typeof value === 'string' && value !== '' ? value : null;
}

function contextAttribute(element, name) {
    return attribute(element?.closest?.(`[${name}]`), name);
}

function controlKey(element) {
    for (const name of CONTROL_KEY_ATTRIBUTES) {
        const value = attribute(element, name);
        if (value !== null) return `${name}:${value}`;
    }
    return null;
}

function describeElement(element) {
    if (!element) return null;
    return {
        id: typeof element.id === 'string' && element.id !== '' ? element.id : null,
        controlKey: controlKey(element),
        action: attribute(element, 'data-action'),
        snapshotId: contextAttribute(element, 'data-snapshot-id'),
        versionKey: contextAttribute(element, 'data-version-key'),
        presetKey: contextAttribute(element, 'data-preset-key'),
        seriesKey: contextAttribute(element, 'data-series-key'),
    };
}

export function captureFocusAnchor(root, activeElement = root?.ownerDocument?.activeElement) {
    if (!root || !activeElement || !root.contains?.(activeElement)) return null;
    const focusable = activeElement.matches?.(FOCUSABLE_SELECTOR)
        ? activeElement
        : activeElement.closest?.(FOCUSABLE_SELECTOR);
    return focusable && root.contains(focusable) ? describeElement(focusable) : null;
}

function focusWithoutScroll(element) {
    if (!element?.focus) return false;
    try {
        element.focus({ preventScroll: true });
    } catch (_) {
        element.focus();
    }
    return true;
}

export function restoreFocusAnchor(root, anchor, fallback = null) {
    if (!root || !anchor) return false;
    const candidates = [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => !element.disabled && !element.closest?.('[hidden], [aria-hidden="true"]'))
        .map(element => ({ ...describeElement(element), element }));
    const target = chooseFocusCandidate(anchor, candidates);
    return focusWithoutScroll(target?.element) || focusWithoutScroll(fallback);
}
