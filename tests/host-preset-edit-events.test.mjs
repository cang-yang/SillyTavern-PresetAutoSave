import test from 'node:test';
import assert from 'node:assert/strict';
import { observePresetEdits } from '../modules/host/preset-edit-events.js';

class Node {
    constructor({ id = '', classes = [], tag = 'DIV', parent = null, dataset = {} } = {}) {
        Object.assign(this, { id, classes, tagName: tag, parentElement: parent, dataset, isConnected: true });
        this.listeners = new Map();
        this.children = [];
        parent?.children.push(this);
    }
    matches(selector) {
        return selector.split(',').some(raw => {
            const s = raw.trim();
            if (s === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
            if (s.startsWith('#')) return this.id === s.slice(1);
            if (s.startsWith('.')) return this.classes.includes(s.slice(1));
            return this.tagName.toLowerCase() === s;
        });
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
        return null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type, target, values = {}) {
        const event = { type, target, isTrusted: true, ...values };
        for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

function fixture(options = {}) {
    const documentObject = new Node();
    const body = new Node({ parent: documentObject });
    documentObject.body = body;
    documentObject.getElementById = id => documentObject.querySelector(`#${id}`);
    const root = new Node({ id: 'openai_settings', parent: body });
    const promptRoot = new Node({ id: 'completion_prompt_manager', parent: body });
    const popup = new Node({ id: 'completion_prompt_manager_popup', parent: body });
    const observers = [];
    documentObject.defaultView = { MutationObserver: class {
        constructor(fn) { this.fn = fn; observers.push(this); }
        observe() {}
        disconnect() { this.closed = true; }
    } };
    const state = { apiId: 'openai', presetName: 'A', preset: {
        temperature: 0.5,
        prompts: [{ identifier: 'main', content: 'before' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
        extensions: { runtime: false },
    } };
    const edits = [], errors = [];
    let captureError = null;
    let captureCount = 0;
    let sequence = 0;
    const timers = new Map();
    const adapter = observePresetEdits({
        documentObject, capture: targetOverride => {
            captureCount++;
            if (captureError) throw captureError;
            return structuredClone({ ...state, ...targetOverride });
        },
        onEdit: edit => edits.push(edit), onError: error => errors.push(error),
        schedule: (fn, delay) => { timers.set(++sequence, { fn, delay }); return sequence; },
        cancel: id => timers.delete(id),
        ...options,
    });
    const tick = () => {
        const current = [...timers].filter(([, timer]) => timer.delay === 0);
        current.forEach(([id]) => timers.delete(id));
        current.forEach(([, timer]) => timer.fn());
    };
    return { documentObject, body, root, promptRoot, popup, state, edits, errors, timers, observers, adapter, tick,
        setCaptureError: error => { captureError = error; }, captureCount: () => captureCount };
}

test('trusted native field edits are scoped; synthetic events and ambient changes grant no edit', () => {
    const f = fixture();
    const input = new Node({ id: 'temp_openai', tag: 'INPUT', parent: f.root });
    f.root.dispatch('input', input, { isTrusted: false });
    f.state.preset.temperature = 0.6;
    f.tick();
    assert.equal(f.edits.length, 0);
    f.root.dispatch('input', input);
    f.state.preset.temperature = 0.7;
    f.state.preset.extensions.runtime = true;
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.deepEqual(f.edits[0].scope, { kind: 'field', key: 'temperature' });
    assert.equal(f.edits[0].before.temperature, 0.6);
    assert.equal(f.edits[0].after.temperature, 0.7);
    f.root.dispatch('input', input);
    f.state.preset.extensions.runtime = false;
    f.tick();
    assert.equal(f.edits.length, 1);
    f.adapter.dispose();
});

test('unknown and connection controls never authorize writes', () => {
    const f = fixture();
    for (const id of ['api_key_openai', 'openai_model', 'unrelated', 'completion_prompt_manager_footer_append_prompt']) {
        const input = new Node({ id, tag: 'INPUT', parent: f.root });
        f.root.dispatch('change', input);
        f.state.preset.temperature += 0.1;
        f.tick();
    }
    assert.equal(f.edits.length, 0);
    f.adapter.dispose();
});

test('native counter and prefixed controls resolve to their actual canonical fields', () => {
    const f = fixture();
    for (const [id, key, value] of [
        ['temp_counter_openai', 'temperature', 0.9],
        ['openai_function_calling', 'function_calling', true],
        ['seed_openai', 'seed', 123],
    ]) {
        const input = new Node({ id, tag: 'INPUT', parent: f.root });
        f.state.preset[key] = typeof value === 'number' ? 0 : false;
        f.root.dispatch('input', input);
        f.state.preset[key] = value;
        f.tick();
        assert.equal(f.edits.at(-1)?.scope.key, key, id);
    }
    assert.equal(f.edits.length, 3);
    f.adapter.dispose();
});

test('other APIs map native scalar controls only to existing canonical keys', () => {
    const f = fixture();
    for (const [apiId, id, key] of [
        ['textgenerationwebui', 'temp_textgenerationwebui', 'temp'],
        ['textgenerationwebui', 'rep_pen_counter_textgenerationwebui', 'rep_pen'],
        ['kobold', 'temp', 'temp'],
        ['novel', 'temp_counter_novel', 'temperature'],
        ['novel', 'rep_pen_size_novel', 'repetition_penalty_range'],
    ]) {
        Object.assign(f.state, { apiId, preset: { [key]: 0.5, extensions: {} } });
        const input = new Node({ id, tag: 'INPUT', parent: f.root });
        f.root.dispatch('input', input);
        f.state.preset[key] = 0.8;
        f.tick();
        assert.equal(f.edits.at(-1)?.scope.key, key, id);
    }
    assert.equal(f.edits.length, 5);
    f.adapter.dispose();
});

test('popup edits are captured only on final save; opening and selecting do not grant intent', () => {
    const f = fixture();
    const row = new Node({ classes: ['completion_prompt_manager_prompt'], dataset: { pmIdentifier: 'main' }, parent: f.promptRoot });
    const edit = new Node({ classes: ['prompt-manager-edit-action'], parent: row });
    f.promptRoot.dispatch('click', edit);
    const textarea = new Node({ tag: 'TEXTAREA', id: 'completion_prompt_manager_popup_entry_form_prompt', parent: f.popup });
    f.popup.dispatch('input', textarea);
    f.state.preset.extensions.runtime = true;
    f.tick();
    assert.equal(f.edits.length, 0);
    const save = new Node({ id: 'completion_prompt_manager_popup_entry_form_save', dataset: { pmPrompt: 'main' }, parent: f.popup });
    f.popup.dispatch('click', save);
    f.state.preset.prompts[0].content = 'after';
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.deepEqual(f.edits[0].scope, { kind: 'prompt', identifier: 'main' });
    f.adapter.dispose();
});

test('quick edit is observed after its trusted blur commits the host model', () => {
    const f = fixture();
    const textarea = new Node({ tag: 'TEXTAREA', id: 'main_prompt_quick_edit_textarea', dataset: { pmPrompt: 'main' }, parent: f.root });
    f.root.dispatch('input', textarea);
    f.tick();
    assert.equal(f.edits.length, 0);
    f.root.dispatch('blur', textarea);
    f.state.preset.prompts[0].content = 'blurred';
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].scope.identifier, 'main');
    f.adapter.dispose();
});

test('toggle is semantic but passive prompt DOM mutations cannot create edits', () => {
    const f = fixture();
    const row = new Node({ classes: ['completion_prompt_manager_prompt'], dataset: { pmIdentifier: 'main' }, parent: f.promptRoot });
    const toggle = new Node({ classes: ['prompt-manager-toggle-action'], parent: row });
    f.promptRoot.dispatch('click', toggle);
    f.state.preset.prompt_order[0].order[0].enabled = false;
    f.tick();
    assert.equal(f.edits.length, 1);
    f.state.preset.prompt_order[0].order[0].enabled = true;
    f.observers.forEach(observer => observer.fn([{ type: 'childList', addedNodes: [row], removedNodes: [] }]));
    f.tick();
    assert.equal(f.edits.length, 1);
    f.adapter.dispose();
});

test('confirmed deletion is bound to the new dialog; cancellation does not retain permission', () => {
    const f = fixture();
    const footer = new Node({ classes: ['completion_prompt_manager_footer'], parent: f.promptRoot });
    const select = new Node({ id: 'completion_prompt_manager_footer_append_prompt', tag: 'SELECT', parent: footer });
    select.value = 'main';
    const remove = new Node({ classes: ['caution', 'menu_button'], parent: footer });
    f.promptRoot.dispatch('click', remove);
    const dialog = new Node({ tag: 'DIALOG', parent: f.body });
    dialog.open = true;
    const no = new Node({ classes: ['popup-button-cancel'], parent: dialog });
    const yes = new Node({ classes: ['popup-button-ok'], parent: dialog });
    f.tick();
    dialog.dispatch('click', no);
    f.state.preset.prompts[0].content = 'background';
    f.tick();
    assert.equal(f.edits.length, 0);
    dialog.open = false;
    f.promptRoot.dispatch('click', remove);
    const next = new Node({ tag: 'DIALOG', parent: f.body });
    next.open = true;
    const confirm = new Node({ classes: ['popup-button-ok'], parent: next });
    f.tick();
    dialog.dispatch('click', yes);
    assert.equal(f.edits.length, 0);
    next.dispatch('click', confirm);
    f.state.preset.prompts = [];
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].scope.identifier, 'main');
    f.adapter.dispose();
});

test('drag requires real movement and completion; a click or synthetic sort event cannot authorize order', () => {
    const f = fixture();
    const row = new Node({ classes: ['completion_prompt_manager_prompt_draggable'], parent: f.promptRoot });
    f.promptRoot.dispatch('sortupdate', row, { isTrusted: false });
    f.tick();
    assert.equal(f.edits.length, 0);
    f.promptRoot.dispatch('pointerdown', row, { clientX: 0, clientY: 0, button: 0 });
    f.documentObject.dispatch('pointermove', row, { clientX: 0, clientY: 25 });
    f.documentObject.dispatch('pointerup', row, { clientX: 0, clientY: 25 });
    f.promptRoot.dispatch('sortupdate', row, { isTrusted: false });
    f.state.preset.prompt_order[0].order.push({ identifier: 'second', enabled: true });
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].scope.kind, 'order');
    f.adapter.dispose();
});

