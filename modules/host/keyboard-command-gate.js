/**
 * Legacy accessible controls forward Enter/Space through element.click().
 * The forwarding is valid only for the focused command in that keyboard task.
 */
export function createKeyboardCommandGate({ documentObject, schedule, cancel }) {
    let activation = null;
    function clear() {
        if (activation) cancel(activation.timer);
        activation = null;
    }
    return Object.freeze({
        begin(event, context) {
            clear();
            const element = event.target;
            const key = (event.type === 'keydown' && event.key === 'Enter')
                || (event.type === 'keyup' && event.key === ' ');
            const control = ['BUTTON', 'A'].includes(element?.tagName)
                || element?.getAttribute?.('role') === 'button';
            if (!key || !control || event.isTrusted !== true || event.repeat || event.isComposing
                || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
                || element !== documentObject.activeElement || element.disabled
                || element.getAttribute?.('aria-disabled') === 'true') return;
            activation = { element, context, timer: schedule(clear, 0) };
        },
        consume(event) {
            const current = activation;
            clear();
            return event.type === 'click' && current?.element === event.target
                && current.element === documentObject.activeElement
                && current.element.isConnected !== false ? current.context : null;
        },
        clear,
    });
}
