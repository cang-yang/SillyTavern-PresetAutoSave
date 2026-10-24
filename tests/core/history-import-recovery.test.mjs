import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRepository, migrationMarkerKey } from '../../modules/core/history-repository.js';
import { applyHistoryImportPlan } from '../../modules/core/history-backup.js';

const JOURNAL = '__history_v2_meta__::import-transaction';
const A = 'openai::A';
const B = 'openai::B';
const snapshot = (name, id) => ({
    id, apiId: 'openai', presetName: name, timestamp: 1, hash: id,
    preset: { temperature: 0.7 }, pinned: true, name: 'Keep me',
});

class Store {
    constructor(entries = []) { this.data = new Map(structuredClone(entries)); this.fail = () => false; }
    async keys() { return [...this.data.keys()]; }
    async getItem(key) { return structuredClone(this.data.get(key) ?? null); }
    async setItem(key, value) {
        if (this.fail('set', key, value)) throw new Error('injected storage failure');
        this.data.set(key, structuredClone(value));
    }
    async removeItem(key) {
        if (this.fail('remove', key)) throw new Error('injected storage failure');
        this.data.delete(key);
    }
}

function harness() {
    const legacyStore = new Store();
    const v2Store = new Store([[A, [snapshot('A', 'original')]]]);
    return { legacyStore, v2Store, repository: new HistoryRepository({ legacyStore, v2Store }) };
}

test('import writes a verified durable recovery image before touching authoritative data', async () => {
    const { repository, v2Store } = harness();
    const writes = [];
    v2Store.fail = (operation, key) => {
        if (operation === 'set') writes.push(key);
        return key === JOURNAL;
    };
    await assert.rejects(applyHistoryImportPlan(repository, {
        imported: 1, data: new Map([[B, [snapshot('B', 'incoming')]]]),
    }), /storage failure/);
    assert.equal((await v2Store.getItem(A))[0].id, 'original');
    assert.equal(await v2Store.getItem(B), null);
    assert.deepEqual(writes, [JOURNAL]);
});

test('failed import and rollback retain a journal that a fresh repository restores exactly', async () => {
    const { repository, legacyStore, v2Store } = harness();
    const original = structuredClone([...v2Store.data]);
    let changed = false;
    v2Store.fail = (operation, key, value) => {
        if (operation === 'set' && key === A && value[0].id === 'replacement') changed = true;
        return changed && operation === 'set' && (
            key === B || (key === A && value[0].id === 'original')
        );
    };
    await assert.rejects(applyHistoryImportPlan(repository, {
        imported: 2,
        data: new Map([[A, [snapshot('A', 'replacement')]], [B, [snapshot('B', 'incoming')]]]),
    }), /rollback|recovery/i);
    assert.ok(await v2Store.getItem(JOURNAL), 'the durable image survives rollback failure');
    v2Store.fail = () => false;
    const restarted = new HistoryRepository({ legacyStore, v2Store });
    assert.deepEqual(await restarted.peekItem(A), [snapshot('A', 'original')]);
    assert.deepEqual([...v2Store.data], original);
    assert.deepEqual(await restarted.keys(), [A]);
});

test('successful import cleans its journal and preserves pinned metadata and legacy rollback data', async () => {
    const { repository, legacyStore, v2Store } = harness();
    await legacyStore.setItem(A, [snapshot('A', 'legacy')]);
    const result = await applyHistoryImportPlan(repository, {
        imported: 1, data: new Map([[B, [snapshot('B', 'incoming')]]]),
    });
    assert.equal(result, 1);
    assert.deepEqual(await repository.keys(), [B]);
    assert.equal((await repository.getItem(B))[0].pinned, true);
    assert.equal((await legacyStore.getItem(A))[0].id, 'legacy');
    assert.equal(await v2Store.getItem(JOURNAL), null);
    assert.equal((await v2Store.getItem(migrationMarkerKey(A))).status, 'deleted');
});

test('a committed import with failed journal cleanup is not rolled back after restart', async () => {
    const { repository, legacyStore, v2Store } = harness();
    v2Store.fail = (operation, key) => operation === 'remove' && key === JOURNAL;
    assert.equal(await applyHistoryImportPlan(repository, {
        imported: 1, data: new Map([[B, [snapshot('B', 'incoming')]]]),
    }), 1);
    assert.equal((await v2Store.getItem(JOURNAL))?.phase, 'committed');
    v2Store.fail = () => false;
    const restarted = new HistoryRepository({ legacyStore, v2Store });
    assert.deepEqual(await restarted.keys(), [B]);
    assert.equal(await v2Store.getItem(JOURNAL), null);
});

test('a malformed journal blocks reads without altering any recovery entries', async () => {
    const { legacyStore, v2Store } = harness();
    await v2Store.setItem(JOURNAL, { version: 1, phase: 'pending', entries: 'broken' });
    const before = structuredClone([...v2Store.data]);
    const restarted = new HistoryRepository({ legacyStore, v2Store });
    await assert.rejects(restarted.keys(), /invalid history import recovery/i);
    assert.deepEqual([...v2Store.data], before);
});

test('reads cannot observe a half-applied import and queued writes run afterwards', async () => {
    const { repository, v2Store } = harness();
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const blocked = new Promise(resolve => { entered = resolve; });
    const write = v2Store.setItem.bind(v2Store);
    v2Store.setItem = async (key, value) => {
        if (key === B) { entered(); await gate; }
        return write(key, value);
    };
    const importing = applyHistoryImportPlan(repository, {
        imported: 1, data: new Map([[B, [snapshot('B', 'incoming')]]]),
    });
    await blocked;
    let readCompleted = false;
    const reading = repository.keys().then(keys => { readCompleted = true; return keys; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(readCompleted, false);
    release();
    await importing;
    assert.deepEqual(await reading, [B]);
});