test('target switches cancel a pending capture and disposal clears all owned resources', () => {
    const f = fixture();
    const input = new Node({ id: 'temperature', tag: 'INPUT', parent: f.root });
    f.root.dispatch('change', input);
    f.state.presetName = 'B';
    f.state.preset.temperature = 1;
    f.tick();
    assert.equal(f.edits.length, 0);
    f.root.dispatch('change', input);
    f.adapter.dispose();
    f.adapter.dispose();
    f.tick();
    assert.equal(f.edits.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.root.count() + f.promptRoot.count() + f.popup.count() + f.documentObject.count(), 0);
    assert.ok(f.observers.every(observer => observer.closed));
});

test('capture failures stay isolated and a subsequent valid edit can be captured', () => {
    const f = fixture();
    const input = new Node({ id: 'temperature', tag: 'INPUT', parent: f.root });
    f.setCaptureError(new TypeError('invalid host value'));
    assert.doesNotThrow(() => f.root.dispatch('input', input));
    assert.equal(f.errors.length, 1);
    f.setCaptureError(null);
    f.root.dispatch('input', input);
    f.state.preset.temperature = 0.9;
    f.tick();
    assert.equal(f.edits.length, 1);
    f.adapter.dispose();
});

test('root replacement rebinds narrowly and passive flush never creates permission', () => {
    const f = fixture();
    const input = new Node({ id: 'temperature', tag: 'INPUT', parent: f.root });
    const replacement = new Node({ id: 'range_block_openai', parent: f.body });
    const nextInput = new Node({ id: 'temperature', tag: 'INPUT', parent: replacement });
    f.root.isConnected = false;
    f.body.children = f.body.children.filter(node => node !== f.root);
    f.observers.forEach(observer => observer.fn([{ addedNodes: [replacement], removedNodes: [f.root] }]));
    f.root.dispatch('input', input);
    f.state.preset.temperature = 0.8;
    f.adapter.flush();
    f.tick();
    assert.equal(f.edits.length, 0);
    assert.equal(f.root.count(), 0);
    replacement.dispatch('input', nextInput);
    f.state.preset.temperature = 0.9;
    f.adapter.flush();
    f.tick();
    assert.equal(f.edits.length, 1);
    f.adapter.dispose();
    assert.equal(replacement.count(), 0);
});

