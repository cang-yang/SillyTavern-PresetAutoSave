export class SaveCoordinator {
    constructor({ worker, onStateChange = () => {}, now = () => Date.now() } = {}) {
        if (typeof worker !== 'function') throw new TypeError('SaveCoordinator requires a worker');
        this.worker = worker;
        this.onStateChange = onStateChange;
        this.now = now;
        this.queue = [];
        this.running = false;
        this.closed = false;
        this.active = null;
        this.idleWaiters = [];
    }

    enqueue(request) {
        if (this.closed) return Promise.reject(new Error('SaveCoordinator is closed'));
        if (!request?.apiId) return Promise.reject(new Error('Save request requires apiId'));
        if (!request?.presetName) return Promise.reject(new Error('Save request requires presetName'));
        const snapshot = structuredClone(request);
        const promise = new Promise((resolve, reject) => {
            const entry = { request: snapshot, resolve, reject, targetKey: this.targetKey(snapshot) };
            const pendingIndex = this.queue.findIndex(item => item.targetKey === entry.targetKey);
            if (pendingIndex >= 0) {
                const superseded = this.queue[pendingIndex];
                this.queue[pendingIndex] = entry;
                superseded.resolve({
                    status: 'superseded',
                    request: superseded.request,
                    supersededBy: snapshot,
                });
            } else {
                this.queue.push(entry);
            }
        });
        this.drain();
        return promise;
    }

    targetKey(request) {
        return `${request.apiId ?? ''}\u0000${request.presetName ?? ''}`;
    }

    getState() {
        return {
            status: this.closed ? 'closed' : this.running ? 'running' : 'idle',
            active: this.active,
            queued: this.queue.length,
        };
    }

    whenIdle() {
        if (!this.running && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.push(resolve));
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        const queued = this.queue.splice(0);
        for (const entry of queued) {
            entry.resolve({ status: 'cancelled', request: entry.request });
        }
        if (!this.running) {
            this.onStateChange(this.getState());
            const waiters = this.idleWaiters.splice(0);
            for (const resolve of waiters) resolve();
        }
    }

    async drain() {
        if (this.running || this.closed) return;
        this.running = true;
        this.onStateChange(this.getState());
        try {
            while (!this.closed && this.queue.length > 0) {
                const entry = this.queue.shift();
                this.active = entry.request;
                try {
                    const value = await this.worker(entry.request);
                    entry.resolve({ status: 'committed', request: entry.request, value });
                } catch (error) {
                    entry.resolve({ status: 'failed', request: entry.request, error });
                }
            }
        } finally {
            this.active = null;
            this.running = false;
            this.onStateChange(this.getState());
            const waiters = this.idleWaiters.splice(0);
            for (const resolve of waiters) resolve();
        }
    }
}
