import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNativePresetSaves } from '../modules/core/native-preset-save-observer.js';

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
