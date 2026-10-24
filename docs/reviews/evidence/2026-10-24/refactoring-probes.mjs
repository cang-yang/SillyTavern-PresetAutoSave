import assert from 'node:assert/strict';

const root = new URL('../../../../', import.meta.url);
const load = path => import(new URL(path, root));
const mode = process.argv[2];

// These probes use synthetic payloads and memory-only host/storage adapters.
function installHost() {
    const stores = new Map();
    const messages = [];
    class Popup {
        async show() { return '1'; }
    }
    Popup.show = { confirm: async () => true };
    const manager = {
        select: [{ options: [{ textContent: 'current', value: '0' }], selectedIndex: 0 }],
        async savePreset() { return true; },
        async deletePreset() { return false; },
    };
    const context = {
        mainApi: 'openai', extensionSettings: {}, saveSettingsDebounced() {},
        eventSource: { on() {}, off() {}, emit() {} }, event_types: {},
        getPresetManager: () => manager,
        Popup, POPUP_TYPE: { DISPLAY: 'display', INPUT: 'input' },
    };
    globalThis.window = globalThis;
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: { localforage: { createInstance({ name, storeName }) {
            const id = `${name}::${storeName}`;
            if (!stores.has(id)) stores.set(id, new Map());
            const map = stores.get(id);
            return {
                async getItem(key) { return structuredClone(map.get(key) ?? null); },
                async setItem(key, value) { map.set(key, structuredClone(value)); return value; },
                async removeItem(key) { map.delete(key); },
                async keys() { return [...map.keys()]; },
                async clear() { map.clear(); },
            };
        } } },
    };
    globalThis.document = {
        querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.toastr = {
        info() {}, warning() {},
        error: message => messages.push(['error', message]),
        success: message => messages.push(['success', message]),
    };
    return { messages };
}

async function canonicalParity() {
    const { sanitizePresetForExport } = await load('modules/compatibility.js');
    const { createHistoryBackup } = await load('modules/core/history-backup.js');
    const preset = {
        temp_openai: '0.8', bias_preset_selected: 'Default',
        prompts: [{ identifier: 'custom-local', content: 'synthetic' }],
    };
    const captured = sanitizePresetForExport(preset);
    const backup = createHistoryBackup({
        'openai::probe': [{ id: 'probe', timestamp: 1, preset }],
    }).data['openai::probe'][0].preset;
    console.log(JSON.stringify({ captured, backup }));
    assert.deepEqual(backup, captured, 'Capture and backup must share a canonical contract');
}

async function promptPermutation() {
    const { computeChangeSummary, hashPreset } = await load('modules/history-store.js');
    const before = { prompts: [
        { identifier: 'main', content: 'synthetic main' },
        { identifier: 'jailbreak', content: 'synthetic secondary' },
    ] };
    const after = { prompts: [...before.prompts].reverse() };
    console.log(JSON.stringify({ hashDifferent: hashPreset(before) !== hashPreset(after) }));
    assert.doesNotThrow(() => computeChangeSummary(before, after),
        'Valid prompt permutation must have an agreed, explainable semantic result');
}

async function deleteFailure() {
    const { messages } = installHost();
    (await load('modules/compatibility.js')).initCompatibility();
    await (await load('modules/settings.js')).initSettings();
    const history = await load('modules/history-store.js');
    const archive = await load('modules/archive-store.js');
    await history.initHistoryStore();
    await archive.initArchiveStore();
    const actions = await load('modules/panel-actions.js');
    const observations = [];
    try {
        for (const kind of ['single', 'batch']) {
            const name = `doomed-${kind}`;
            const payload = {
                temperature: 0.7, top_p: 1, openai_max_tokens: 100,
                openai_max_context: 4096, prompts: [],
            };
            await history.addSnapshot(name, 'openai', payload, 'manual');
            await archive.archivePreset('openai', name, payload, 'doomed');
            const before = (await history.getSnapshots('openai', name)).length;
            const result = kind === 'single'
                ? await actions.onDeletePreset(name, 'openai')
                : await actions.onBatchDeletePresets([name], 'openai');
            observations.push({
                kind, hostDeleteReturned: false, before,
                after: (await history.getSnapshots('openai', name)).length,
                archiveRetained: !!await archive.getArchivedPreset('openai', name),
                result, lastMessage: messages.at(-1),
            });
        }
    } finally {
        await history.teardownHistoryStore();
    }
    console.log(JSON.stringify(observations));
    for (const item of observations) {
        assert.equal(item.after, item.before, `${item.kind}: failed host deletion must preserve history`);
        assert.equal(item.archiveRetained, true, `${item.kind}: failed deletion must preserve recovery`);
        assert.equal(Boolean(item.result), false, `${item.kind}: failed deletion must not report success`);
    }
}

const probes = {
    'canonical-parity': canonicalParity,
    'prompt-permutation': promptPermutation,
    'delete-failure': deleteFailure,
};
if (!probes[mode]) throw new Error(`Choose a probe: ${Object.keys(probes).join(', ')}`);
await probes[mode]();
