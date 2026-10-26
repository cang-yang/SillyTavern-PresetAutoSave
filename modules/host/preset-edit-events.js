import { FIELD_SYNONYMS, OPENAI_PRESET_FIELDS, EXPORT_EXCLUDED_FIELDS } from '../core/preset-schema.js';
import { PRESET_WATCH_SELECTORS } from '../core/preset-dom-watch.js';
import { editScopeChanged } from '../core/edit-intent.js';

const ROOTS = [...PRESET_WATCH_SELECTORS, '#completion_prompt_manager_popup'];
const ROOT_SELECTOR = ROOTS.join(',');
const EVENTS = ['beforeinput', 'input', 'change', 'blur', 'focusout', 'click',
    'pointerdown', 'touchstart', 'pointercancel', 'touchcancel'];
const DIALOGS = 'dialog[open], #dialogue_popup';
const QUICK_PROMPTS = new Map(['main', 'nsfw', 'jailbreak'].flatMap(identifier => [
    [`${identifier}_prompt`, identifier], [`${identifier}_prompt_quick_edit_textarea`, identifier],
]));
const NOVEL_ALIASES = new Map([
    ['temp', 'temperature'], ['rep_pen', 'repetition_penalty'],
    ['rep_pen_size', 'repetition_penalty_range'], ['rep_pen_slope', 'repetition_penalty_slope'],
    ['rep_pen_freq', 'repetition_penalty_frequency'], ['rep_pen_presence', 'repetition_penalty_presence'],
]);
const sameTarget = (a, b) => a?.apiId === b?.apiId && a?.presetName === b?.presetName;
const closest = (node, selector) => node?.closest?.(selector) || null;

function fieldScope(element, state) {
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element?.tagName) || element.disabled) return null;
    if (closest(element, '#completion_prompt_manager_popup')) return null;
    const promptId = QUICK_PROMPTS.get(element.id);
    if (promptId) return { kind: 'prompt', identifier: promptId, fields: ['content'] };
    const id = String(element.id || '').replace(/_counter(?=_|$)/, '').replace(/_text$/, '');
    if (state?.apiId && state.apiId !== 'openai') {
        const suffix = state.apiId === 'textgenerationwebui' ? '_textgenerationwebui'
            : state.apiId === 'novel' ? '_novel' : '';
        const nativeKey = suffix && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
        const key = state.apiId === 'novel' ? NOVEL_ALIASES.get(nativeKey) || nativeKey : nativeKey;
        const value = state.preset?.[key];
        return Object.hasOwn(state.preset || {}, key) && !EXPORT_EXCLUDED_FIELDS.has(key)
            && (value == null || ['string', 'number', 'boolean'].includes(typeof value))
            ? { kind: 'field', key } : null;
    }
    const candidates = [id, id.replace(/^openai_/, ''), id.replace(/_openai$/, '')];
    const key = candidates.map(name => FIELD_SYNONYMS.get(name) || name)
        .find(name => OPENAI_PRESET_FIELDS.has(name) && !EXPORT_EXCLUDED_FIELDS.has(name));
    if (['prompts', 'prompt_order', 'extensions'].includes(key)) return null;
    return OPENAI_PRESET_FIELDS.has(key) && !EXPORT_EXCLUDED_FIELDS.has(key)
        ? { kind: 'field', key } : null;
}

function promptAction(element, documentObject) {
    const save = closest(element, '#completion_prompt_manager_popup_entry_form_save, #completion_prompt_manager_popup_entry_form_reset');
    if (save?.dataset?.pmPrompt) return {
        scope: { kind: 'prompt', identifier: save.dataset.pmPrompt }, source: 'prompt-submit',
    };
    const row = closest(element, '.completion_prompt_manager_prompt');
    if (row?.dataset?.pmIdentifier && closest(element, '.prompt-manager-toggle-action, .prompt-manager-detach-action')) {
        return { scope: { kind: 'order', identifier: row.dataset.pmIdentifier }, source: 'prompt-order-command' };
    }
    if (closest(element, '#prompt-manager-reset-character')) {
        return { scope: { kind: 'order' }, source: 'prompt-order-reset', confirm: true };
    }
    const footer = closest(element, '.completion_prompt_manager_footer');
    if (!footer) return null;
    const identifier = documentObject.getElementById?.('completion_prompt_manager_footer_append_prompt')?.value;
    if (!identifier) return null;
    if (closest(element, '.caution')) {
        return { scope: { kind: 'prompt', identifier }, source: 'prompt-delete', confirm: true };
    }
    if (closest(element, '.fa-chain')) {
        return { scope: { kind: 'order', identifier }, source: 'prompt-append' };
    }
    // Edit/new/export/select are not edits. Import's detached file picker needs
    // an explicit host integration; its initial click grants no broad token.
    return null;
}