test('touch drag cancels without permission and real touch completion captures only order', () => {
    const f = fixture();
    const row = new Node({ classes: ['completion_prompt_manager_prompt_draggable'], parent: f.promptRoot });
    for (const cancel of [true, false]) {
        f.promptRoot.dispatch('touchstart', row, { touches: [{ clientX: 0, clientY: 0 }] });
        f.documentObject.dispatch('touchmove', row, { touches: [{ clientX: 0, clientY: 30 }] });
        f.documentObject.dispatch(cancel ? 'touchcancel' : 'touchend', row,
            { changedTouches: [{ clientX: 0, clientY: 30 }] });
        if (!cancel) f.promptRoot.dispatch('sortupdate', row, { isTrusted: false });
        f.state.preset.prompt_order[0].order.push({ identifier: `entry-${cancel}`, enabled: true });
        f.tick();
        assert.equal(f.edits.length, cancel ? 0 : 1);
    }
    f.adapter.dispose();
});

test('moving over a prompt row without a host sort completion is not an editing command', () => {
    const f = fixture();
    const row = new Node({ classes: ['completion_prompt_manager_prompt_draggable'], parent: f.promptRoot });
    f.promptRoot.dispatch('pointerdown', row, { clientX: 0, clientY: 0, button: 0 });
    f.documentObject.dispatch('pointermove', row, { clientX: 0, clientY: 25 });
    f.documentObject.dispatch('pointerup', row, { clientX: 0, clientY: 25 });
    f.state.preset.prompt_order[0].order.push({ identifier: 'background', enabled: true });
    f.tick();
    assert.equal(f.edits.length, 0);
    f.adapter.dispose();
});

