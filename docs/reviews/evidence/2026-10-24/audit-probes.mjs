import assert from 'node:assert/strict';

const root = new URL('../../../../', import.meta.url);
const load = path => import(new URL(path, root));
const mode = process.argv[2] || 'save-race';
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const snapshot = (presetName, id = presetName) => ({
    id, presetName, apiId: 'openai', timestamp: 10, trigger: 'auto',
    preset: { temperature: 0.7, prompts: [] },
    hash: 'abc', size: 42, name: '', pinned: false,
});
const memoryStore = (entries = []) => {
    const map = new Map(entries);
    return {
        map,
        async getItem(key) { return structuredClone(map.get(key) ?? null); },
        async setItem(key, value) { map.set(key, structuredClone(value)); return value; },
        async removeItem(key) { map.delete(key); },
        async keys() { return [...map.keys()]; },
        async clear() { map.clear(); },
    };
};

// Every host and storage dependency is an in-memory fake; no user data is read.
function installHost(manager, intercept = () => {}) {
    const stores = new Map();
    const events = new Map();
    const context = {
        mainApi: 'openai', extensionSettings: {}, saveSettingsDebounced() {},
        getPresetManager: () => manager, event_types: {},
        eventSource: {
            on(name, handler) {
                if (!events.has(name)) events.set(name, new Set());
                events.get(name).add(handler);
            },
            off(name, handler) { events.get(name)?.delete(handler); },
        },
    };
    globalThis.window = globalThis;
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: { localforage: {
            createInstance({ storeName }) {
                if (!stores.has(storeName)) {
                    const store = memoryStore();
                    intercept(storeName, store);
                    stores.set(storeName, store);
                }
                return stores.get(storeName);
            },
        } },
    };
    globalThis.document = {
        body: { addEventListener() {}, removeEventListener() {},
            classList: { toggle() {}, remove() {} } },
        documentElement: {}, readyState: 'complete',
        querySelector() { return null; }, querySelectorAll() { return []; },
        getElementById() { return null; }, addEventListener() {}, removeEventListener() {},
    };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    return { stores, events };
}

async function saveRace() {
    const live = {
        temperature: 0.1, top_p: 0.9, frequency_penalty: 0,
        presence_penalty: 0, openai_max_tokens: 1024, prompts: [],
    };
    const stored = structuredClone(live);
    const started = deferred();
    const barrier = deferred();
    let disk;
    let saves = 0;
    installHost({
        select: [{ selectedIndex: 0, options: [{ textContent: 'race', value: '0' }] }],
        getSelectedPresetName: () => 'race',
        getPresetList: () => ({ settings: live, presets: [stored], preset_names: ['race'] }),
        getPresetSettings: () => ({}), selectPreset() {}, findPreset: () => 0,
        async savePreset(name, preset) {
            saves++;
            started.resolve();
            await barrier.promise;
            disk = structuredClone(preset);
        },
    });
    (await load('modules/compatibility.js')).initCompatibility();
    const settings = await load('modules/settings.js');
    await settings.initSettings();
    settings.batchUpdate({ mergeWindowSec: 0, fallbackPolling: false });
    const history = await load('modules/history-store.js');
    await history.initHistoryStore();
    const auto = await load('modules/auto-save.js');
    await auto.initAutoSave();
    let result;
    try {
        live.temperature = 0.2;
        const first = auto.saveNow();
        await started.promise;
        live.temperature = 0.3;
        auto.scheduleAutoSave(40, 'settings_updated');
        barrier.resolve();
        await first;
        await new Promise(resolve => setTimeout(resolve, 150));
        result = {
            live: live.temperature, disk: disk.temperature, saves,
            tracking: auto.getCurrentTracking(),
            history: (await history.getSnapshots('openai', 'race')).map(item => item.preset.temperature),
        };
    } finally {
        barrier.resolve();
        await auto.teardown();
        await history.teardownHistoryStore();
    }
    console.log(JSON.stringify(result));
    assert.equal(result.disk, result.live, 'A newer live edit must not be marked saved without persistence');
}

