import { batchUpdate, getSettings } from '../../modules/settings.js';
import { initPresetTakeover, teardown } from '../../modules/preset-takeover.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function exerciseTakeover({ nested = false } = {}) {
    const select = document.querySelector('.pas-harness-native-select');
    const originalOptions = Array.from(select.options, option => option.cloneNode(true));
    const originalValue = select.value;
    const originalStyle = select.getAttribute('style');
    const originalTabIndex = select.getAttribute('tabindex');
    const settings = getSettings();
    const saved = Object.fromEntries(['groupingEnabled', 'takeoverEnabled', 'nestingEnabled',
        'groupingTree', 'groupingManualOverrides', 'takeoverDefaultExpand'].map(key => [key, structuredClone(settings[key])]));
    const names = ['Alpha v1.0', 'Alpha v2.0', 'Beta v1.0', 'Beta v2.0', 'Gamma', 'Other', '123', ' A '];
    select.replaceChildren(...names.map((name, index) => new Option(name, String(index))));
    batchUpdate({ groupingEnabled: true, takeoverEnabled: true, nestingEnabled: nested,
        groupingTree: nested ? { beta: 'alpha' } : {}, groupingManualOverrides: {},
        takeoverDefaultExpand: false });
    let changes = 0;
    const onChange = () => { changes++; };
    select.addEventListener('change', onChange);
    try {
        await initPresetTakeover();
        const wrapper = select.closest('.pas-dd-wrapper');
        const trigger = wrapper.querySelector('.pas-dd-trigger');
        const panel = wrapper.querySelector('.pas-dd-panel');
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const first = document.activeElement;
        const opened = trigger.getAttribute('aria-expanded') === 'true' && panel.contains(first);
        const group = panel.querySelector('.pas-dd-group-header');
        group.focus();
        group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const expanded = group.getAttribute('aria-expanded') === 'true';
        const item = group.closest('.pas-dd-group').querySelector('.pas-dd-item');
        item.focus();
        item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const selected = select.value === item.getAttribute('data-value') && changes === 1
            && document.activeElement === trigger;
        trigger.click();
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escaped = panel.style.display === 'none' && document.activeElement === trigger;
        select.options[1].textContent = 'Changed exact option';
        await pause(1200);
        const renamed = Array.from(panel.querySelectorAll('.pas-dd-item'))
            .some(control => control.getAttribute('data-preset-name') === 'Changed exact option');
        const exactNames = ['123', ' A '].every(name => Array.from(panel.querySelectorAll('.pas-dd-item'))
            .some(control => control.getAttribute('data-preset-name') === name));
        await teardown();
        const removed = !select.closest('.pas-dd-wrapper') && select.getAttribute('style') === originalStyle
            && select.getAttribute('tabindex') === originalTabIndex && !select.dataset.pasObserved;
        await initPresetTakeover();
        const remounted = document.querySelectorAll('.pas-dd-wrapper').length === 1;
        const result = { opened, expanded, selected, escaped, renamed, exactNames, removed, remounted };
        if (Object.values(result).some(value => value !== true)) throw new Error(JSON.stringify(result));
        return result;
    } finally {
        await teardown();
        select.removeEventListener('change', onChange);
        select.replaceChildren(...originalOptions);
        select.value = originalValue;
        batchUpdate(saved);
    }
}
