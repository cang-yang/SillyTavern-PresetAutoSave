export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export function installRuntimeHost({ save = async () => {}, remove = async () => true, storageKeys = async () => {}, storageSet = async () => {}, storageGet = async () => {} } = {}) {
    const stores = new Map();
    const events = new Map();
    const live = { temperature: 0.1, top_p: 0.9, frequency_penalty: 0,
        presence_penalty: 0, openai_max_tokens: 1024, prompts: [] };
    const stored = structuredClone(live);
    const writes = [];
    const select = { selectedIndex: 0, options: [{ textContent: 'race', value: '0' }] };
    const pm = {
        select: [select],
        getPresetList: () => ({ settings: live, presets: [stored], preset_names: ['race'] }),
        getPresetSettings: () => ({}),
        async savePreset(name, preset, options) {
            const captured = structuredClone(preset);
            await save({ name, preset: captured, options });
            writes.push({ name, preset: captured, options });
            if (options?.skipUpdate === false) Object.assign(live, captured);
        },
        selectPreset() {},
        deletePreset: name => remove(name),
        findPreset: () => 0,
    };
    const context = {
        mainApi: 'openai',
        extensionSettings: {},
        saveSettingsDebounced() {},
        getPresetManager: () => pm,
        event_types: {},
        eventSource: {
            on(event, handler) {
                if (!events.has(event)) events.set(event, new Set());
                events.get(event).add(handler);
            },
            off(event, handler) { events.get(event)?.delete(handler); },
        },
    };
    globalThis.window = globalThis;
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: { localforage: { createInstance({ storeName }) {
            if (!stores.has(storeName)) stores.set(storeName, new Map());
            const values = stores.get(storeName);
            return {
                async getItem(key) { await storageGet(storeName, key); return structuredClone(values.get(key) ?? null); },
                async setItem(key, value) {
                    await storageSet(storeName, key, value);
                    values.set(key, structuredClone(value));
                    return value;
                },
                async removeItem(key) { values.delete(key); },
                async keys() { await storageKeys(storeName); return [...values.keys()]; },
                async clear() { values.clear(); },
            };
        } } },
    };
    const body = { addEventListener() {}, removeEventListener() {},
        classList: { toggle() {}, remove() {} } };
    globalThis.document = { body, documentElement: {}, readyState: 'complete',
        querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
        addEventListener() {}, removeEventListener() {} };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    return {
        live, stored, writes, context, stores, pm,
        listenerCount: () => [...events.values()].reduce((count, handlers) => count + handlers.size, 0),
        emit: event => { for (const handler of events.get(event) || []) handler(); },
    };
}