async function lifecycleRace() {
    const barrier = deferred();
    const reached = deferred();
    let first = true;
    const { events } = installHost({
        savePreset() {}, getPresetSettings: () => ({}), selectPreset() {}, findPreset() {},
        getPresetList: () => ({ settings: {}, presets: [], preset_names: [] }),
    }, (name, store) => {
        if (name !== 'archived_presets') return;
        const keys = store.keys;
        store.keys = async () => {
            if (first) { first = false; reached.resolve(); await barrier.promise; }
            return keys();
        };
    });
    const entry = await load('index.js');
    const enabling = entry.onEnable();
    await reached.promise;
    const disabled = await entry.onDisable();
    const count = () => [...events.values()].reduce((total, set) => total + set.size, 0);
    const before = count();
    barrier.resolve();
    const enabled = await enabling;
    const after = count();
    console.log(JSON.stringify({ disabled, enabled, listenersBefore: before, listenersAfter: after }));
    await entry.onDisable();
    assert.equal(after, 0, 'An old initialization must not install listeners after disable');
}

async function archiveReadFailure() {
    const { stores } = installHost({ savePreset() {} }, (name, store) => {
        if (name !== 'archived_presets') return;
        store.map.set('openai::Unreadable', { apiId: 'openai', presetName: 'Unreadable', data: {} });
        store.getItem = async () => { throw new Error('INJECTED_ARCHIVE_READ_FAILURE'); };
    });
    (await load('modules/compatibility.js')).initCompatibility();
    const archive = await load('modules/archive-store.js');
    await archive.initArchiveStore();
    const { runDeleteRecovery } = await load('modules/core/lifecycle-recovery.js');
    let strictRejected = false;
    const result = await runDeleteRecovery({
        restoreArchives: async () => {
            try {
                const entries = await archive.listArchivedPresets({ strict: true });
                return { restored: entries.length, failed: 0 };
            } catch (error) {
                strictRejected = true;
                throw error;
            }
        },
        writeBackSnapshots: async () => ({ written: 0, failed: 0 }),
        clearSnapshots: async () => true,
        clearArchives: () => archive.clearAllArchived(),
    });
    const remaining = await stores.get('archived_presets').keys();
    console.log(JSON.stringify({ strictRejected, result, remaining }));
    assert.equal(result.archivesCleared, false, 'Unreadable archive entries must block global cleanup');
}

async function ghostRecovery() {
    const { createSnapshotWriteback } = await load('modules/core/snapshot-writeback.js');
    const { parsePresetName } = await load('modules/preset-grouping.js');
    const { runDeleteRecovery } = await load('modules/core/lifecycle-recovery.js');
    const writes = [];
    const writeBack = createSnapshotWriteback({
        loadSnapshots: async () => [snapshot('Story'), snapshot('Story v2')],
        getPresetManager: () => ({ getPresetList: () => ({ preset_names: [] }) }),
        savePreset: async name => { writes.push(name); }, parsePresetName,
    });
    const result = await runDeleteRecovery({
        restoreArchives: async () => ({ restored: 0, failed: 0 }),
        writeBackSnapshots: () => writeBack({ skipExisting: true, filterGhosts: true }),
        clearSnapshots: async () => true, clearArchives: async () => true,
    });
    console.log(JSON.stringify({ writes, result }));
    assert.ok(writes.includes('Story'), 'A real base-name preset must be restored before clearing its history');
}

async function importCollision() {
    const { buildHistoryImportPlan } = await load('modules/core/history-backup.js');
    let rejected = false;
    let owners = [];
    try {
        const plan = buildHistoryImportPlan(
            { version: 2, data: { 'openai::B': [snapshot('B', 'same-id')] } },
            new Map([['openai::A', [snapshot('A', 'same-id')]]]),
            { mode: 'merge', max: 50 },
        );
        owners = [...plan.data].map(([key, entries]) => ({ key, ids: entries.map(item => item.id) }));
    } catch { rejected = true; }
    console.log(JSON.stringify({ rejected, owners }));
    assert.equal(rejected, true, 'Merge must reject globally ambiguous snapshot identities');
}

