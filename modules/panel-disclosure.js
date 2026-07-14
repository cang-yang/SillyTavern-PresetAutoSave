/**
 * Update one rendered disclosure without rebuilding its surrounding list.
 * Visual, DOM visibility, and assistive state move as one operation so callers
 * cannot leave the control announcing a state that contradicts its body.
 */
export function setDisclosureExpanded(group, body, expanded, {
    headerSelector,
    chevronSelector = null,
    iconSelector = null,
} = {}) {
    if (!group || !body || !headerSelector) {
        throw new TypeError('setDisclosureExpanded requires a group, body, and headerSelector');
    }

    const header = group.querySelector(`:scope > ${headerSelector}`);
    if (!header) throw new Error(`Disclosure header not found: ${headerSelector}`);

    body.hidden = !expanded;
    header.setAttribute('aria-expanded', String(expanded));

    const chevron = chevronSelector ? group.querySelector(chevronSelector) : null;
    chevron?.classList.toggle('fa-chevron-down', expanded);
    chevron?.classList.toggle('fa-chevron-right', !expanded);

    const icon = iconSelector ? group.querySelector(iconSelector) : null;
    icon?.classList.toggle('fa-folder-open', expanded);
    icon?.classList.toggle('fa-folder', !expanded);
}
