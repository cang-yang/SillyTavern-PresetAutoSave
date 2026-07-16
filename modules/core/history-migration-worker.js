function scheduleTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer?.unref?.();
    return timer;
}

export function createHistoryMigrationWorker({
    migrateKey,
    onMigrated = () => Promise.resolve(),
    onError = () => {},
    setTimer = scheduleTimer,
    clearTimer = timer => clearTimeout(timer),
    initialDelayMs = 1_000,
    baseRetryMs = 30_000,
    maxRetryMs = 5 * 60_000,
} = {}) {
    if (typeof migrateKey !== 'function') throw new TypeError('Migration worker requires migrateKey');
    if (typeof onMigrated !== 'function') throw new TypeError('onMigrated must be a function');

    const queue = [];
    const pending = new Set();
    const retries = new Map();
    const retryTimers = new Map();
    let mainTimer = null;
    let activeOperation = null;
    let closed = false;

    function scheduleMain(delay) {
        if (closed || mainTimer !== null || queue.length === 0) return;
        mainTimer = setTimer(async () => {
            mainTimer = null;
            activeOperation = processOne();
            try {
                await activeOperation;
            } finally {
                activeOperation = null;
            }
        }, delay);
    }

    function scheduleRetry(key) {
        if (closed || !pending.has(key) || retryTimers.has(key)) return;
        const attempt = (retries.get(key) ?? 0) + 1;
        retries.set(key, attempt);
        const delay = Math.min(baseRetryMs * (2 ** (attempt - 1)), maxRetryMs);
        const timer = setTimer(() => {
            retryTimers.delete(key);
            if (closed || !pending.has(key)) return;
            queue.push(key);
            scheduleMain(0);
        }, delay);
        retryTimers.set(key, timer);
    }

    async function processOne() {
        if (closed) return;
        const key = queue.shift();
        if (!key) return;

        try {
            const result = await migrateKey(key);
            if (closed) return;
            if (result?.status === 'failed') {
                scheduleRetry(key);
            } else {
                if (Array.isArray(result?.snapshots)) {
                    await onMigrated(key, result.snapshots, result);
                }
                pending.delete(key);
                retries.delete(key);
            }
        } catch (error) {
            try {
                onError(error, { key, operation: 'background-history-migration' });
            } catch (_) {
                // Diagnostics must not interrupt migration cleanup or retry coordination.
            }
            scheduleRetry(key);
        } finally {
            scheduleMain(0);
        }
    }

    return Object.freeze({
        enqueue(keys) {
            if (closed || !Array.isArray(keys)) return;
            for (const key of keys) {
                if (typeof key !== 'string' || key === '' || pending.has(key)) continue;
                pending.add(key);
                queue.push(key);
            }
            scheduleMain(initialDelayMs);
        },

        async close() {
            closed = true;
            if (mainTimer !== null) clearTimer(mainTimer);
            mainTimer = null;
            for (const timer of retryTimers.values()) clearTimer(timer);
            retryTimers.clear();
            queue.length = 0;
            pending.clear();
            retries.clear();
            if (activeOperation) await activeOperation;
        },
    });
}
