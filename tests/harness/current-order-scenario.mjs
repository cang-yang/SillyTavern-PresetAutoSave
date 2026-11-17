import { batchUpdate, getSettings } from '../../modules/settings.js';
import { initPresetTakeover, teardown } from '../../modules/preset-takeover.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function exerciseCurrentPresetOrder({ nested = false, expand = false } = {}) {
    const select = document.querySelector('.pas-harness-native-select');
    const originalOptions = Array.from(select.options, option => option.cloneNode(true));
    const originalValue = select.value;
    const settings = getSettings();
    const saved = Object.fromEntries(['groupingEnabled', 'takeoverEnabled', 'nestingEnabled',
        'groupingTree', 'groupingManualOverrides', 'takeoverDefaultExpand'].map(key => [key, structuredClone(settings[key])]));
    const names = ['Alpha v1.0', 'Beta v1.0', 'Parent v1.0', 'Zulu v3.0', 'Zulu v1.0'];
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const rootKey = panel => panel.firstElementChild.getAttribute('data-series-key')
        || panel.firstElementChild.getAttribute('data-preset-name');
    try {
        select.replaceChildren(...names.map((name, index) => new Option(name, String(index))));
        select.value = '4';
        batchUpdate({ groupingEnabled: true, takeoverEnabled: true, nestingEnabled: nested,
            groupingTree: nested ? { zulu: 'parent', beta: 'parent' } : {},
            groupingManualOverrides: {}, takeoverDefaultExpand: expand });
        await initPresetTakeover();
        const wrapper = select.closest('.pas-dd-wrapper');
        const trigger = wrapper.querySelector('.pas-dd-trigger');
        const panel = wrapper.querySelector('.pas-dd-panel');
        trigger.click();
        assert(rootKey(panel) === (nested ? 'parent' : 'zulu'), 'Current root must precede alphabetical siblings');
        assert(document.activeElement.matches('.pas-dd-group--has-active, .pas-dd-item--active'), 'Initial focus must identify the current path');
        const openCurrentPath = () => {
            for (const header of panel.querySelectorAll('.pas-dd-group--has-active')) {
                if (header.getAttribute('aria-expanded') !== 'true') header.click();
            }
        };
        openCurrentPath();
        assert(panel.querySelector('.pas-dd-item').getAttribute('data-preset-name') === names[4],
            'Older current version must precede parent-owned presets and newer versions');
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        assert(document.activeElement.matches('.pas-dd-group--has-active, .pas-dd-item--active'), 'Keyboard reopening must focus current target');
        openCurrentPath();
        const next = panel.querySelector('[data-preset-name="Alpha v1.0"]');
        if (nested) next.closest('.pas-dd-group').querySelector('.pas-dd-group-header').click();
        next.click();
        await pause(80);
        trigger.click();
        assert(rootKey(panel) === (nested ? 'alpha' : names[0]), 'Reopening after a switch must immediately reprioritize the new current preset');
        assert(select.value === '0', 'Focus and reordering must not change native selection');
        assert([...select.options].every((option, index) => option.textContent === names[index] && option.value === String(index)),
            'Presentation sorting must never reorder or rename native options');
        const targets = [...panel.querySelectorAll('.pas-dd-item, .pas-dd-group-header')]
            .filter(element => element.getClientRects().length).map(element => element.getBoundingClientRect());
        assert(targets.every(rect => rect.width >= 44 && rect.height >= 44), 'Visible dropdown controls need 44px touch targets');
        assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Dropdown must not overflow the page');
        return { nested, expand, currentFirst: true, currentFocus: true, switchedFirst: true, touchTargets: true, noOverflow: true };
    } finally {
        await teardown();
        select.replaceChildren(...originalOptions);
        select.value = originalValue;
        batchUpdate(saved);
    }
}
