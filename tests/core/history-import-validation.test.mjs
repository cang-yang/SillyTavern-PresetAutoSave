import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHistoryBackup, createHistoryBackup, buildHistoryImportPlan, applyHistoryImportPlan } from '../../modules/core/history-backup.js';
import { HistoryRepository } from '../../modules/core/history-repository.js';

const record = extra => ({ id: 'incoming', timestamp: 2, preset: { temperature: 0.8 }, ...extra });
const payload = extra => ({ version: 2, data: { 'openai::Broken': [record(extra)] } });

test('strict import validates before cloning and never executes snapshot accessors', () => {
    let calls = 0;
    const input = record({});
    Object.defineProperty(input, 'customMetadata', {
        enumerable: true, get() { calls++; return 'evaluated'; },
    });
    assert.throws(() => validateHistoryBackup({ data: { 'openai::Broken': [input] } }), TypeError);
    assert.equal(calls, 0);
});

test('strict import rejects sparse arrays and array metadata before normalization loses them', () => {
    for (const value of [Array(1), Object.assign([1], { note: 'owned' })]) {
        assert.throws(() => validateHistoryBackup(payload({ preset: { extensions: { plugin: value } } })), TypeError);
    }
});

test('external imports reject empty canonical payloads before enrichment', () => {
    for (const preset of [{}, { not_a_preset: true }, { api_key_openai: 'synthetic' }]) {
        assert.throws(() => validateHistoryBackup(payload({ preset })), /canonical/i);
    }
});

test('external imports reject recognized preset values with non-restorable shapes', () => {
    for (const preset of [
        { temperature: {} }, { temperature: 'invalid' }, { stream_openai: [] },
        { send_if_empty: 42 }, { prompts: 'x' }, { prompts: [null] },
        { prompts: [{ identifier: 'main', content: {} }] },
        { prompt_order: {} }, { prompt_order: [{ character_id: 1, order: 'x' }] },
        { prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: 'false' }] }] },
        { extensions: [] },
    ]) assert.throws(() => validateHistoryBackup(payload({ preset })), TypeError);
});

test('external imports reject malformed consumed metadata instead of coercing it', () => {
    const malformed = [
        { pinned: 'false' }, { name: 3 }, { hash: {} }, { canonicalHash: false },
        { size: -1 }, { size: '10' }, { trigger: [] }, { transactionId: 1 },
        { parentSnapshotId: false }, { schemaVersion: 99 }, { contractVersion: -1 },
        { cause: 'auto' }, { cause: { trigger: false } }, { saveStatus: null },
        { summary: [] }, { summary: { isFirst: 'false' } },
        { summary: { sections: {} } }, { summary: { sections: [{ kind: 'field', items: 'bad' }] } },
        { summary: { sections: [{ kind: 'prompt-edit', items: [{ fields: {} }] }] } },
        { summary: { tags: [null] } }, { summary: { details: {} } },
        { summary: { rawChangedPaths: [1] } }, { summary: { counts: { fieldChanged: -1 } } },
        { changeSet: [] }, { changeSet: { changedPaths: [false] } },
        { changeSet: { meaningful: 'true' } }, { changeSet: { counts: { added: '1' } } },
        { customMetadata: new Date() },
    ];
    for (const extra of malformed) {
        assert.throws(() => validateHistoryBackup(payload(extra)), TypeError, JSON.stringify(extra));
    }
});

test('valid old omissions, stale hashes, explicit partial status and JSON metadata are retained', () => {
    const incoming = record({ hash: 'old-stale-hash', saveStatus: 'partial', customMetadata: { owner: 'user' } });
    const result = validateHistoryBackup({ version: 1, data: { 'openai::Broken': [incoming] } });
    const restored = result.data.get('openai::Broken')[0];
    assert.equal(restored.hash, incoming.hash);
    assert.equal(restored.saveStatus, 'partial');
    assert.deepEqual(restored.customMetadata, incoming.customMetadata);
    assert.equal(Object.hasOwn(restored, 'pinned'), false);
    assert.equal(Object.hasOwn(restored, 'name'), false);
});

