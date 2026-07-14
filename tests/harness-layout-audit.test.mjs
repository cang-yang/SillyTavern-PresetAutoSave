import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLayoutAudit } from './harness/layout-audit.mjs';

function cleanMetrics(overrides = {}) {
    return {
        scenario: 'ordinary',
        viewport: { width: 1280, height: 900 },
        documentWidth: 1280,
        controls: [{ selector: '.pas-btn-snap', important: true, visible: true, width: 112, height: 44 }],
        disclosures: [],
        viewMode: { selected: 'series', rendered: 'series', manageGroupingAvailable: true },
        hiddenFocusable: [],
        consoleErrors: [],
        renderMs: 80,
        ...overrides,
    };
}

test('clean desktop metrics pass without findings', () => {
    const result = evaluateLayoutAudit(cleanMetrics());
    assert.equal(result.passed, true);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.summary, { errors: 0, warnings: 0 });
    assert.equal(Object.isFrozen(result.findings), true);
});

test('horizontal overflow and hidden focus targets are release errors', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        documentWidth: 1304,
        hiddenFocusable: ['#pas-panel-settings button'],
    }));

    assert.equal(result.passed, false);
    assert.deepEqual(result.findings.map(item => item.code), ['horizontal-overflow', 'hidden-focusable']);
    assert.ok(result.findings.every(item => item.severity === 'error'));
});

test('compact layouts reject visible important controls below 44 by 44 pixels', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 390, height: 844 },
        documentWidth: 390,
        controls: [
            { selector: '.pas-btn-snap', important: true, visible: true, width: 43.5, height: 44 },
            { selector: '.pas-hidden-action', important: true, visible: false, width: 20, height: 20 },
            { selector: '.pas-secondary', important: false, visible: true, width: 24, height: 24 },
        ],
    }));

    assert.equal(result.passed, false);
    assert.deepEqual(result.findings.map(item => item.code), ['touch-target']);
    assert.equal(result.findings[0].selector, '.pas-btn-snap');
});

test('repeated controls produce one actionable touch-target finding per shape', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 390, height: 844 },
        documentWidth: 390,
        controls: [
            { selector: '.pas-btn-restore', important: true, visible: true, width: 28, height: 28 },
            { selector: '.pas-btn-restore', important: true, visible: true, width: 28, height: 28 },
            { selector: '.pas-btn-restore', important: true, visible: true, width: 28, height: 28 },
        ],
    }));

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].selector, '.pas-btn-restore');
});

test('required control labels must remain visible at supported viewports', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        requiredLabels: [
            { selector: '#pas-tab-list > span', text: '记录', visible: false },
            { selector: '#pas-tab-logs > span', text: '日志', visible: true },
        ],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].code, 'required-label-hidden');
    assert.equal(result.findings[0].selector, '#pas-tab-list > span');
});

test('required control labels must be fully visible instead of clipped by a scroll strip', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 360, height: 800 },
        documentWidth: 360,
        requiredLabels: [
            { selector: '.pas-filter[data-filter="week"] > span', text: '本周', visible: true, fullyVisible: false },
        ],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'required-label-clipped');
});

test('offscreen filter labels remain valid when their strip is intentionally scrollable', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 360, height: 800 },
        documentWidth: 360,
        requiredLabels: [
            {
                selector: '.pas-filter[data-filter="week"] > span',
                text: '本周',
                visible: true,
                fullyVisible: false,
                scrollAccessible: true,
                singleLine: true,
            },
        ],
    }));

    assert.equal(result.passed, true);
});

test('compact footer statistics must meet normal-text size and contrast', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 360, height: 800 },
        documentWidth: 360,
        footerText: { fontSize: 8.2, contrast: 2.35 },
    }));

    assert.equal(result.passed, false);
    assert.deepEqual(result.findings.map(item => item.code), ['footer-text-size', 'footer-text-contrast']);
});

