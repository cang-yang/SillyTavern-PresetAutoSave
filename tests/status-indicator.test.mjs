import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyStatusIndicatorState } from '../modules/core/status-indicator.js';

function fakeDot(initialClasses = []) {
    const classes = new Set(initialClasses);
    const attributes = new Map();
    return {
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
        },
        dataset: {},
        setAttribute: (name, value) => attributes.set(name, String(value)),
        get classes() { return [...classes]; },
        get attributes() { return attributes; },
        title: '',
    };
}

test('status indicator exposes every state visually and accessibly', () => {
    const dot = fakeDot(['pas-status-dot', 'pas-status-idle', 'pas-status-pending']);

    for (const state of ['pending', 'saving', 'saved', 'error', 'idle']) {
        assert.equal(applyStatusIndicatorState(dot, state, `label:${state}`), true);
        assert.equal(dot.classList.contains(`pas-status-${state}`), true);
        assert.equal(dot.classes.filter(name => /^pas-status-(idle|pending|saving|saved|error)$/.test(name)).length, 1);
        assert.equal(dot.dataset.status, state);
        assert.equal(dot.title, `label:${state}`);
        assert.equal(dot.attributes.get('aria-label'), `label:${state}`);
    }

    assert.equal(applyStatusIndicatorState(dot, 'unknown', 'bad'), false);
    assert.equal(dot.dataset.status, 'idle');
});

test('preset indicator states are not overridden by panel-only status styling', async () => {
    const legacyCss = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const panelCss = await readFile(new URL('../styles/panel-v4.css', import.meta.url), 'utf8');

    assert.match(legacyCss, /\.pas-status-dot\[data-pas-element="status-dot"\][\s\S]*?width:\s*9px[\s\S]*?height:\s*9px/);
    for (const state of ['idle', 'pending', 'saving', 'saved', 'error']) {
        assert.match(legacyCss, new RegExp(`\\.pas-status-dot\\[data-pas-element="status-dot"\\]\\.pas-status-${state}`));
    }
    assert.doesNotMatch(panelCss, /^\.pas-status-dot\s*\{/m);
    assert.match(panelCss, /\.pas-panel-status\s*>\s*\.pas-status-dot\s*\{/);
});