test('ambiguous confirmation dialogs cancel ownership instead of later adopting the remaining dialog', () => {
    const f = fixture();
    const reset = new Node({ id: 'prompt-manager-reset-character', parent: f.promptRoot });
    f.promptRoot.dispatch('click', reset);
    const first = new Node({ tag: 'DIALOG', parent: f.body });
    const second = new Node({ tag: 'DIALOG', parent: f.body });
    first.open = second.open = true;
    const affirmative = new Node({ classes: ['popup-button-ok'], parent: second });
    f.tick();
    first.open = false;
    f.observers.forEach(observer => observer.fn([{ addedNodes: [], removedNodes: [first] }]));
    second.dispatch('click', affirmative);
    f.state.preset.prompt_order = [];
    f.tick();
    assert.equal(f.edits.length, 0);
    f.adapter.dispose();
});

test('prompt reset directly mutates the selected definition and captures only that definition', () => {
    const f = fixture();
    const reset = new Node({ id: 'completion_prompt_manager_popup_entry_form_reset',
        dataset: { pmPrompt: 'main' }, parent: f.popup });
    f.popup.dispatch('click', reset);
    f.state.preset.prompts[0].content = 'default';
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].scope.identifier, 'main');
    f.adapter.dispose();
});

test('before-switch flush captures pending edits against the proven old live target in the same turn', () => {
    const f = fixture();
    const input = new Node({ id: 'temperature', tag: 'INPUT', parent: f.root });
    f.root.dispatch('input', input);
    f.state.preset.temperature = 0.8;
    f.state.presetName = 'B';
    f.adapter.flush({ beforeSwitch: { apiId: 'openai', presetName: 'A' } });
    f.state.preset.temperature = 0.2;
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].target.presetName, 'A');
    assert.equal(f.edits[0].after.temperature, 0.8);
    f.adapter.dispose();
});