test('compact action labels cannot collapse into wrapped or vertical text', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 360, height: 800 },
        documentWidth: 360,
        requiredLabels: [
            { selector: '.pas-btn-clear-preset > .pas-action-label', text: '清空该预设', visible: true, fullyVisible: true, singleLine: false },
        ],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'required-label-wrapped');
});

test('visible disclosure state must agree with aria-expanded', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        disclosures: [
            { selector: '.pas-series-header', expanded: false, bodyHidden: false },
            { selector: '.pas-version-header', expanded: true, bodyHidden: false },
        ],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].code, 'disclosure-state-mismatch');
    assert.equal(result.findings[0].selector, '.pas-series-header');
});

test('expanded series with a declared version count cannot expose an empty body', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        expandedSeriesContent: [
            { selector: '[data-series-key="unused"]', declaredVersions: 2, renderedVersions: 0, renderedChildren: 0 },
        ],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'expanded-series-empty');
});

test('compact history filters remain one row instead of consuming the record viewport', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 390, height: 844 },
        documentWidth: 390,
        historyFilterRows: 2,
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'compact-filter-wrap');
});

test('compact history chrome and expanded actions stay within density budgets', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        viewport: { width: 390, height: 844 },
        documentWidth: 390,
        historyListTop: 224,
        versionHeaderHeight: 67.9,
        snapshotActionHeight: 75,
    }));

    assert.equal(result.passed, false);
    assert.deepEqual(result.findings.map(item => item.code), [
        'compact-chrome-too-tall',
        'compact-version-header-too-tall',
        'compact-snapshot-actions-too-tall',
    ]);
});

test('warmed 500-snapshot view switches stay within one interaction frame', () => {
    const result = evaluateLayoutAudit(cleanMetrics({
        scenario: 'performance',
        viewSwitchMs: 32.8,
    }));

    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'slow-view-switch');
});

test('view controls, renderer, and grouping tools must describe the same mode', () => {
    const wrongSelection = evaluateLayoutAudit(cleanMetrics({
        viewMode: { selected: 'series', rendered: 'flat', manageGroupingAvailable: true },
    }));
    assert.equal(wrongSelection.passed, false);
    assert.equal(wrongSelection.findings[0].code, 'view-mode-mismatch');

    const wrongTool = evaluateLayoutAudit(cleanMetrics({
        viewMode: { selected: 'flat', rendered: 'flat', manageGroupingAvailable: true },
    }));
    assert.equal(wrongTool.passed, false);
    assert.equal(wrongTool.findings[0].code, 'view-tool-scope-mismatch');
});

test('console errors and invalid timing fail while slow finite timing is reported', () => {
    const consoleFailure = evaluateLayoutAudit(cleanMetrics({ consoleErrors: ['Unhandled rejection'] }));
    assert.equal(consoleFailure.passed, false);
    assert.equal(consoleFailure.findings[0].code, 'console-error');

    const invalidTiming = evaluateLayoutAudit(cleanMetrics({ renderMs: Number.NaN }));
    assert.equal(invalidTiming.passed, false);
    assert.equal(invalidTiming.findings[0].code, 'invalid-render-timing');

    const slowOrdinary = evaluateLayoutAudit(cleanMetrics({ renderMs: 300 }));
    assert.equal(slowOrdinary.passed, true);
    assert.equal(slowOrdinary.findings[0].severity, 'warning');
    assert.equal(slowOrdinary.findings[0].code, 'slow-render');

    const verySlow = evaluateLayoutAudit(cleanMetrics({ scenario: 'performance', renderMs: 1001 }));
    assert.equal(verySlow.passed, false);
    assert.equal(verySlow.findings[0].severity, 'error');
});

test('malformed metrics fail closed with a stable audit finding', () => {
    const result = evaluateLayoutAudit(null);
    assert.equal(result.passed, false);
    assert.equal(result.findings[0].code, 'invalid-metrics');
});
