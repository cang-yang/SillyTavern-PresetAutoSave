import test from 'node:test';
import assert from 'node:assert/strict';
import * as dropdown from '../modules/dropdown-controller.js';

function node(classes = '', parent = null) {
    const values = new Set(classes.split(' '));
    const attrs = new Map();
    const listeners = new Map();
    return {
        style: {}, parentElement: parent, tabIndex: -1, focused: false,
        classList: { contains: key => values.has(key), add: key => values.add(key), remove: key => values.delete(key) },
        setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
        focus() { this.focused = true; },
        scrollIntoView() {},
        addEventListener: (key, handler) => listeners.set(key, handler),
        removeEventListener: key => listeners.delete(key),
        contains: target => target === parent,
        closest(selector) {
            for (let current = this; current; current = current.parentElement) {
                if (current.classList?.contains(selector.slice(1))) return current;
            }
            return null;
        },
        dispatch(key, event) { listeners.get(key)?.(event); },
        listeners,
    };
}

test('keyboard navigation includes group headers and excludes deeply collapsed descendants', () => {
    const panel = node();
    const header = node('pas-dd-group-header', panel);
    const outerBody = node('pas-dd-group-body', panel);
    outerBody.style.display = 'none';
    const innerBody = node('pas-dd-group-body', outerBody);
    innerBody.style.display = 'block';
    const hiddenItem = node('pas-dd-item', innerBody);
    const visible = node('pas-dd-item', panel);
    panel.querySelectorAll = () => [header, hiddenItem, visible];
    assert.deepEqual(dropdown.visibleDropdownControls(panel), [header, visible]);
    dropdown.focusDropdownControl(panel, 1);
    assert.equal(header.focused, true);
    dropdown.focusDropdownControl(panel, 1);
    assert.equal(visible.focused, true);
});

test('one controller owns click/key/outside listeners and disposes idempotently', () => {
    const panel = node();
    const trigger = node();
    const wrapper = node();
    const documentObject = node();
    const item = node('pas-dd-item', panel);
    item.setAttribute('data-value', '17');
    panel.querySelectorAll = () => [item];
    let selected = null;
    let closed = 0;
    const teardown = dropdown.bindPresetDropdown({
        panel, trigger, wrapper, documentObject,
        onSelect: value => { selected = value; }, toggleGroup() {},
        open: () => { panel.style.display = 'block'; },
        close: () => { closed++; panel.style.display = 'none'; },
    });
    trigger.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
    assert.equal(item.focused, true);
    panel.dispatch('keydown', { key: 'Enter', target: item, preventDefault() {} });
    assert.equal(selected, '17');
    panel.dispatch('keydown', { key: 'Escape', target: item, preventDefault() {} });
    assert.equal(trigger.focused, true);
    assert.ok(closed > 0);
    teardown();
    teardown();
    assert.equal(panel.listeners.size + trigger.listeners.size + documentObject.listeners.size, 0);
});
