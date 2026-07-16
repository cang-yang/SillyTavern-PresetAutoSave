const COMPACT_MAX_WIDTH = 460;
const MIN_TOUCH_TARGET = 44;
const OVERFLOW_TOLERANCE = 1;
const MAX_COMPACT_HISTORY_TOP = 190;
const MAX_COMPACT_VERSION_HEADER = 54;
const MAX_COMPACT_SNAPSHOT_ACTIONS = 44;
const MAX_COMPACT_CONTROL_FACE = 32;
const MIN_COMPACT_VERSION_RADIUS = 8;
const MAX_WARMED_VIEW_SWITCH_MS = 20;
const MAX_COMPACT_SHELL_MS = 100;
const MAX_WARM_CATALOG_MS = 300;
const MAX_COLD_CATALOG_MS = 800;
const MAX_ORDINARY_LONG_TASK_MS = 50;

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
        } else if (label?.fullyVisible === false && label?.scrollAccessible !== true) {
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

    for (const series of Array.isArray(metrics.expandedSeriesContent) ? metrics.expandedSeriesContent : []) {
        const declaredVersions = Number(series?.declaredVersions);
        const renderedVersions = Number(series?.renderedVersions);
        const renderedChildren = Number(series?.renderedChildren);
        if (declaredVersions <= 0 || renderedVersions > 0 || renderedChildren > 0) continue;
        findings.push(finding(
            'expanded-series-empty',
            'error',
            `Expanded series declares ${declaredVersions} versions but renders no preset rows.`,
            String(series?.selector || ''),
        ));
    }

    if (Number.isFinite(viewportWidth) && viewportWidth <= COMPACT_MAX_WIDTH) {
        const historyFilterRows = Number(metrics.historyFilterRows);
        if (Number.isFinite(historyFilterRows) && historyFilterRows > 1) {
            findings.push(finding(
                'compact-filter-wrap',
                'error',
                `History filters occupy ${historyFilterRows} rows; compact layouts require one scrollable row.`,
                '#pas-panel-list > .pas-toolbar > .pas-filters',
            ));
        }

        const historyListTop = Number(metrics.historyListTop);
        if (Number.isFinite(historyListTop) && historyListTop > MAX_COMPACT_HISTORY_TOP) {
            findings.push(finding(
                'compact-chrome-too-tall',
                'error',
                `History content starts at ${Math.round(historyListTop)}px; compact workspace chrome must end by ${MAX_COMPACT_HISTORY_TOP}px.`,
                '.pas-snapshot-list',
            ));
        }

        const versionHeaderHeight = Number(metrics.versionHeaderHeight);
        if (Number.isFinite(versionHeaderHeight) && versionHeaderHeight > MAX_COMPACT_VERSION_HEADER) {
            findings.push(finding(
                'compact-version-header-too-tall',
                'error',
                `Version header is ${Math.round(versionHeaderHeight)}px high; compact rows must stay within ${MAX_COMPACT_VERSION_HEADER}px.`,
                '.pas-version-header',
            ));
        }

        const snapshotActionHeight = Number(metrics.snapshotActionHeight);
        if (Number.isFinite(snapshotActionHeight) && snapshotActionHeight > MAX_COMPACT_SNAPSHOT_ACTIONS) {
            findings.push(finding(
                'compact-snapshot-actions-too-tall',
                'error',
                `Snapshot actions are ${Math.round(snapshotActionHeight)}px high before secondary tools are expanded; the compact budget is ${MAX_COMPACT_SNAPSHOT_ACTIONS}px.`,
                '.pas-card-actions',
            ));
        }

        for (const face of Array.isArray(metrics.controlFaces) ? metrics.controlFaces : []) {
            if (!face?.visible) continue;
            const height = Number(face.height);
            if (!Number.isFinite(height) || height <= MAX_COMPACT_CONTROL_FACE) continue;
            findings.push(finding(
                'compact-control-face-too-tall',
                'error',
                `Control face is ${Math.round(height)}px high; compact visual faces must stay within ${MAX_COMPACT_CONTROL_FACE}px while the touch target remains 44px.`,
                String(face.selector || ''),
            ));
        }

        for (const frame of Array.isArray(metrics.versionFrames) ? metrics.versionFrames : []) {
            if (!frame?.visible) continue;
            const borders = Array.isArray(frame.borders) ? frame.borders.map(Number) : [];
            const radius = Number(frame.radius);
            if (borders.length === 4 && borders.every(width => Number.isFinite(width) && width >= 1)
                && Number.isFinite(radius) && radius >= MIN_COMPACT_VERSION_RADIUS) continue;
            findings.push(finding(
                'compact-version-frame-incomplete',
                'error',
                'A compact version entry is missing a complete border or rounded corner and appears cut open.',
                String(frame.selector || ''),
            ));
        }
    }

    const viewSwitchMs = Number(metrics.viewSwitchMs);
    if (Number.isFinite(viewSwitchMs) && viewSwitchMs > MAX_WARMED_VIEW_SWITCH_MS) {
        findings.push(finding(
            'slow-view-switch',
            'error',
            `Warmed history view switch took ${Math.round(viewSwitchMs)}ms; the interaction-frame budget is ${MAX_WARMED_VIEW_SWITCH_MS}ms.`,
            '.pas-view-toggle',
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
    if (metrics.scenario === 'performance') {
        const perf = metrics.performance;
        if (!perf || typeof perf !== 'object') {
            findings.push(finding(
                'invalid-performance-metrics',
                'error',
                'Performance scenario is missing required storage and timing instrumentation.',
            ));
        } else {
            const shellMs = Number(perf.shellMs);
            if (Number.isFinite(viewportWidth) && viewportWidth <= COMPACT_MAX_WIDTH
                && (!Number.isFinite(shellMs) || shellMs > MAX_COMPACT_SHELL_MS)) {
                findings.push(finding(
                    'slow-shell',
                    'error',
                    `Compact shell paint took ${Math.round(shellMs)}ms; the budget is ${MAX_COMPACT_SHELL_MS}ms.`,
                ));
            }

            const payloadReads = Number(perf.payloadReads);
            if (perf.catalogMode === 'warm' && (!Number.isFinite(payloadReads) || payloadReads !== 0)) {
                findings.push(finding(
                    'ready-catalog-payload-read',
                    'error',
                    `Warm catalog open performed ${payloadReads} authoritative payload reads; the budget is zero.`,
                ));
            }

            const payloadWrites = Number(perf.payloadWrites);
            const archivePayloadReads = Number(perf.archivePayloadReads);
            if (!Number.isFinite(archivePayloadReads) || archivePayloadReads !== 0) {
                findings.push(finding(
                    'archive-payload-read',
                    'error',
                    `Panel open performed ${archivePayloadReads} complete archive payload reads; the budget is zero.`,
                ));
            }

            if (!Number.isFinite(payloadWrites) || payloadWrites !== 0) {
                findings.push(finding(
                    'panel-open-write',
                    'error',
                    `Panel open performed ${payloadWrites} authoritative payload writes; the budget is zero.`,
                ));
            }

            const longestTask = Math.max(
                0,
                ...(Array.isArray(perf.longTasks) ? perf.longTasks : []).map(entry => Number(entry?.duration) || 0),
            );
            if (longestTask > MAX_ORDINARY_LONG_TASK_MS) {
                findings.push(finding(
                    'panel-open-long-task',
                    'warning',
                    `Panel open produced a ${Math.round(longestTask)}ms long task; investigate work above ${MAX_ORDINARY_LONG_TASK_MS}ms.`,
                ));
            }

            if (Number.isFinite(renderMs) && perf.catalogMode === 'warm' && renderMs > MAX_WARM_CATALOG_MS) {
                findings.push(finding(
                    'slow-warm-catalog',
                    'error',
                    `Warm catalog open took ${Math.round(renderMs)}ms; the target is ${MAX_WARM_CATALOG_MS}ms.`,
                ));
            }
            if (Number.isFinite(renderMs) && perf.catalogMode === 'cold' && renderMs > MAX_COLD_CATALOG_MS) {
                findings.push(finding(
                    'slow-cold-catalog',
                    'error',
                    `Cold catalog open took ${Math.round(renderMs)}ms; the target is ${MAX_COLD_CATALOG_MS}ms.`,
                ));
            }
        }
    }

    if (!Number.isFinite(renderMs) || renderMs < 0) {
        findings.push(finding('invalid-render-timing', 'error', 'Render duration is not a finite non-negative number.'));
    } else if (renderMs > 1000) {
        findings.push(finding('slow-render', 'error', `Render took ${Math.round(renderMs)}ms, above the 1000ms hard limit.`));
    } else if (metrics.scenario !== 'performance' && renderMs > 250) {
        findings.push(finding('slow-render', 'warning', `Render took ${Math.round(renderMs)}ms, above the 250ms ordinary-data target.`));
    }

    return finish(findings);
}
