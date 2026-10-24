const CONTROL_SELECTOR = '.pas-dd-item, .pas-dd-group-header';
const FOCUS_CLASS = 'pas-dd-item--focused';

export function visibleDropdownControls(panel) {
    return Array.from(panel.querySelectorAll(CONTROL_SELECTOR)).filter(control => {
        if (control.getAttribute('aria-disabled') === 'true') return false;
        for (let current = control; current && current !== panel; current = current.parentElement) {
            if (current.style.display === 'none' || current.hidden) return false;
        }
        return true;
    });
}

export function focusDropdownControl(panel, direction, edge = null) {
    const controls = visibleDropdownControls(panel);
    if (!controls.length) { panel.focus?.(); return; }
    const current = controls.findIndex(control => control.classList.contains(FOCUS_CLASS));
    const index = edge === 'first' ? 0 : edge === 'last' ? controls.length - 1
        : current < 0 ? direction > 0 ? 0 : controls.length - 1
            : (current + direction + controls.length) % controls.length;
    for (const control of panel.querySelectorAll(CONTROL_SELECTOR)) {
        control.classList.remove(FOCUS_CLASS);
        control.tabIndex = -1;
    }
    controls[index].classList.add(FOCUS_CLASS);
    controls[index].tabIndex = 0;
    controls[index].focus();
    controls[index].scrollIntoView?.({ block: 'nearest' });
}

export function decorateDropdown(panel) {
    panel.tabIndex = -1;
    panel.setAttribute('role', 'group');
    for (const control of panel.querySelectorAll(CONTROL_SELECTOR)) {
        control.tabIndex = -1;
        control.setAttribute('role', 'button');
        if (control.classList.contains('pas-dd-group-header')) {
            const group = control.closest('.pas-dd-group');
            control.setAttribute('aria-expanded', String(Boolean(group?.classList.contains('pas-dd-group--open'))));
        }
    }
}

export function renderDropdownControls(panel, html, select, toggleGroup) {
    const focused = panel.contains(panel.ownerDocument?.activeElement)
        ? panel.ownerDocument.activeElement : null;
    const focusedValue = focused?.getAttribute('data-value');
    const focusedGroup = focused?.closest('.pas-dd-group')?.getAttribute('data-series-key');
    const expanded = new Set(Array.from(panel.querySelectorAll('.pas-dd-group--open'),
        group => group.getAttribute('data-series-key')));
    panel.innerHTML = html;
    decorateDropdown(panel);
    for (const group of panel.querySelectorAll('.pas-dd-group')) {
        if (expanded.has(group.getAttribute('data-series-key'))) toggleGroup(group);
    }
    const disabled = new Set(Array.from(select.options || []).filter(option => option.disabled).map(option => option.value));
    for (const item of panel.querySelectorAll('.pas-dd-item')) {
        item.setAttribute('aria-disabled', String(disabled.has(item.getAttribute('data-value'))));
    }
    if (focused) {
        const candidates = visibleDropdownControls(panel);
        const replacement = candidates.find(control => focusedValue != null
            ? control.getAttribute('data-value') === focusedValue
            : control.classList.contains('pas-dd-group-header')
                && control.closest('.pas-dd-group')?.getAttribute('data-series-key') === focusedGroup);
        if (replacement) {
            replacement.classList.add(FOCUS_CLASS);
            replacement.tabIndex = 0;
            replacement.focus();
        } else {
            focusDropdownControl(panel, 1, 'first');
        }
    }
}

export function bindPresetDropdown({
    panel, trigger, wrapper, onSelect, toggleGroup, open, close,
    documentObject = globalThis.document,
}) {
    let disposed = false;
    const activate = control => {
        if (!control || control.getAttribute('aria-disabled') === 'true') return;
        if (control.classList.contains('pas-dd-item')) {
            const value = control.getAttribute('data-value');
            if (value != null) onSelect(value);
            trigger.focus();
        } else {
            const group = control.closest('.pas-dd-group');
            if (group) toggleGroup(group);
        }
    };
    const click = event => {
        const control = event.target.closest('.pas-dd-item') || event.target.closest('.pas-dd-group-header');
        if (control) { event.stopPropagation?.(); activate(control); }
    };
    const triggerClick = event => {
        event.stopPropagation();
        if (panel.style.display === 'none') { open(); focusDropdownControl(panel, 1, 'first'); }
        else close();
    };
    const triggerKey = event => {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            open();
            focusDropdownControl(panel, 1, event.key === 'ArrowUp' ? 'last' : 'first');
        } else if (event.key === 'Escape') { close(); }
    };
    const panelKey = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            trigger.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            focusDropdownControl(panel, event.key === 'ArrowUp' ? -1 : 1,
                event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null);
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event.target.closest('.pas-dd-item') || event.target.closest('.pas-dd-group-header'));
        } else if (event.key === 'Tab') { close(); trigger.focus(); }
    };
    const outside = event => { if (!wrapper.contains(event.target)) close(); };
    const bindings = [
        [panel, 'click', click], [panel, 'keydown', panelKey],
        [trigger, 'click', triggerClick], [trigger, 'keydown', triggerKey],
        [documentObject, 'click', outside, true],
    ];
    for (const [target, event, handler, capture] of bindings) target.addEventListener(event, handler, capture);
    return () => {
        if (disposed) return;
        disposed = true;
        for (const [target, event, handler, capture] of bindings) target.removeEventListener(event, handler, capture);
    };
}
