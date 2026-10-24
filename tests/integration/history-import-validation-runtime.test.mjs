import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from '../fixtures/runtime-host.mjs';

let writes = 0;
const host = installRuntimeHost({ storageSet: async () => { writes++; } });
const compatibility = await import('../../modules/compatibility.js');
compatibility.initCompatibility();
const settings = await import('../../modules/settings.js');
await settings.initSettings();
const history = await import('../../modules/history-store.js');

test('merge and replace validate every incoming record before any storage change', async () => {
    await history.initHistoryStore();
    try {
        const saved = await history.addSnapshot('Good', 'openai', { temperature: 0.8 }, history.TRIGGER.MANUAL);
        await history.togglePinSnapshot(saved.id, true);
        for (const mode of ['merge', 'replace']) {
            for (const invalid of [
                { preset: { not_a_preset: true } }, { pinned: 'false' },
                { preset: { temperature: {} } },
                { summary: { sections: [{ kind: 'field', items: false }] } },
            ]) {
                const before = structuredClone(host.stores);
                const writesBefore = writes;
                const payload = { version: 2, data: {
                    'openai::Incoming': [{ id: 'valid-first', timestamp: 2, preset: { temperature: 0.3 } }],
                    'openai::Broken': [{ id: 'invalid-last', timestamp: 3,
                        preset: { temperature: 0.4 }, ...invalid }],
                } };
                await assert.rejects(history.importAll(payload, mode), TypeError);
                assert.equal(writes, writesBefore, 'validation must precede even journal writes');
                assert.deepEqual(host.stores, before, 'all buckets, pins, markers and catalog remain unchanged');
            }
        }
    } finally {
        await history.teardownHistoryStore();
    }
});

test('serialized production exports with generated prompt summaries roundtrip through strict import', async () => {
    await history.initHistoryStore();
    try {
        const before = { temperature: 0.2, prompts: [{ identifier: 'main', name: 'Main', content: 'before' }],
            prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: false }] }] };
        await history.addSnapshot('Roundtrip', 'openai', before, history.TRIGGER.MANUAL);
        const after = structuredClone(before);
        after.prompts[0].content = 'after';
        after.prompts[0].injection_trigger = ['normal'];
        after.prompt_order[0].order[0].enabled = true;
        const saved = await history.addSnapshot('Roundtrip', 'openai', after, history.TRIGGER.MANUAL);
        await history.togglePinSnapshot(saved.id, true);
        const exported = JSON.parse(JSON.stringify(await history.exportAll()));
        await history.importAll(exported, 'replace');
        const records = await history.getSnapshots('openai', 'Roundtrip');
        assert.equal(records.length, 2);
        assert.equal(records[0].id, saved.id);
        assert.equal(records[0].pinned, true);
        assert.deepEqual(records[0].preset, after);
        assert.ok(records[0].summary.sections.some(section => section.kind === 'prompt-edit'));
        assert.ok(records[0].summary.sections.some(section => section.kind === 'prompt-toggle-on'));
    } finally {
        await history.teardownHistoryStore();
    }
});
