const COMPACT_MAX_WIDTH = 460;
const MIN_TOUCH_TARGET = 44;
const OVERFLOW_TOLERANCE = 1;

function finding(code, severity, message, selector = '') {
    return Object.freeze({ code, severity, message, selector });
}

function finish(findings) {
    const frozenFindings = Object.freeze(findings);
    const summary = Object.freeze({
        errors: findings.filter(item => item.severity === 'error').length,
        warnings: findings.filter(item => item.severity === 'warning').length,
    });
    return Object.freeze({
        passed: summary.errors === 0,
        findings: frozenFindings,
        summary,
    });
}

export function evaluateLayoutAudit(metrics) {
    if (!metrics || typeof metrics !== 'object' || !metrics.viewport || typeof metrics.viewport !== 'object') {
        return finish([finding('invalid-metrics', 'error', 'Browser metrics are missing or malformed.')]);
    }

    const findings = [];
    const viewportWidth = Number(metrics.viewport.width);
    const documentWidth = Number(metrics.documentWidth);

    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(documentWidth)) {
        findings.push(finding('invalid-metrics', 'error', 'Viewport or document width is not a finite positive number.'));
    } else if (documentWidth - viewportWidth > OVERFLOW_TOLERANCE) {
        findings.push(finding(
            'horizontal-overflow',
            'error',
            `Document is ${Math.ceil(documentWidth - viewportWidth)}px wider than the viewport.`,
            'html',
        ));
    }

    if (Number.isFinite(viewportWidth) && viewportWidth <= COMPACT_MAX_WIDTH) {
        const reportedTouchTargets = new Set();
        for (const control of Array.isArray(metrics.controls) ? metrics.controls : []) {
            if (!control?.important || !control.visible) continue;
            const width = Number(control.width);
            const height = Number(control.height);
            if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_TOUCH_TARGET || height < MIN_TOUCH_TARGET) {
                const selector = String(control.selector || '');
                const signature = `${selector}|${width}|${height}`;
                if (reportedTouchTargets.has(signature)) continue;
                reportedTouchTargets.add(signature);
                findings.push(finding(
                    'touch-target',
                    'error',
                    `Important control measures ${width}x${height}px; compact layouts require at least 44x44px.`,
                    selector,
                ));
            }
        }
    }

    for (const label of Array.isArray(metrics.requiredLabels) ? metrics.requiredLabels : []) {
        if (!label?.visible) {
            findings.push(finding(
                'required-label-hidden',
                'error',
                `Required control label “${String(label?.text || '').trim()}” is not visible.`,
                String(label?.selector || ''),
            ));
        } else if (label?.fullyVisible === false) {
            findings.push(finding(
                'required-label-clipped',
                'error',
                `Required control label “${String(label?.text || '').trim()}” is clipped.`,
                String(label?.selector || ''),
            ));
        } else if (label?.singleLine === false) {
            findings.push(finding(
                'required-label-wrapped',
                'error',
                `Required control label “${String(label?.text || '').trim()}” wrapped or collapsed vertically.`,
                String(label?.selector || ''),
            ));
        }
    }

    for (const selector of Array.isArray(metrics.hiddenFocusable) ? metrics.hiddenFocusable : []) {
        findings.push(finding(
            'hidden-focusable',
            'error',
            'A focusable element remains active inside hidden content.',
            String(selector || ''),
        ));
    }

    for (const disclosure of Array.isArray(metrics.disclosures) ? metrics.disclosures : []) {
        if (typeof disclosure?.expanded !== 'boolean' || typeof disclosure?.bodyHidden !== 'boolean') continue;
        if (disclosure.expanded === !disclosure.bodyHidden) continue;
        findings.push(finding(
            'disclosure-state-mismatch',
            'error',
            'Disclosure aria-expanded contradicts the visibility of its controlled content.',
            String(disclosure.selector || ''),
        ));
    }

    if (metrics.footerText && typeof metrics.footerText === 'object') {
        const fontSize = Number(metrics.footerText.fontSize);
        const contrast = Number(metrics.footerText.contrast);
        if (!Number.isFinite(fontSize) || fontSize < 12) {
            findings.push(finding(
                'footer-text-size',
                'error',
                `Footer statistics use ${fontSize}px text; compact normal text requires at least 12px.`,
                '#pas-footer-stats',
            ));
        }
        if (!Number.isFinite(contrast) || contrast < 4.5) {
            findings.push(finding(
                'footer-text-contrast',
                'error',
                `Footer statistics contrast is ${contrast}:1; normal text requires at least 4.5:1.`,
                '#pas-footer-stats',
            ));
        }
    }

    const viewMode = metrics.viewMode;
    if (viewMode && viewMode.selected !== viewMode.rendered) {
        findings.push(finding(
            'view-mode-mismatch',
            'error',
            `Selected ${String(viewMode.selected)} view contradicts the rendered ${String(viewMode.rendered)} content.`,
            '.pas-view-switch',
        ));
    }
    if (viewMode && viewMode.manageGroupingAvailable !== (viewMode.selected === 'series')) {
        findings.push(finding(
            'view-tool-scope-mismatch',
            'error',
            'The grouping manager visibility contradicts the selected history view.',
            '.pas-btn-manage-grouping',
        ));
    }

    for (const message of Array.isArray(metrics.consoleErrors) ? metrics.consoleErrors : []) {
        findings.push(finding('console-error', 'error', String(message || 'Unknown browser console error.')));
    }

    const renderMs = Number(metrics.renderMs);
    if (!Number.isFinite(renderMs) || renderMs < 0) {
        findings.push(finding('invalid-render-timing', 'error', 'Render duration is not a finite non-negative number.'));
    } else if (renderMs > 1000) {
        findings.push(finding('slow-render', 'error', `Render took ${Math.round(renderMs)}ms, above the 1000ms hard limit.`));
    } else if (metrics.scenario !== 'performance' && renderMs > 250) {
        findings.push(finding('slow-render', 'warning', `Render took ${Math.round(renderMs)}ms, above the 250ms ordinary-data target.`));
    }

    return finish(findings);
}
