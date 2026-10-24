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
        if (stopping) return stopping;
        if (!allowed && stoppedOperation === operation) return stoppedResult;
        allowed = false;
        ready = false;
        generation++;
        const pending = starting;
        const stopped = (async () => {
            if (pending) await pending.catch(() => {});
            return operation();
        })();
        stopping = stopped;
        stoppedOperation = operation;
        stoppedResult = stopped;
        stopped.finally(() => {
            if (stopping === stopped) stopping = null;
        }).catch(() => {});
        return stopped;
    }

    return Object.freeze({ start, stop, isActive: () => allowed && !stopping && ready });
}
