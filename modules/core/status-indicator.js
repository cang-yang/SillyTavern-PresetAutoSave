import { SAVE_STATUS_STATES } from './save-status.js';

export const STATUS_INDICATOR_STATES = SAVE_STATUS_STATES;

/**
 * Apply one exclusive status to a dot-like element. Keeping this DOM update
 * pure prevents styling and accessibility metadata from drifting apart.
 */
export function applyStatusIndicatorState(dot, state, label = '') {
    if (!dot?.classList || !STATUS_INDICATOR_STATES.includes(state)) return false;

    const targetClass = `pas-status-${state}`;
    const activeStates = STATUS_INDICATOR_STATES.filter(candidate =>
        dot.classList.contains(`pas-status-${candidate}`));
    if (activeStates.length !== 1 || activeStates[0] !== state) {
        for (const candidate of STATUS_INDICATOR_STATES) {
            dot.classList.remove(`pas-status-${candidate}`);
        }
        dot.classList.add(targetClass);
    }
    if (dot.dataset) dot.dataset.status = state;
    dot.title = label;
    dot.setAttribute?.('aria-label', label);
    return true;
}

export function applyStatusIndicatorPresentation(dot, state, label = '') {
    if (!applyStatusIndicatorState(dot, state, label)) return false;
    const panelLabel = dot.closest?.('.pas-panel-status')?.querySelector?.('[data-pas-status-label]');
    if (panelLabel) panelLabel.textContent = label;
    return true;
}
