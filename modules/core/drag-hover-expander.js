export class DragHoverExpander {
    constructor({ delay = 450, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        this.delay = delay;
        // Browser timer functions require the global receiver in some engines.
        // Wrapping also keeps injected test schedulers from being called as methods.
        this.setTimer = (callback, ms) => setTimer(callback, ms);
        this.clearTimer = timer => clearTimer(timer);
        this.pending = new Map();
    }

    schedule(key, callback) {
        if (!key || typeof callback !== 'function' || this.pending.has(key)) return;
        const timer = this.setTimer(() => {
            this.pending.delete(key);
            callback(key);
        }, this.delay);
        this.pending.set(key, timer);
    }

    cancel(key) {
        const timer = this.pending.get(key);
        if (timer === undefined) return;
        this.clearTimer(timer);
        this.pending.delete(key);
    }

    cancelAll() {
        for (const timer of this.pending.values()) this.clearTimer(timer);
        this.pending.clear();
    }
}
