/**
 * Touch Punch dispatches its synthetic click synchronously during touchend.
 * Accept that forwarding only within the same completed, stationary gesture.
 */
export function createTouchCommandGate({ documentObject, schedule, cancel }) {
    let gesture = null;
    const listeners = [
        ['touchstart', interrupt], ['touchmove', move],
        ['touchend', end], ['touchcancel', interrupt],
    ];
    function clear() {
        if (gesture?.timer != null) cancel(gesture.timer);
        gesture = null;
        for (const [type, handler] of listeners) documentObject.removeEventListener?.(type, handler, true);
    }
    function interrupt(event) {
        if (event.isTrusted === true) clear();
    }
    const matches = point => point && point.identifier === gesture?.identifier
        && Math.abs(point.clientX - gesture.x) + Math.abs(point.clientY - gesture.y) <= 10;
    function move(event) {
        if (event.isTrusted !== true || !gesture) return;
        if (event.touches?.length !== 1 || !matches(event.touches[0])) clear();
    }
    function end(event) {
        if (event.isTrusted !== true || !gesture) return;
        if (event.target !== gesture.element || event.touches?.length !== 0
            || event.changedTouches?.length !== 1 || !matches(event.changedTouches[0])) {
            clear();
            return;
        }
        gesture.ended = true;
        cancel(gesture.timer);
        // Expire at the next task, not a permissive multi-second click window.
        gesture.timer = schedule(clear, 0);
    }
    return Object.freeze({
        begin(event, context) {
            clear();
            const point = event.touches?.[0];
            if (event.isTrusted !== true || event.touches?.length !== 1 || !point
                || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
            gesture = {
                element: event.target, identifier: point.identifier,
                x: point.clientX, y: point.clientY, context, ended: false,
                timer: schedule(clear, 30_000),
            };
            for (const [type, handler] of listeners) documentObject.addEventListener?.(type, handler, true);
        },
        consume(event) {
            const current = gesture;
            clear();
            return event.type === 'click' && current?.ended
                && current.element === event.target && current.element.isConnected !== false
                ? current.context : null;
        },
        clear,
    });
}
