/**
 * Own listeners, delayed callbacks and injected nodes for one mounted surface.
 * Disposers are idempotent and late callbacks cannot outlive the owner.
 */
export function createMountedResources() {
    let active = true;
    const disposers = new Set();
    const timers = new Set();
    const own = dispose => {
        if (!active) dispose();
        else disposers.add(dispose);
        return () => disposers.delete(dispose);
    };
    const cancel = timer => {
        if (timer === null || timer === undefined) return;
        clearTimeout(timer);
        timers.delete(timer);
    };
    return {
        get active() { return active; },
        own,
        listen(target, type, handler) {
            if (!target) return;
            const guarded = event => active ? handler(event) : undefined;
            target.addEventListener(type, guarded);
            own(() => target.removeEventListener(type, guarded));
        },
        schedule(callback, delay) {
            if (!active) return null;
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (active) callback();
            }, delay);
            timers.add(timer);
            return timer;
        },
        cancel,
        destroy() {
            if (!active) return;
            active = false;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const dispose of disposers) {
                try { dispose(); } catch (_) {}
            }
            disposers.clear();
        },
    };
}
