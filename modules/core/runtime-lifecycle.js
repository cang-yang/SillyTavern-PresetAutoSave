/**
 * Own readiness and stop transitions. Uncancellable host phases may finish while
 * stopping, but stop never resolves before their resources have been released.
 */
export function createRuntimeLifecycle({ initialize, cleanup }) {
    let generation = 0;
    let allowed = true;
    let ready = false;
    let starting = null;
    let stopping = null;
    let stoppedOperation = null;
    let stoppedResult = null;
    const stopOperations = new Map();

    function start({ explicit = false } = {}) {
        if (stopping) {
            return explicit ? stopping.then(() => start({ explicit: true })) : Promise.resolve(false);
        }
        if (explicit) {
            allowed = true;
            stoppedOperation = null;
            stoppedResult = null;
        }
        if (!allowed) return Promise.resolve(false);
        if (ready) return Promise.resolve(true);
        if (starting) return starting;
        const current = ++generation;
        const isCurrent = () => allowed && current === generation;
        const operation = (async () => {
            try {
                const initialized = await initialize(isCurrent);
                ready = isCurrent() && initialized === true;
                if (!ready && isCurrent()) await cleanup();
                return ready;
            } catch (error) {
                if (isCurrent()) await cleanup();
                throw error;
            }
        })();
        starting = operation;
        operation.finally(() => {
            if (starting === operation) starting = null;
        }).catch(() => {});
        return operation;
    }

    function stop(operation = cleanup) {
        if (stopOperations.has(operation)) return stopOperations.get(operation);
        if (!stopping && !allowed && stoppedOperation === operation) return stoppedResult;
        allowed = false;
        ready = false;
        generation++;
        const pending = starting;
        const preceding = stopping;
        const stopped = (async () => {
            if (preceding) await preceding.catch(() => {});
            if (pending) await pending.catch(() => {});
            return operation();
        })();
        stopping = stopped;
        stopOperations.set(operation, stopped);
        const finish = successful => {
            stopOperations.delete(operation);
            if (stopping !== stopped) return;
            stopping = null;
            stoppedOperation = successful ? operation : null;
            stoppedResult = successful ? stopped : null;
        };
        stopped.then(
            result => finish(result !== false && result?.complete !== false && result?.settingsCleared !== false),
            () => finish(false),
        );
        return stopped;
    }

    return Object.freeze({ start, stop, isActive: () => allowed && !stopping && ready });
}
