import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPerformanceScenario, buildVisualScenario } from './fixtures/visual-scenarios.mjs';

test('visual scenario covers nested groups, long names, pins and meaningful revisions', () => {
    const scenario = buildVisualScenario();
    assert.equal(scenario.records.length, 45);
    assert.equal(Object.keys(scenario.tree).length, 2);
    assert.ok(scenario.records.some(item => item.presetName.length > 60));
    assert.ok(scenario.records.some(item => item.pinned));
    assert.ok(scenario.records.some(item => item.trigger === 'switch_guard'));
    assert.ok(scenario.records.some(item => item.trigger === 'manual'));

    const firstPreset = scenario.records.filter(item => item.presetName === scenario.records[0].presetName);
    assert.equal(firstPreset.length, 5);
    assert.notDeepEqual(firstPreset[0].preset, firstPreset[1].preset);
    assert.ok(firstPreset[2].preset.prompts.some(item => item.identifier === 'review'));
    assert.equal(firstPreset[3].preset.prompt_order[0].order.find(item => item.identifier === 'jailbreak').enabled, false);
});

test('performance scenario creates 500 distinct, explainably changing snapshots', () => {
    const scenario = buildPerformanceScenario();
    assert.equal(scenario.records.length, 500);
    assert.equal(new Set(scenario.records.map(item => item.presetName)).size, 25);
    assert.equal(Object.keys(scenario.overrides).length, 25);
    assert.ok(scenario.records.every(item => item.apiId === 'openai'));
});
