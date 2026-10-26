/** Simulate the browser capture phase, then the host's own field handler. */
export function installEditControls(host) {
    const listeners = new Map();
    const root = {
        isConnected: true,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    };
    document.querySelectorAll = selector => selector.includes('#openai_settings') ? [root] : [];
    const dispatch = (type, target, mutate, isTrusted = true) => {
        const event = { type, target, isTrusted };
        for (const handler of listeners.get(type) || []) handler(event);
        mutate?.();
    };
    return {
        change(key, value, { isTrusted = true, eventType = 'input' } = {}) {
            const target = { id: key, tagName: 'INPUT', type: 'number', closest: () => null };
            dispatch('beforeinput', target, null, isTrusted);
            dispatch(eventType, target, () => { host.live[key] = value; }, isTrusted);
        },
        listenerCount: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
    };
}
