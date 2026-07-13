import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getContextSafe } from '../modules/compatibility.js';

test('host context lookup fails closed without leaking global access to callers', () => {
    const previousWindow = globalThis.window;
    const previousHost = globalThis.SillyTavern;
    const context = { marker: 'host-context' };
    try {
        globalThis.window = { SillyTavern: { getContext: () => context } };
        delete globalThis.SillyTavern;
        assert.equal(getContextSafe(), context);

        globalThis.window.SillyTavern.getContext = () => { throw new Error('host unavailable'); };
        assert.equal(getContextSafe(), null);

        delete globalThis.window.SillyTavern;
        assert.equal(getContextSafe(), null);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousHost === undefined) delete globalThis.SillyTavern;
        else globalThis.SillyTavern = previousHost;
    }
});

test('runtime and UI modules obtain host context only through compatibility', async () => {
    for (const relativePath of [
        '../index.js',
        '../modules/settings.js',
        '../modules/history-panel.js',
        '../modules/panel-actions.js',
    ]) {
        const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /(?:window\.)?SillyTavern\.getContext\s*\(/, relativePath);
    }
});
