function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

function cloneValue(value) {
    if (value == null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function normalizeHint(hint = {}) {
    return Object.freeze({
        apiId: typeof hint.apiId === 'string' && hint.apiId ? hint.apiId : null,
        presetName: typeof hint.presetName === 'string' && hint.presetName ? hint.presetName : null,
    });
}

function candidateKey(candidate) {
    return [
        candidate.apiId,
        candidate.presetName,
        candidate.liveHash,
        candidate.storedHash || '',
    ].join('\u0000');
}

function assessCandidate(candidate, hint) {
    if (!candidate || typeof candidate !== 'object') return { ready: false };
    if (typeof candidate.apiId !== 'string' || !candidate.apiId) return { ready: false };
    if (typeof candidate.presetName !== 'string' || !candidate.presetName) return { ready: false };
    if (!candidate.preset || typeof candidate.preset !== 'object') return { ready: false };
    if (typeof candidate.liveHash !== 'string' || !candidate.liveHash) return { ready: false };
    if (hint.apiId && candidate.apiId !== hint.apiId) return { ready: false };
    if (hint.presetName && candidate.presetName !== hint.presetName) return { ready: false };

    const hasStoredHash = typeof candidate.storedHash === 'string' && candidate.storedHash.length > 0;
    if (hasStoredHash && candidate.liveHash !== candidate.storedHash) {
        return { ready: false };
    }

    return {
        ready: true,
        verified: hasStoredHash,
        key: candidateKey(candidate),
    };
}

export function createPresetSwitchConvergence({
    readCandidate,
    onSettled,
    onTimeout = () => {},
    schedule = (fn, delay) => setTimeout(fn, delay),
    cancel = id => clearTimeout(id),
    now = () => Date.now(),
    intervalMs = 80,
    timeoutMs = 10_000,
    requiredStableSamples = 2,
    requiredFallbackSamples = 4,
    allowUnverifiedFallback = false,
} = {}) {
    if (typeof readCandidate !== 'function' || typeof onSettled !== 'function') {
        throw new TypeError('Preset switch convergence requires candidate and settled handlers');
    }
    if (!Number.isInteger(requiredStableSamples) || requiredStableSamples < 1) {
        throw new TypeError('requiredStableSamples must be a positive integer');
    }
    if (!Number.isInteger(requiredFallbackSamples) || requiredFallbackSamples < 1) {
        throw new TypeError('requiredFallbackSamples must be a positive integer');
    }

    let generation = 0;
    let timerId = null;
    let active = null;

    const clearTimer = () => {
        if (timerId !== null) cancel(timerId);
        timerId = null;
    };

    const finish = () => {
        clearTimer();
        active = null;
    };

    const queueSample = currentGeneration => {
        clearTimer();
        timerId = schedule(() => sample(currentGeneration), intervalMs);
    };

    const sample = async currentGeneration => {
        if (!active || active.generation !== currentGeneration) return;
        timerId = null;

        let candidate = null;
        try {
            candidate = await readCandidate(active.hint);
        } catch (_) {
            candidate = null;
        }
        if (!active || active.generation !== currentGeneration) return;

        active.lastCandidate = candidate;
        const assessment = assessCandidate(candidate, active.hint);
        if (assessment.ready && (assessment.verified || allowUnverifiedFallback)) {
            if (assessment.key === active.lastReadyKey) active.stableSamples++;
            else {
                active.lastReadyKey = assessment.key;
                active.stableSamples = 1;
            }

            const requiredSamples = assessment.verified
                ? requiredStableSamples
                : requiredFallbackSamples;
            if (active.stableSamples >= requiredSamples) {
                const settled = deepFreeze({
                    apiId: candidate.apiId,
                    presetName: candidate.presetName,
                    preset: cloneValue(candidate.preset),
                    liveHash: candidate.liveHash,
                    storedHash: candidate.storedHash || null,
                    verified: assessment.verified,
                    generation: currentGeneration,
                });
                finish();
                onSettled(settled);
                return;
            }
        } else {
            active.lastReadyKey = null;
            active.stableSamples = 0;
        }

        if (now() - active.startedAt >= timeoutMs) {
            const timeout = deepFreeze({
                generation: currentGeneration,
                hint: active.hint,
                candidate: cloneValue(active.lastCandidate),
            });
            finish();
            onTimeout(timeout);
            return;
        }

        queueSample(currentGeneration);
    };

    return Object.freeze({
        begin(hint = {}) {
            generation++;
            clearTimer();
            active = {
                generation,
                hint: normalizeHint(hint),
                startedAt: now(),
                lastCandidate: null,
                lastReadyKey: null,
                stableSamples: 0,
            };
            queueSample(generation);
            return generation;
        },
        cancel() {
            generation++;
            finish();
        },
        isActive() {
            return active !== null;
        },
    });
}
