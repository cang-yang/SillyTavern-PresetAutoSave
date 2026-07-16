import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryCatalog } from '../../modules/core/history-catalog.js';

class MemoryStore {
    constructor(entries = {}) {
        this.map = new Map(Object.entries(structuredClone(entries)));
        this.failSet = false;
    }
    async getItem(key) { return structuredClone(this.map.get(key) ?? null); }
    async setItem(key, value) {
        if (this.failSet) throw new Error('catalog quota failure');
        this.map.set(key, structuredClone(value));
        return value;
    }
    async removeItem(key) { this.map.delete(key); }
}

function snapshot(id, timestamp, overrides = {}) {
    return {
        id,
        apiId: 'openai',
        presetName: 'Demo',
        timestamp,
        size: 10,
        hash: `hash-${id}`,
        trigger: 'auto',
        name: '',
        pinned: false,
        summary: { isFirst: false, sections: [], rawChangedPaths: ['temperature'] },
        preset: { prompts: [{ identifier: 'main', content: `private-${id}` }] },
        ...overrides,
    };
}

test('missing catalog loads as incomplete without inventing summaries', async () => {
    const catalog = createHistoryCatalog({ store: new MemoryStore() });

    const state = await catalog.load();

    assert.equal(state.status, 'missing');
    assert.deepEqual(state.summaries, []);
    assert.deepEqual(state.progress, { completed: 0, total: 0 });
});

test('rebuild reads buckets sequentially, yields, reports progress, and publishes one verified document', async () => {
    const store = new MemoryStore();
    const calls = [];
    const yields = [];
    const progress = [];
    const catalog = createHistoryCatalog({
        store,
        now: () => 500,
        yieldControl: async () => { yields.push('yield'); },
    });
    await catalog.load();
    const buckets = {
        'openai::A': [snapshot('a-new', 30, { presetName: 'A' })],
        'openai::B': [
            snapshot('b-old', 10, { presetName: 'B' }),
            snapshot('b-new', 20, { presetName: 'B' }),
        ],
    };

    const result = await catalog.rebuild({
        keys: Object.keys(buckets),
        sourceManifest: [
            { key: 'openai::A', revision: 'rev-a' },
            { key: 'openai::B', revision: 'rev-b' },
        ],
        async readBucket(key) {
            calls.push(key);
            return structuredClone(buckets[key]);
        },
        onProgress(value) { progress.push(value); },
    });

    assert.deepEqual(calls, ['openai::A', 'openai::B']);
    assert.equal(yields.length, 2);
    assert.deepEqual(progress.map(item => [item.completed, item.total]), [[0, 2], [1, 2], [2, 2]]);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.summaries.map(item => item.id), ['a-new', 'b-new', 'b-old']);
    assert.equal(JSON.stringify(result).includes('private-'), false);
    assert.equal(store.map.size, 1, 'catalog persists as one small versioned document');
    assert.equal(catalog.matchesSourceManifest([
        { key: 'openai::B', revision: 'rev-b' },
        { key: 'openai::A', revision: 'rev-a' },
    ]), true);
    assert.equal(catalog.matchesSourceManifest([
        { key: 'openai::A', revision: 'rev-a' },
    ]), false);
});

test('ready catalog replaces and removes one stable preset bucket without disturbing others', async () => {
    const catalog = createHistoryCatalog({ store: new MemoryStore(), now: () => 1 });
    await catalog.load();
    await catalog.rebuild({
        keys: ['openai::A', 'openai::B'],
        readBucket: async key => key.endsWith('A')
            ? [snapshot('a', 10, { presetName: 'A' })]
            : [snapshot('b', 20, { presetName: 'B' })],
    });

    await catalog.replaceBucket('openai', 'A', [snapshot('a2', 30, { presetName: 'A', pinned: true })]);
    assert.deepEqual(catalog.read().summaries.map(item => item.id), ['a2', 'b']);
    assert.equal(catalog.read().summaries.find(item => item.id === 'a2').pinned, true);

    await catalog.removeBucket('openai', 'B');
    assert.deepEqual(catalog.read().summaries.map(item => item.id), ['a2']);
});

test('catalog reads are defensive and cannot mutate persisted state', async () => {
    const catalog = createHistoryCatalog({ store: new MemoryStore() });
    await catalog.load();
    await catalog.rebuild({ keys: ['openai::Demo'], readBucket: async () => [snapshot('a', 10)] });

    const first = catalog.read();
    first.summaries[0].name = 'changed outside';
    first.summaries[0].summary.sections.push({ kind: 'field', items: [] });

    const second = catalog.read();
    assert.equal(second.summaries[0].name, '');
    assert.deepEqual(second.summaries[0].summary.sections, []);
});

test('failed rebuild preserves the last verified summaries and never publishes partial success', async () => {
    const store = new MemoryStore();
    const catalog = createHistoryCatalog({ store });
    await catalog.load();
    await catalog.rebuild({ keys: ['openai::Demo'], readBucket: async () => [snapshot('verified', 10)] });

    await assert.rejects(
        catalog.rebuild({
            keys: ['openai::A', 'openai::Broken'],
            readBucket: async key => {
                if (key.endsWith('Broken')) throw new Error('authoritative read failed');
                return [snapshot('partial', 20, { presetName: 'A' })];
            },
        }),
        /authoritative read failed/,
    );

    const state = catalog.read();
    assert.equal(state.status, 'error');
    assert.deepEqual(state.summaries.map(item => item.id), ['verified']);
});

test('catalog persistence failure keeps the previous verified document readable', async () => {
    const store = new MemoryStore();
    const catalog = createHistoryCatalog({ store });
    await catalog.load();
    await catalog.rebuild({ keys: ['openai::Demo'], readBucket: async () => [snapshot('verified', 10)] });
    store.failSet = true;

    await assert.rejects(
        catalog.replaceBucket('openai', 'Demo', [snapshot('replacement', 20)]),
        /quota failure/,
    );

    assert.equal(catalog.read().status, 'error');
    assert.deepEqual(catalog.read().summaries.map(item => item.id), ['verified']);
});

test('corrupt or unknown catalog documents fail closed and request rebuilding', async () => {
    const catalog = createHistoryCatalog({
        store: new MemoryStore({ catalog: { schemaVersion: 999, buckets: { bad: [{ preset: { secret: true } }] } } }),
    });

    const state = await catalog.load();

    assert.equal(state.status, 'dirty');
    assert.deepEqual(state.summaries, []);
    assert.equal(JSON.stringify(state).includes('secret'), false);
});

test('aborted rebuild keeps the prior verified catalog and yields a diagnosable dirty state', async () => {
    const catalog = createHistoryCatalog({ store: new MemoryStore() });
    await catalog.load();
    await catalog.rebuild({ keys: ['openai::Demo'], readBucket: async () => [snapshot('verified', 10)] });
    const controller = new AbortController();

    await assert.rejects(
        catalog.rebuild({
            keys: ['openai::A', 'openai::B'],
            signal: controller.signal,
            readBucket: async key => {
                controller.abort();
                return [snapshot(key, 20, { presetName: key })];
            },
        }),
        error => error?.name === 'AbortError',
    );

    assert.equal(catalog.read().status, 'dirty');
    assert.deepEqual(catalog.read().summaries.map(item => item.id), ['verified']);
});
