export class RuntimeTimerRegistry {
    constructor({
        // Browser timer functions require the Window receiver in some engines.
        // Wrappers retain that receiver while still allowing fake clocks in tests.
        setTimeoutFn = (...args) => globalThis.setTimeout(...args),
        clearTimeoutFn = (...args) => globalThis.clearTimeout(...args),
        setIntervalFn = (...args) => globalThis.setInterval(...args),
        clearIntervalFn = (...args) => globalThis.clearInterval(...args),
    } = {}) {
        if (typeof setTimeoutFn !== 'function') throw new TypeError('setTimeoutFn is required');
        if (typeof clearTimeoutFn !== 'function') throw new TypeError('clearTimeoutFn is required');
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.handles = new Map();
    }

    schedule(callback, delay = 0) {
        if (typeof callback !== 'function') throw new TypeError('Timer callback is required');
        let handle;
        handle = this.setTimeoutFn(() => {
            this.handles.delete(handle);
            callback();
        }, delay);
        this.handles.set(handle, this.clearTimeoutFn);
        return handle;
    }

    repeat(callback, interval) {
        if (typeof callback !== 'function') throw new TypeError('Timer callback is required');
        if (typeof this.setIntervalFn !== 'function') throw new TypeError('setIntervalFn is required');
        if (typeof this.clearIntervalFn !== 'function') throw new TypeError('clearIntervalFn is required');
        const handle = this.setIntervalFn(callback, interval);
        this.handles.set(handle, this.clearIntervalFn);
        return handle;
    }

    cancel(handle) {
        const clearFn = this.handles.get(handle);
        if (!clearFn) return false;
        this.handles.delete(handle);
        clearFn(handle);
        return true;
    }

    clearAll() {
        for (const [handle, clearFn] of this.handles) clearFn(handle);
        this.handles.clear();
    }

    get size() {
        return this.handles.size;
    }
}
