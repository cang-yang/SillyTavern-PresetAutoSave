export class SerialTaskQueue {
    constructor() {
        this.tail = Promise.resolve();
        this.pending = 0;
    }

    run(task) {
        if (typeof task !== 'function') return Promise.reject(new TypeError('Task function is required'));
        this.pending++;
        const result = this.tail.then(task, task);
        this.tail = result.then(
            () => { this.pending--; },
            () => { this.pending--; },
        );
        return result;
    }

    async whenIdle() {
        await this.tail;
    }

    get size() {
        return this.pending;
    }
}
