import test from 'node:test';
import assert from 'node:assert/strict';
import { openGroupManagerContextMenu, closeGroupManagerContextMenu } from '../modules/group-manager-context-menu.js';

function fixture() {
    const documentRef = {
        activeElement: null,
        listeners: new Map(),
        addEventListener(name, handler) { this.listeners.set(name, handler); },
        removeEventListener(name) { this.listeners.delete(name); },
    };
    class Element {
        constructor(tag) {
            this.tagName = tag; this.children = []; this.attributes = {};
            this.style = {}; this.dataset = {}; this.events = {};
            this.classList = { add() {} }; this.isConnected = true;
        }
        setAttribute(key, value) { this.attributes[key] = value; }
        getAttribute(key) { return this.attributes[key] || null; }
        removeAttribute(key) { delete this.attributes[key]; }
        append(...children) {
            for (const child of children) { child.parent = this; this.children.push(child); }
        }
        addEventListener(key, handler) { this.events[key] = handler; }
        querySelectorAll() { return this.children.filter(child => child.tagName === 'button' && !child.disabled); }
        closest(selector) {
            if (selector.includes('dialog')) return this.dialog || this.parent?.closest(selector) || null;
            if (selector.includes('menuitem') && this.getAttribute('role') === 'menuitem') return this;
            return null;
        }
        contains(target) { return this === target || this.children.some(child => child.contains(target)); }
        focus() { documentRef.activeElement = this; }
        remove() { this.isConnected = false; this.parent.children = this.parent.children.filter(child => child !== this); }
        getBoundingClientRect() { return { left: 100, bottom: 100 }; }
    }
    documentRef.createElement = tag => new Element(tag);
    documentRef.body = new Element('body');
    const dialog = new Element('dialog');
    const trigger = new Element('button');
    trigger.dialog = dialog;
    dialog.append(trigger);
    documentRef.body.append(dialog);
    return { documentRef, dialog, trigger };
}

test('menus remain inside their initiating native modal and release global listeners', () => {
    const { documentRef, dialog, trigger } = fixture();
    const menu = openGroupManagerContextMenu({
        trigger, items: [{ action: 'move', label: 'Move', iconClass: '' }],
        documentRef, windowRef: { innerWidth: 1280, innerHeight: 900 },
    });
    try {
        assert.equal(menu.parent, dialog);
        assert.equal(documentRef.activeElement, menu.children[0]);
        assert.equal(documentRef.listeners.has('pointerdown'), true);
    } finally {
        closeGroupManagerContextMenu();
    }
    assert.equal(documentRef.listeners.size, 0);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('completing a menu action restores its trigger when no new control took focus', async () => {
    const { documentRef, trigger } = fixture();
    const menu = openGroupManagerContextMenu({
        trigger, items: [{ action: 'copy', label: 'Copy', iconClass: '' }],
        documentRef, windowRef: { innerWidth: 1280, innerHeight: 900 },
        onSelect() { documentRef.activeElement = documentRef.body; },
    });
    menu.events.click({ target: menu.children[0] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(documentRef.activeElement, trigger);
});