test('official preset shapes and legacy summaries remain importable with rebuilt safe comparisons', async () => {
    const preset = JSON.parse(await readFile(new URL('../fixtures/chat-completion-structure.json', import.meta.url), 'utf8'));
    preset.temp_openai = '0.8';
    delete preset.temperature;
    preset.stream_openai = 'true';
    preset.prompts[0].customExtensionField = { mode: 'user-defined' };
    for (const summary of [
        null,
        { isFirst: false, counts: { promptModified: 1 }, rawChangedPaths: ['prompts[main].content'],
            sections: [{ kind: 'prompt-edit', items: [{ identifier: 'main', name: 'Main',
                fields: [{ key: 'content', isContent: true, fromLen: 0, toLen: 3 }] }] }] },
        { tags: [{ label: 'Modified', type: 'edit', count: 1 }],
            details: [{ key: 'temperature', from: 0.1, to: 0.8 }] },
    ]) {
        const result = validateHistoryBackup(payload({ preset, summary })).data.get('openai::Broken')[0];
        assert.equal(result.preset.temperature, 0.8);
        assert.equal(result.preset.stream_openai, true);
        assert.deepEqual(result.preset.prompts[0].customExtensionField, { mode: 'user-defined' });
        assert.equal(result.summary.isFirst, true);
        assert.deepEqual(result.summary.sections, []);
    }
    const other = validateHistoryBackup({ data: { 'custom-api::Custom': [
        record({ preset: { arbitrary_supported_field: { values: [1, true] } } }),
    ] } }).data.get('custom-api::Custom')[0];
    assert.deepEqual(other.preset, { arbitrary_supported_field: { values: [1, true] } });
    assert.equal(validateHistoryBackup(payload({ preset: { wi_format: 1 } }))
        .data.get('openai::Broken')[0].preset.wi_format, 1);
});

test('rescue export preserves readable legacy empty payload and original metadata', () => {
    const data = { 'openai::Broken': [record({ preset: {}, pinned: 'false', saveStatus: 'partial' })] };
    const before = structuredClone(data);
    const exported = createHistoryBackup(data).data['openai::Broken'][0];
    assert.deepEqual(exported.preset, {});
    assert.equal(exported.pinned, 'false');
    assert.equal(exported.saveStatus, 'partial');
    assert.deepEqual(data, before);
});

test('actual repository replace refuses invalid recovery content and retains pinned history', async () => {
    const memory = () => {
        const data = new Map();
        return { data, writes: 0,
            async getItem(key) { return structuredClone(data.get(key) ?? null); },
            async setItem(key, value) { this.writes++; data.set(key, structuredClone(value)); },
            async removeItem(key) { this.writes++; data.delete(key); },
            async keys() { return [...data.keys()]; } };
    };
    const legacyStore = memory(), v2Store = memory();
    const repository = new HistoryRepository({ legacyStore, v2Store });
    await repository.setItem('openai::Good', [record({
        id: 'good', apiId: 'openai', presetName: 'Good', pinned: true,
    })]);
    const existing = new Map([['openai::Good', await repository.getItem('openai::Good')]]);
    const before = structuredClone(v2Store.data);
    const writes = v2Store.writes;
    await assert.rejects(async () => {
        const plan = buildHistoryImportPlan(payload({ preset: { not_a_preset: true }, pinned: 'false' }),
            existing, { mode: 'replace' });
        await applyHistoryImportPlan(repository, plan);
    }, TypeError);
    assert.deepEqual(v2Store.data, before);
    assert.equal(v2Store.writes, writes);
    assert.equal((await repository.getItem('openai::Good'))[0].pinned, true);
    assert.equal(await repository.getItem('openai::Broken'), null);
});
