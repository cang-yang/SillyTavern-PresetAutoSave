import { getMenuNavigationIndex } from './core/menu-navigation.js';

const MANAGER_FOCUSABLE = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

let activeMenu = null;
let nextMenuId = 1;

function nextManagerControl(trigger, backwards) {
    const root = trigger.closest?.('.pas-gm-popup');
    if (!root) return trigger;
    const controls = [...root.querySelectorAll(MANAGER_FOCUSABLE)].filter(element => (
        !element.hidden && element.getAttribute('aria-hidden') !== 'true'
        && !element.closest?.('[hidden], [aria-hidden="true"]')
        && (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0)
    ));
    const index = controls.indexOf(trigger);
    if (index < 0) return trigger;
    return controls[index + (backwards ? -1 : 1)] || trigger;
}

function positionMenu(menu, trigger, windowRef) {
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth || 180;
    const height = menu.offsetHeight || 130;
    const viewportWidth = windowRef.innerWidth || 0;
    const viewportHeight = windowRef.innerHeight || 0;
    const left = Math.max(8, Math.min(rect.left - width, viewportWidth - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, viewportHeight - height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

export function closeGroupManagerContextMenu({ restoreFocus = false } = {}) {
    if (!activeMenu) return false;
    const { documentRef, menu, trigger, onPointerDown } = activeMenu;
    activeMenu = null;
    documentRef.removeEventListener('pointerdown', onPointerDown, true);
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (restoreFocus && trigger.isConnected !== false) {
        queueMicrotask(() => trigger.focus());
    }
    return true;
}

/**
 * Open one semantic action menu for a group-manager trigger.
 * Labels are assigned with textContent; callers retain all domain behavior.
 */
export function openGroupManagerContextMenu({
    trigger,
    items,
    onSelect,
    onError = () => {},
    documentRef = document,
    windowRef = window,
}) {
    if (!trigger || !Array.isArray(items)) throw new TypeError('A trigger and menu items are required');
    if (activeMenu?.trigger === trigger) {
        closeGroupManagerContextMenu({ restoreFocus: true });
        return null;
    }
    closeGroupManagerContextMenu();

    const menu = documentRef.createElement('div');
    menu.id = `pas-gm-context-menu-${nextMenuId++}`;
    menu.className = 'pas-gm-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', trigger.getAttribute('aria-label') || 'Actions');
    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';

    for (const item of items) {
        if (item.separatorBefore) {
            const separator = documentRef.createElement('div');
            separator.className = 'pas-gm-ctx-separator';
            separator.setAttribute('role', 'separator');
            menu.append(separator);
        }

        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'pas-gm-ctx-item';
        if (item.danger) button.classList.add('pas-gm-ctx-item-danger');
        if (item.disabled) button.classList.add('pas-gm-action-disabled');
        button.dataset.action = item.action;
        button.setAttribute('role', 'menuitem');
        button.tabIndex = -1;
        button.disabled = Boolean(item.disabled);
        if (item.title) button.title = item.title;

        const icon = documentRef.createElement('i');
        icon.className = item.iconClass;
        icon.setAttribute('aria-hidden', 'true');
        const label = documentRef.createElement('span');
        label.textContent = item.label;
        button.append(icon, label);
        menu.append(button);
    }

    documentRef.body.append(menu);
    positionMenu(menu, trigger, windowRef);
    menu.style.visibility = '';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', menu.id);

    const enabledItems = [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const focusItem = index => {
        enabledItems.forEach((item, itemIndex) => { item.tabIndex = itemIndex === index ? 0 : -1; });
        enabledItems[index]?.focus();
    };

    menu.addEventListener('keydown', event => {
        const currentIndex = Math.max(0, enabledItems.indexOf(documentRef.activeElement));
        const targetIndex = getMenuNavigationIndex(event.key, currentIndex, enabledItems.length);
        if (targetIndex !== null) {
            event.preventDefault();
            focusItem(targetIndex);
            return;
        }
        switch (event.key) {
        case 'Escape':
            event.preventDefault();
            closeGroupManagerContextMenu({ restoreFocus: true });
            break;
        case 'Tab': {
            event.preventDefault();
            const target = nextManagerControl(trigger, event.shiftKey);
            closeGroupManagerContextMenu();
            queueMicrotask(() => target?.focus());
            break;
        }
        default:
            break;
        }
    });

    menu.addEventListener('click', event => {
        const item = event.target.closest?.('[role="menuitem"]:not([disabled])');
        if (!item || !menu.contains(item)) return;
        const action = item.dataset.action;
        closeGroupManagerContextMenu();
        Promise.resolve(onSelect?.(action)).catch(onError);
    });

    const onPointerDown = event => {
        if (!menu.contains(event.target) && event.target !== trigger) {
            closeGroupManagerContextMenu({ restoreFocus: true });
        }
    };
    activeMenu = { documentRef, menu, trigger, onPointerDown };
    documentRef.addEventListener('pointerdown', onPointerDown, true);
    focusItem(0);
    return menu;
}
