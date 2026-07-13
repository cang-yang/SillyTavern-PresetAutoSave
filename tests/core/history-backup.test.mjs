import test from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeHistoryImport,
    applyHistoryImportPlan,
    HISTORY_BACKUP_VERSION,
    buildHistoryImportPlan,
    captureHistoryImage,
    createHistoryBackup,
    validateHistoryBackup,
} from '../../modules/core/history-backup.js';

class MemoryRepository {
    constructor(entries = {}, failKey = null) {
        this.map = new Map(Object.entries(structuredClone(entries)));
        this.failKey = failKey;
        this.failed = false;
    }
    async keys() { return [...this.map.keys()]; }
    async getItem(key) { return structuredClone(this.map.get(key) ?? null); }
    async setItem(key, value) {
        if (key === this.failKey && !this.failed) {
            this.failed = true;
            throw new Error('injected write failure');
        }
        this.map.set(key, structuredClone(value));
    }
    async removeItem(key) { this.map.delete(key); }
}

function snapshot(overrides = {}) {
    return {
        id: 'snap-1', presetName: 'Demo', apiId: 'openai', timestamp: 10,
        trigger: 'auto', preset: { temperature: 0.7, prompts: [] },
        hash: 'abc', size: 42, name: '', pinned: false,
        ...overrides,
    };
}

test('creates a v2 backup with repository diagnostics', () => {
    const backup = createHistoryBackup(
        { 'openai::Demo': [snapshot()] },
        { schemaVersion: 2, migration: { succeeded: 1 } },
        () => 123,
    );

    assert.equal(backup.version, HISTORY_BACKUP_VERSION);
    assert.equal(backup.schemaVersion, 2);
    assert.equal(backup.exportedAt, 123);
    assert.equal(backup.source, 'PresetAutoSave');
    assert.deepEqual(backup.repository, { schemaVersion: 2, migration: { succeeded: 1 } });
    assert.equal(backup.data['openai::Demo'][0].id, 'snap-1');
});

test('accepts and enriches a v1 backup without mutating it', () => {
    const payload = { version: 1, data: { 'openai::Demo': [snapshot()] } };
    const before = structuredClone(payload);
    const validated = validateHistoryBackup(payload);

    assert.equal(validated.sourceVersion, 1);
    assert.equal(validated.data.get('openai::Demo')[0].schemaVersion, 2);
    assert.deepEqual(payload, before);
});

test('rejects unsupported versions and malformed data before planning writes', () => {
    assert.throws(() => validateHistoryBackup({ version: 3, data: {} }), /unsupported/i);
    assert.throws(() => validateHistoryBackup({ version: 2, data: [] }), /data/i);
    assert.throws(() => validateHistoryBackup({ version: 2, data: { invalid: [snapshot()] } }), /key/i);
    assert.throws(() => validateHistoryBackup({ version: 2, data: { 'openai::Demo': {} } }), /array/i);
    assert.throws(() => validateHistoryBackup({
        version: 2,
        data: { 'openai::Demo': [snapshot({ presetName: 'Other' })] },
    }), /presetName/i);
    assert.throws(() => validateHistoryBackup({
        version: 2,
        data: { 'openai::Demo': [snapshot({ timestamp: Number.NaN })] },
    }), /timestamp/i);
    assert.throws(() => validateHistoryBackup({
        version: 2,
        data: { 'openai::Demo': [snapshot({ preset: null })] },
    }), /preset/i);
});

test('rejects duplicate snapshot IDs across the complete backup', () => {
    assert.throws(() => validateHistoryBackup({
        version: 2,
        data: {
            'openai::Demo': [snapshot()],
            'openai::Other': [snapshot({ presetName: 'Other' })],
        },
    }), /duplicate snapshot id/i);
});

test('import validation removes connection secrets before creating a write plan', () => {
    const payload = { version: 2, data: { 'openai::Demo': [snapshot({
        preset: {
            temperature: 0.7,
            prompts: [],
            api_key_openai: 'sk-import-secret',
            proxy_password: 'proxy-import-secret',
        },
    })] } };

    const plan = buildHistoryImportPlan(payload, new Map(), { mode: 'replace', max: 50 });
    const importedPreset = plan.data.get('openai::Demo')[0].preset;
    assert.deepEqual(importedPreset, { prompts: [], temperature: 0.7 });
    assert.equal(JSON.stringify(importedPreset).includes('sk-import-secret'), false);
    assert.equal(JSON.stringify(importedPreset).includes('proxy-import-secret'), false);
});

test('backup creation defensively removes secrets from already stored snapshots', () => {
    const backup = createHistoryBackup({ 'openai::Demo': [snapshot({
        preset: {
            temperature: 0.7,
            prompts: [],
            api_key_openai: 'sk-stored-secret',
            reverse_proxy: 'https://secret-proxy.example',
        },
    })] });

    assert.deepEqual(backup.data['openai::Demo'][0].preset, { prompts: [], temperature: 0.7 });
    assert.equal(JSON.stringify(backup).includes('sk-stored-secret'), false);
    assert.equal(JSON.stringify(backup).includes('secret-proxy.example'), false);
});

