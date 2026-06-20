import test from 'node:test';
import assert from 'node:assert/strict';
import { DragHoverExpander } from '../modules/core/drag-hover-expander.js';

test('hover expansion fires once after the configured delay', () => {
    const jobs = [];
    const expander = new DragHoverExpander({
        delay: 450,
        setTimer: (callback, delay) => (jobs.push({ callback, delay }), jobs.length - 1),
        clearTimer: id => { jobs[id].cancelled = true; },
    });
    const expanded = [];
    expander.schedule('child', key => expanded.push(key));
    expander.schedule('child', key => expanded.push(`duplicate:${key}`));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].delay, 450);
    jobs[0].callback();
    assert.deepEqual(expanded, ['child']);
});

test('leaving a target or ending a drag cancels pending expansion', () => {
    const jobs = [];
    const expander = new DragHoverExpander({
        setTimer: callback => (jobs.push({ callback }), jobs.length - 1),
        clearTimer: id => { jobs[id].cancelled = true; },
    });
    expander.schedule('a', () => assert.fail('cancelled callback ran'));
    expander.schedule('b', () => assert.fail('cancelled callback ran'));
    expander.cancel('a');
    expander.cancelAll();
    assert.deepEqual(jobs.map(job => job.cancelled), [true, true]);
});

test('timer dependencies are invoked without the expander as their receiver', () => {
    let receiver;
    const expander = new DragHoverExpander({
        setTimer: function () { receiver = this; return 1; },
        clearTimer: () => {},
    });
    expander.schedule('target', () => {});
    assert.equal(receiver, undefined);
});
