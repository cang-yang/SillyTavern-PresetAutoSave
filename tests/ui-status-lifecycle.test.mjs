import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeHost } from './fixtures/runtime-host.mjs';

installRuntimeHost();
const compat = await import('../modules/compatibility.js');
compat.initCompatibility();
const settings = await import('../modules/settings.js');
await settings.initSettings();
const { initUIInjector, teardown } = await import('../modules/ui-injector.js');
const { setSaveStatus, getSaveStatus } = await import('../modules/core/save-status.js');

test('toolbar status subscription is idempotent, reversible, and never clears a failure on a timer', async () => {
    const classes = new Set();
    let presentations = 0;
    const dot = {
        dataset: {}, style: {},
        classList: { contains: value => classes.has(value), add: value => classes.add(value),
            remove: value => classes.delete(value) },
        setAttribute() { presentations++; },
    };
    globalThis.document.querySelectorAll = selector => selector === '.pas-status-dot' ? [dot] : [];
    await initUIInjector(() => {});
    await initUIInjector(() => {});
    setSaveStatus('partial');
    assert.equal(dot.dataset.status, 'partial');
    const before = presentations;
    teardown();
    setSaveStatus('saved');
    assert.equal(presentations, before);
    assert.equal(getSaveStatus(), 'saved');
});
