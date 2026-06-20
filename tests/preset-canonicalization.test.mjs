import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePresetForExport } from '../modules/compatibility.js';
import { formatSummaryValue } from '../modules/panel-summary.js';

test('canonical preset excludes the separate logit-bias preset library', () => {
    const canonical = sanitizePresetForExport({
        temperature: 0.8,
        bias_presets: { Default: [{ text: 'foo', value: -10 }] },
        bias_preset_selected: 'Default',
    });
    assert.deepEqual(canonical, { temperature: 0.8 });
});

test('summary values never expose JavaScript object coercion text', () => {
    assert.equal(formatSummaryValue({ enabled: true }), '对象（1 项）');
    assert.equal(formatSummaryValue(['a', 'b']), '列表（2 项）');
    assert.doesNotMatch(formatSummaryValue({ enabled: true }), /\[object Object\]/);
});
