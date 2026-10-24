import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateLayoutAudit } from './harness/layout-audit.mjs';

const metrics = controls => ({
    viewport: { width: 360, height: 800 }, documentWidth: 360,
    controls: [], settingsControls: controls, consoleErrors: [],
});
const control = overrides => ({
    selector: '#pas-setting-enabled', visible: true, name: 'Enable auto save',
    requiresDescription: true, description: 'Master switch', width: 0, height: 0,
    targets: [{ width: 38, height: 20 }, { width: 78, height: 16.67 }],
    ...overrides,
});

test('settings audit rejects a zero-size checkbox whose associated labels are too small', () => {
    const result = evaluateLayoutAudit(metrics([control()]));
    assert.ok(result.findings.some(item => item.code === 'settings-touch-target'));
});

test('settings audit accepts a full target but requires named described settings fields', () => {
    const large = control({ targets: [{ width: 44, height: 44 }] });
    assert.ok(!evaluateLayoutAudit(metrics([large])).findings.some(item => item.code.startsWith('settings-')));
    for (const invalid of [{ name: '' }, { description: '' }]) {
        assert.ok(evaluateLayoutAudit(metrics([{ ...large, ...invalid }])).findings.some(item => item.code === 'settings-control-label'));
    }
});

test('settings audit does not combine dimensions from different clickable labels', () => {
    const result = evaluateLayoutAudit(metrics([control({
        targets: [{ width: 44, height: 20 }, { width: 38, height: 44 }],
    })]));
    assert.ok(result.findings.some(item => item.code === 'settings-touch-target'));
});

test('settings targets use a dedicated scoped layer without enlarging the visual track', () => {
    const url = new URL('../styles/settings.css', import.meta.url);
    assert.ok(existsSync(url), 'settings feature layer must exist');
    const css = readFileSync(url, 'utf8');
    assert.match(css, /\.pas-settings \.pas-switch[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
    assert.match(css, /\.pas-settings \.pas-switch-slider[\s\S]*?inset: 12px 3px;/);
    assert.match(readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8'), /@import url\('\.\/settings\.css'\)/);
});