test('merge planning deduplicates IDs, sorts, trims, and preserves pinned records', () => {
    const existing = new Map([['openai::Demo', [
        snapshot({ id: 'existing-new', timestamp: 30 }),
        snapshot({ id: 'pinned-old', timestamp: 1, pinned: true }),
    ]] ]);
    const payload = { version: 1, data: { 'openai::Demo': [
        snapshot({ id: 'existing-new', timestamp: 30 }),
        snapshot({ id: 'import-new', timestamp: 20 }),
        snapshot({ id: 'import-old', timestamp: 10 }),
    ] } };

    const plan = buildHistoryImportPlan(payload, existing, { mode: 'merge', max: 3 });
    const ids = plan.data.get('openai::Demo').map(item => item.id);
    assert.deepEqual(ids, ['existing-new', 'import-new', 'pinned-old']);
    assert.equal(plan.imported, 1, 'count only imported snapshots that survive trimming');
});

test('merge planning rejects a same-ID snapshot with different content', () => {
    const existing = new Map([['openai::Demo', [snapshot({ id: 'collision', hash: 'old' })]]]);
    const payload = { version: 2, data: { 'openai::Demo': [
        snapshot({ id: 'collision', hash: 'new', preset: { temperature: 0.99 } }),
    ] } };

    assert.throws(
        () => buildHistoryImportPlan(payload, existing, { mode: 'merge', max: 50 }),
        /conflicting snapshot id/i,
    );
    assert.equal(existing.get('openai::Demo')[0].hash, 'old');
});

test('replace planning produces a complete replacement image', () => {
    const existing = new Map([['openai::Old', [snapshot({ presetName: 'Old' })]]]);
    const payload = { version: 2, data: { 'openai::Demo': [snapshot()] } };
    const plan = buildHistoryImportPlan(payload, existing, { mode: 'replace', max: 50 });

    assert.deepEqual([...plan.data.keys()], ['openai::Demo']);
    assert.equal(plan.imported, 1);
    assert.equal(plan.data.get('openai::Demo')[0].schemaVersion, 2);
});

test('import analysis reports counts, overlap and conflicts without writing', () => {
    const duplicate = snapshot({ id: 'duplicate', timestamp: 30 });
    const existing = new Map([
        ['openai::Demo', [
            duplicate,
            snapshot({ id: 'collision', timestamp: 20, hash: 'old', preset: { temperature: 0.2 } }),
        ]],
        ['openai::Existing only', [snapshot({ id: 'existing-only', presetName: 'Existing only' })]],
    ]);
    const payload = { version: 2, schemaVersion: 2, data: { 'openai::Demo': [
        duplicate,
        snapshot({ id: 'new', timestamp: 40 }),
        snapshot({ id: 'collision', timestamp: 20, hash: 'new', preset: { temperature: 0.9 } }),
    ] } };

    const preview = analyzeHistoryImport(payload, existing, { max: 50 });

    assert.equal(preview.sourceVersion, 2);
    assert.equal(preview.schemaVersion, 2);
    assert.equal(preview.presetCount, 1);
    assert.equal(preview.snapshotCount, 3);
    assert.equal(preview.overlappingPresetCount, 1);
    assert.equal(preview.duplicateSnapshotCount, 1);
    assert.equal(preview.conflictCount, 1);
    assert.deepEqual(preview.conflicts, [{ key: 'openai::Demo', snapshotId: 'collision' }]);
    assert.equal(preview.modes.merge.available, false);
    assert.equal(preview.modes.replace.available, true);
    assert.equal(preview.modes.replace.removedPresetCount, 1);
    assert.equal(preview.modes.replace.finalPresetCount, 1);
    assert.equal(preview.modes.replace.finalSnapshotCount, 3);
    assert.equal(existing.get('openai::Demo').length, 2, 'analysis must not mutate current history');
});

test('import analysis explains the safe merge result before apply', () => {
    const existing = new Map([['openai::Demo', [snapshot({ id: 'existing', timestamp: 30 })]]]);
    const payload = { version: 1, data: {
        'openai::Demo': [snapshot({ id: 'new', timestamp: 40 })],
        'openai::Other': [snapshot({ id: 'other', presetName: 'Other', timestamp: 20 })],
    } };

    const preview = analyzeHistoryImport(payload, existing, { max: 50 });

    assert.equal(preview.conflictCount, 0);
    assert.equal(preview.modes.merge.available, true);
    assert.equal(preview.modes.merge.importedSnapshotCount, 2);
    assert.equal(preview.modes.merge.finalPresetCount, 2);
    assert.equal(preview.modes.merge.finalSnapshotCount, 3);
    assert.equal(preview.modes.merge.removedPresetCount, 0);
});

test('captures an independent repository image', async () => {
    const repository = new MemoryRepository({ 'openai::Demo': [snapshot()] });
    const image = await captureHistoryImage(repository);
    image.get('openai::Demo')[0].name = 'changed outside';
    assert.equal((await repository.getItem('openai::Demo'))[0].name, '');
});

test('restores the complete prior image after a partial import write failure', async () => {
    const original = {
        'openai::Old': [snapshot({ id: 'old', presetName: 'Old' })],
    };
    const repository = new MemoryRepository(original, 'openai::B');
    const plan = {
        mode: 'replace', imported: 2, sourceVersion: 2,
        data: new Map([
            ['openai::A', [snapshot({ id: 'a', presetName: 'A' })]],
            ['openai::B', [snapshot({ id: 'b', presetName: 'B' })]],
        ]),
    };

    await assert.rejects(() => applyHistoryImportPlan(repository, plan), /rolled back/i);
    assert.deepEqual(Object.fromEntries(await captureHistoryImage(repository)), original);
});
