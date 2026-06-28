import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../modules/logger.js';
import { renderLogTab } from '../modules/panel-settings-log.js';

class FakeElement {
    constructor() {
        this.innerHTML = '';
        this.textContent = '';
        this.scrollTop = 0;
        this.scrollHeight = 0;
    }
}

test('log tab renders a bounded recent slice instead of the whole buffer', () => {
    const view = new FakeElement();
    const badge = new FakeElement();
    const root = {
        querySelector(selector) {
            if (selector === '#pas-log-view') return view;
            if (selector === '#pas-log-badge') return badge;
            return null;
        },
    };
    const panelCtx = {
        root: () => root,
        state: () => ({ log: { level: 'all', search: '', autoScroll: false } }),
    };

    logger.clearLogs();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
    for (let i = 0; i < 250; i++) {
        logger.warn(`render-limit-${i}`);
    }
    } finally {
        console.warn = originalWarn;
    }

    renderLogTab(panelCtx);

    const renderedRows = (view.innerHTML.match(/pas-log-row pas-log-row-warn/g) || []).length;
    assert.equal(renderedRows, 200);
    assert.match(view.innerHTML, /200\/250/);
    assert.equal(badge.textContent, '250');

    logger.clearLogs();
});