test('range drags capture only their start and release, not every tick of a large preset', () => {
    const f = fixture();
    f.state.preset.prompts[0].content = 'x'.repeat(500_000);
    const slider = new Node({ id: 'temp_openai', tag: 'INPUT', parent: f.root });
    slider.type = 'range';
    f.root.dispatch('pointerdown', slider, { button: 0 });
    for (let index = 1; index <= 20; index++) {
        f.root.dispatch('input', slider);
        f.state.preset.temperature = index / 10;
        f.tick();
    }
    assert.equal(f.edits.length, 0);
    assert.equal(f.captureCount(), 1);
    f.root.dispatch('change', slider);
    f.tick();
    assert.equal(f.captureCount(), 2);
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].before.temperature, 0.5);
    assert.equal(f.edits[0].after.temperature, 2);
    assert.equal(f.edits[0].source, 'control-range');
    f.adapter.dispose();
});

test('keyboard range changes and text input retain distinct editing sources', () => {
    const f = fixture();
    const slider = new Node({ id: 'temp_openai', tag: 'INPUT', parent: f.root });
    slider.type = 'range';
    f.root.dispatch('input', slider);
    f.state.preset.temperature = 0.6;
    f.root.dispatch('change', slider);
    f.tick();
    assert.equal(f.edits[0]?.source, 'control-range');
    const text = new Node({ id: 'send_if_empty', tag: 'TEXTAREA', parent: f.root });
    f.state.preset.send_if_empty = '';
    f.root.dispatch('input', text);
    f.state.preset.send_if_empty = 'hello';
    f.tick();
    assert.equal(f.edits[1]?.source, 'control-text');
    f.adapter.dispose();
});

test('disabled release-only setting preserves live slider input editing', () => {
    const f = fixture({ rangeReleaseOnly: () => false });
    const slider = new Node({ id: 'temp_openai', tag: 'INPUT', parent: f.root });
    slider.type = 'range';
    f.root.dispatch('input', slider);
    f.state.preset.temperature = 0.9;
    f.tick();
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].after.temperature, 0.9);
    assert.equal(f.edits[0].source, 'control-range');
    f.adapter.dispose();
});

test('typing a large quick-edit draft captures only its host commit on blur', () => {
    const f = fixture();
    f.state.preset.prompts[0].content = 'x'.repeat(500_000);
    const text = new Node({ id: 'main_prompt_quick_edit_textarea', tag: 'TEXTAREA', parent: f.root });
    for (let index = 0; index < 20; index++) {
        f.root.dispatch('beforeinput', text);
        f.root.dispatch('input', text);
        f.tick();
    }
    assert.equal(f.captureCount(), 0, 'local drafts do not change the host preset yet');
    f.root.dispatch('blur', text);
    f.state.preset.prompts[0].content = 'committed';
    f.tick();
    assert.equal(f.captureCount(), 2);
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].after.prompts[0].content, 'committed');
    f.adapter.dispose();
});

test('popup draft text and untouched control blur never capture the full preset', () => {
    const f = fixture();
    const draft = new Node({ id: 'edit_content', tag: 'TEXTAREA', parent: f.popup });
    const untouched = new Node({ id: 'temperature', tag: 'INPUT', parent: f.root });
    for (let index = 0; index < 20; index++) {
        f.popup.dispatch('input', draft);
        f.root.dispatch('blur', untouched);
        f.tick();
    }
    assert.equal(f.captureCount(), 0);
    assert.equal(f.edits.length, 0);
    f.adapter.dispose();
});
