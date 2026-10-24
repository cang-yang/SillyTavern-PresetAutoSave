import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNativePresetSaves } from '../modules/host/native-preset-save-observer.js';

function createHarness({ responseOk = true } = {}) {
    const listeners = new Map();
    const calls = [];
    const documentObject = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
    };
    const originalFetch = async (...args) => {
        calls.push(args);
        return { ok: responseOk };
    };
    const windowObject = {
        fetch: originalFetch,
        location: { href: 'http://localhost:8000/' },
    };
    return { listeners, calls, documentObject, originalFetch, windowObject };
}

function updateButton(apiId = 'openai') {
    return {
        id: apiId === 'openai' ? 'update_oai_preset' : '',
        getAttribute(name) {
            return name === 'data-preset-manager-update' ? apiId : null;
        },
    };
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

test('records a successful native update click with its saved request payload', async () => {
    const harness = createHarness();
    const saved = [];
    const teardown = observeNativePresetSaves({
        windowObject: harness.windowObject,
        documentObject: harness.documentObject,
        onSaved: payload => saved.push(payload),
    });

    const button = updateButton('openai');
    harness.listeners.get('click')({ isTrusted: true, target: { closest: () => button } });
    const payload = { apiId: 'openai', name: 'Test', preset: { temperature: 0.8 } };
    await harness.windowObject.fetch('/api/presets/save', { method: 'POST', body: JSON.stringify(payload) });
    await flushMicrotasks();

    assert.deepEqual(saved, [payload]);
    teardown();
    assert.equal(harness.windowObject.fetch, harness.originalFetch);
    assert.equal(harness.listeners.has('click'), false);
});

test('ignores failed, unrelated and non-user preset saves', async () => {
    const failedHarness = createHarness({ responseOk: false });
    const saved = [];
    observeNativePresetSaves({
        windowObject: failedHarness.windowObject,
        documentObject: failedHarness.documentObject,
        onSaved: payload => saved.push(payload),
    });

    const button = updateButton('kobold');
    failedHarness.listeners.get('click')({ isTrusted: false, target: { closest: () => button } });
    await failedHarness.windowObject.fetch('/api/presets/save', {
        method: 'POST',
        body: JSON.stringify({ apiId: 'kobold', name: 'Test', preset: { temperature: 0.8 } }),
    });
    failedHarness.listeners.get('click')({ isTrusted: true, target: { closest: () => button } });
    await failedHarness.windowObject.fetch('/api/presets/save', {
        method: 'POST',
        body: JSON.stringify({ apiId: 'kobold', name: 'Test', preset: { temperature: 0.8 } }),
    });
    await flushMicrotasks();

    assert.deepEqual(saved, []);
});

test('does not consume a user intent while internal saving is active', async () => {
    const harness = createHarness();
    const saved = [];
    let internal = true;
    observeNativePresetSaves({
        windowObject: harness.windowObject,
        documentObject: harness.documentObject,
        onSaved: payload => saved.push(payload),
        shouldCapture: () => !internal,
    });

    const button = updateButton('openai');
    harness.listeners.get('click')({ isTrusted: true, target: { closest: () => button } });
    const payload = { apiId: 'openai', name: 'Test', preset: { temperature: 0.8 } };
    await harness.windowObject.fetch('/api/presets/save', { method: 'POST', body: JSON.stringify(payload) });
    internal = false;
    await harness.windowObject.fetch('/api/presets/save', { method: 'POST', body: JSON.stringify(payload) });
    await flushMicrotasks();

    assert.deepEqual(saved, [payload]);
});

test('capture observer failures cannot reject a successful native fetch', async () => {
    const harness = createHarness();
    const errors = [];
    const teardown = observeNativePresetSaves({
        windowObject: harness.windowObject, documentObject: harness.documentObject,
        shouldCapture: () => { throw new Error('observer unavailable'); },
        onError: error => errors.push(error),
    });
    harness.listeners.get('click')({ target: { closest: () => updateButton() } });
    try {
        const response = await harness.windowObject.fetch('/api/presets/save', {
            method: 'POST', body: JSON.stringify({ apiId: 'openai', name: 'Test', preset: { temperature: 1 } }),
        });
        assert.equal(response.ok, true);
        assert.equal(errors.length, 1);
    } finally { teardown(); }
});

test('observer captures request context before await and disposal suppresses late completion', async () => {
    const harness = createHarness();
    let release;
    let epoch = 1;
    const saved = [];
    harness.windowObject.fetch = () => new Promise(resolve => { release = resolve; });
    const teardown = observeNativePresetSaves({
        windowObject: harness.windowObject, documentObject: harness.documentObject,
        captureContext: () => epoch,
        onSaved: (payload, captured) => saved.push(captured),
    });
    const request = () => {
        harness.listeners.get('click')({ target: { closest: () => updateButton() } });
        return harness.windowObject.fetch('/api/presets/save', { method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'Test', preset: { temperature: 1 } }) });
    };
    const first = request();
    epoch = 2;
    release({ ok: true });
    await first;
    await flushMicrotasks();
    assert.deepEqual(saved, [1]);
    const second = request();
    teardown();
    release({ ok: true });
    await second;
    await flushMicrotasks();
    assert.deepEqual(saved, [1]);
});

test('a click during an older in-flight request cannot claim that older request', async () => {
    const harness = createHarness();
    let release;
    const saved = [];
    harness.windowObject.fetch = () => new Promise(resolve => { release = resolve; });
    const teardown = observeNativePresetSaves({
        windowObject: harness.windowObject, documentObject: harness.documentObject,
        onSaved: payload => saved.push(payload),
    });
    const older = harness.windowObject.fetch('/api/presets/save', { method: 'POST',
        body: JSON.stringify({ apiId: 'openai', name: 'Older', preset: { temperature: 1 } }) });
    harness.listeners.get('click')({ target: { closest: () => updateButton() } });
    release({ ok: true });
    await older;
    await flushMicrotasks();
    teardown();
    assert.deepEqual(saved, []);
});