/**
 * Observe bounded, trusted host edits. Ambient notifications may flush an
 * existing event-turn proposal, but cannot create or extend edit permission.
 */
export function observePresetEdits({
    capture,
    onEdit,
    onError = () => {},
    documentObject = globalThis.document,
    schedule = (fn, delay) => setTimeout(fn, delay),
    cancel = id => clearTimeout(id),
    rangeReleaseOnly = () => true,
} = {}) {
    let disposed = false;
    let observer = null;
    let confirmation = null;
    let drag = null;
    const roots = new Set();
    const jqueryRoots = new Map();
    const timers = new Set();
    const pending = new Set();
    const ranges = new Map();
    const beforeInput = new WeakMap();
    const typed = new WeakSet();
    const seenEvents = new WeakSet();
    const report = error => { try { onError(error); } catch (_) {} };
    const later = (fn, delay = 0) => {
        const id = schedule(() => {
            timers.delete(id);
            if (!disposed) fn();
        }, delay);
        timers.add(id);
        return id;
    };
    const clearTimer = id => { if (id != null) { cancel(id); timers.delete(id); } };
    const read = targetOverride => {
        try {
            const state = capture?.(targetOverride);
            return state?.apiId && state?.presetName && state?.preset ? structuredClone(state) : null;
        } catch (error) { report(error); return null; }
    };
    const finish = (proposal, targetOverride) => {
        if (disposed || !pending.delete(proposal)) return;
        clearTimer(proposal.timer);
        const after = read(targetOverride);
        if (!after || !sameTarget(proposal.before, after)) return;
        try {
            if (editScopeChanged(proposal.before.preset, after.preset, proposal.scope)) {
                onEdit?.({
                    target: { apiId: after.apiId, presetName: after.presetName },
                    before: proposal.before.preset, after: after.preset,
                    scope: proposal.scope, source: proposal.source,
                });
            }
        } catch (error) { report(error); }
    };
    const propose = (action, before = read()) => {
        if (!before) return;
        const proposal = { ...action, before };
        pending.add(proposal);
        proposal.timer = later(() => finish(proposal));
    };
    const clearConfirmation = () => {
        if (!confirmation) return;
        const { dialog, handler, close, timeout } = confirmation;
        if (dialog) {
            dialog.removeEventListener('click', handler, true);
            dialog.removeEventListener('keydown', handler, true);
            dialog.removeEventListener('cancel', close, true);
            dialog.removeEventListener('close', close, true);
        }
        clearTimer(timeout);
        confirmation = null;
    };
    const attachConfirmation = () => {
        if (!confirmation || confirmation.dialog) return;
        const options = [...(documentObject.querySelectorAll?.(DIALOGS) || [])]
            .filter(dialog => !confirmation.existing.has(dialog));
        if (options.length > 1) { clearConfirmation(); return; }
        if (options.length !== 1) return;
        const dialog = options[0];
        const current = confirmation;
        current.dialog = dialog;
        current.handler = event => {
            if (event.isTrusted !== true || confirmation !== current) return;
            const affirmative = closest(event.target, '.popup-button-ok, #dialogue_popup_ok');
            const negative = closest(event.target, '.popup-button-cancel, .popup-button-close, #dialogue_popup_cancel');
            const keyboardConfirm = event.type === 'keydown' && event.key === 'Enter'
                && (event.target === dialog || affirmative);
            if ((event.type === 'click' && affirmative) || keyboardConfirm) {
                const before = read();
                const action = current.action;
                clearConfirmation();
                if (sameTarget(before, current.before)) propose(action, before);
            } else if (negative || event.key === 'Escape') clearConfirmation();
        };
        current.close = () => { if (confirmation === current) clearConfirmation(); };
        dialog.addEventListener('click', current.handler, true);
        dialog.addEventListener('keydown', current.handler, true);
        dialog.addEventListener('cancel', current.close, true);
        dialog.addEventListener('close', current.close, true);
    };
    const beginConfirmation = action => {
        clearConfirmation();
        const before = read();
        if (!before) return;
        confirmation = {
            action, before, existing: new Set(documentObject.querySelectorAll?.(DIALOGS) || []),
        };
        confirmation.timeout = later(clearConfirmation, 30_000);
        later(attachConfirmation);
    };
    const point = event => event.touches?.[0] || event.changedTouches?.[0] || event;
    const sortCompleted = event => {
        if (drag && closest(event.target, '#completion_prompt_manager_list, #completion_prompt_manager')) drag.sorted = true;
    };
    const endDrag = event => {
        const active = drag;
        if (!active) return;
        if (event?.isTrusted !== true) return;
        if (event.type.endsWith('cancel')) { stopDrag(); return; }
        if (active.finishTimer != null) return;
        active.finishTimer = later(() => {
            if (drag !== active) return;
            const proposal = { scope: { kind: 'order' }, source: 'prompt-sort', before: active.before };
            stopDrag();
            if (active.moved && active.sorted) {
                pending.add(proposal);
                finish(proposal);
            }
        });
    };
    const moveDrag = event => {
        if (!drag || event.isTrusted !== true) return;
        const position = point(event);
        if (Math.abs(position.clientX - drag.x) + Math.abs(position.clientY - drag.y) > 4) drag.moved = true;
    };
    const dragListeners = [
        ['pointermove', moveDrag], ['touchmove', moveDrag],
        ['pointerup', endDrag], ['touchend', endDrag],
        ['pointercancel', endDrag], ['touchcancel', endDrag],
    ];
    function stopDrag() {
        for (const [type, handler] of dragListeners) documentObject.removeEventListener?.(type, handler, true);
        if (drag) { clearTimer(drag.timeout); clearTimer(drag.finishTimer); }
        drag = null;
    }
    const beginDrag = event => {
        if (drag || (event.button != null && event.button !== 0)) return;
        if (!closest(event.target, '.completion_prompt_manager_prompt_draggable')) return;
        if (closest(event.target, '.prompt_manager_prompt_controls, .prompt-manager-inspect-action')) return;
        const before = read();
        if (!before) return;
        const position = point(event);
        drag = { before, x: position.clientX, y: position.clientY, moved: false };
        drag.timeout = later(stopDrag, 30_000);
        for (const [type, handler] of dragListeners) documentObject.addEventListener?.(type, handler, true);
    };
    const handle = event => {
        if (disposed || event.isTrusted !== true || seenEvents.has(event)) return;
        seenEvents.add(event);
        const element = event.target;
        if (closest(element, '.pas-panel, .pas-popup, #pas_history_btn')) return;
        if (element?.type === 'range') {
            if (event.type === 'pointercancel' || event.type === 'touchcancel') {
                ranges.delete(element);
                return;
            }
            if (!['pointerdown', 'touchstart', 'beforeinput', 'input', 'change'].includes(event.type)) return;
            if (!ranges.has(element)) {
                const before = read();
                const scope = before && fieldScope(element, before);
                if (!scope) return;
                ranges.set(element, { before, scope });
            }
            if (event.type === 'change' || (event.type === 'input' && !rangeReleaseOnly())) {
                const { before, scope } = ranges.get(element);
                ranges.delete(element);
                propose({ scope, source: 'control-range' }, before);
            }
            return;
        }
        if (event.type === 'pointerdown' || event.type === 'touchstart') {
            beginDrag(event);
            return;
        }
        if (event.type === 'click') {
            const action = promptAction(element, documentObject);
            if (action?.confirm) beginConfirmation(action);
            else if (action) propose(action);
            return;
        }
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element?.tagName) || element.disabled
            || closest(element, '#completion_prompt_manager_popup')) return;
        const blur = event.type === 'blur' || event.type === 'focusout';
        if (blur && !typed.has(element)) return;
        // Quick-edit text is a local draft until the host's blur handler commits it.
        if (QUICK_PROMPTS.has(element.id) && element.id.endsWith('_quick_edit_textarea') && !blur) {
            if (event.type === 'input') typed.add(element);
            return;
        }
        const state = read();
        if (!state) return;
        const scope = fieldScope(element, state);
        if (!scope) return;
        if (event.type === 'beforeinput') {
            beforeInput.set(element, state);
            return;
        }
        if (blur) typed.delete(element);
        else typed.add(element);
        const before = beforeInput.get(element) || state;
        beforeInput.delete(element);
        const text = element.tagName === 'TEXTAREA' || ['text', 'search'].includes(element.type);
        propose({ scope, source: blur ? 'control-blur' : text ? 'control-text' : 'control-edit' }, before);
    };
    const rebind = () => {
        const next = new Set(documentObject?.querySelectorAll?.(ROOT_SELECTOR) || []);
        for (const root of roots) {
            if (!next.has(root) || root.isConnected === false) {
                for (const element of ranges.keys()) if (root.contains?.(element)) ranges.delete(element);
                for (const type of EVENTS) root.removeEventListener(type, handle, true);
                root.removeEventListener('sortupdate', sortCompleted, true);
                jqueryRoots.get(root)?.off('sortupdate.pasPresetEdit', sortCompleted);
                jqueryRoots.delete(root);
                roots.delete(root);
            }
        }
        for (const root of next) {
            if (roots.has(root)) continue;
            roots.add(root);
            for (const type of EVENTS) root.addEventListener(type, handle, true);
            root.addEventListener('sortupdate', sortCompleted, true);
            const jquery = documentObject?.defaultView?.jQuery;
            if (typeof jquery === 'function') {
                const wrapped = jquery(root);
                wrapped.on('sortupdate.pasPresetEdit', sortCompleted);
                jqueryRoots.set(root, wrapped);
            }
        }
    };
    rebind();
    const Observer = documentObject?.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (typeof Observer === 'function' && documentObject?.body) {
        observer = new Observer(records => {
            if (disposed) return;
            if (confirmation) attachConfirmation();
            const changedRoots = records.some(record => [...(record.addedNodes || []), ...(record.removedNodes || [])]
                .some(node => node.matches?.(ROOT_SELECTOR) || node.querySelector?.(ROOT_SELECTOR)));
            if (changedRoots) rebind();
        });
        observer.observe(documentObject.body, { childList: true, subtree: true });
    }
    return Object.freeze({
        flush({ beforeSwitch } = {}) {
            // Host notifications can arrive inside its synchronous event handler.
            // Keep capture at the next task boundary; never extend its lifetime.
            if (disposed) return;
            if (beforeSwitch?.apiId && beforeSwitch?.presetName) {
                for (const [element, range] of ranges) {
                    if (!sameTarget(range.before, beforeSwitch)) continue;
                    ranges.delete(element);
                    const proposal = { ...range, source: 'control-range' };
                    pending.add(proposal);
                    finish(proposal, beforeSwitch);
                }
                for (const proposal of [...pending]) {
                    if (sameTarget(proposal.before, beforeSwitch)) finish(proposal, beforeSwitch);
                }
                return;
            }
            for (const proposal of pending) {
                if (proposal.timer == null) proposal.timer = later(() => finish(proposal));
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            clearConfirmation();
            stopDrag();
            observer?.disconnect();
            for (const root of roots) {
                for (const type of EVENTS) root.removeEventListener(type, handle, true);
                root.removeEventListener('sortupdate', sortCompleted, true);
                jqueryRoots.get(root)?.off('sortupdate.pasPresetEdit', sortCompleted);
            }
            jqueryRoots.clear();
            roots.clear();
            for (const id of timers) cancel(id);
            timers.clear();
            pending.clear();
            ranges.clear();
        },
    });
}