async function migrationDeleteRace() {
    const { HistoryRepository, migrationMarkerKey } = await load('modules/core/history-repository.js');
    const key = 'openai::Story';
    const legacyStore = memoryStore([[key, [snapshot('Story')]]]);
    const v2Store = memoryStore();
    const started = deferred();
    const barrier = deferred();
    const setItem = v2Store.setItem;
    v2Store.setItem = async (name, value) => {
        if (name === key) { started.resolve(); await barrier.promise; }
        return setItem(name, value);
    };
    const repository = new HistoryRepository({ legacyStore, v2Store });
    const reading = repository.getItem(key);
    await started.promise;
    await repository.removeItem(key);
    barrier.resolve();
    await reading;
    const marker = await v2Store.getItem(migrationMarkerKey(key));
    const keys = await repository.keys();
    console.log(JSON.stringify({ marker: marker.status, keys }));
    assert.ok(!keys.includes(key), 'A read-side migration must not resurrect a deleted target');
}

async function canonicalDiff() {
    const { buildDiffPopupHTML } = await load('modules/diff-viewer.js');
    const { sanitizePresetForExport } = await load('modules/compatibility.js');
    const pairs = [
        ['prompt-trigger',
            { prompts: [{ identifier: 'main', content: 'text', injection_trigger: [] }] },
            { prompts: [{ identifier: 'main', content: 'text', injection_trigger: [1] }] }],
        ['second-order-group',
            { prompt_order: [{ character_id: 1, order: [] },
                { character_id: 2, order: [{ identifier: 'main', enabled: true }] }] },
            { prompt_order: [{ character_id: 1, order: [] },
                { character_id: 2, order: [{ identifier: 'main', enabled: false }] }] }],
        ['extension-field',
            { extensions: { regex_scripts: [{ findRegex: 'before' }] } },
            { extensions: { regex_scripts: [{ findRegex: 'after' }] } }],
    ];
    const results = pairs.map(([name, a, b]) => ({
        name,
        canonicalDifferent: JSON.stringify(sanitizePresetForExport(a, { apiId: 'openai' }))
            !== JSON.stringify(sanitizePresetForExport(b, { apiId: 'openai' })),
        saysNoChanges: buildDiffPopupHTML(
            { ...snapshot('Story', 'a'), preset: a },
            { ...snapshot('Story', 'b'), preset: b },
        ).includes('pas-diff-no-changes'),
    }));
    console.log(JSON.stringify(results));
    assert.ok(results.every(item => !item.canonicalDifferent || !item.saysNoChanges),
        'Canonically different presets must not be presented as identical');
}

async function aliasCollision() {
    const { groupNamesBySeries, groupSnapshotsBySeries } = await load('modules/preset-grouping.js');
    const names = ['Story V1', 'Utility V1', 'Other V1'];
    const aliases = { story: 'Utility', utility: 'Tools', other: 'Tools' };
    const named = groupNamesBySeries(names, {}, aliases);
    const groups = groupSnapshotsBySeries(names.map(name => snapshot(name)), { aliases });
    console.log(JSON.stringify({
        names: named.map(group => ({ key: group.canonicalKey, label: group.displayName })),
        groups: [...groups.values()].map(group => ({
            key: group.canonicalKey, label: group.series,
            members: group.versions.map(version => version.presetName),
        })),
    }));
    assert.equal(groups.size, 3, 'Display-name collisions must not merge canonical groups');
}

const probes = {
    'save-race': saveRace,
    'lifecycle-race': lifecycleRace,
    'archive-read': archiveReadFailure,
    'ghost-recovery': ghostRecovery,
    'import-collision': importCollision,
    'migration-delete': migrationDeleteRace,
    'canonical-diff': canonicalDiff,
    'alias-collision': aliasCollision,
};
if (!Object.hasOwn(probes, mode)) throw new Error(`Unknown probe: ${mode}`);
await probes[mode]();
