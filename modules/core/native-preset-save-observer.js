const UPDATE_SELECTOR = '[data-preset-manager-update], #update_oai_preset';
const INTENT_TTL_MS = 15_000;

function getRequestPayload(input, init, baseUrl) {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url) return null;

    let pathname;
    try {
        pathname = new URL(url, baseUrl).pathname;
    } catch (_) {
        return null;
    }
    if (pathname !== '/api/presets/save') return null;

    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (method !== 'POST' || typeof init?.body !== 'string') return null;

    try {
        const payload = JSON.parse(init.body);
        if (!payload?.apiId || !payload?.name || !payload?.preset) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

export function observeNativePresetSaves({
    windowObject = window,
    documentObject = document,
    onSaved,
    onError = () => {},
    shouldCapture = () => true,
    now = () => Date.now(),
} = {}) {
    if (typeof windowObject?.fetch !== 'function' || typeof documentObject?.addEventListener !== 'function') {
        return () => {};
    }

    let intent = null;
    const originalFetch = windowObject.fetch;

    const clickHandler = (event) => {
        if (event?.isTrusted === false) return;
        const button = event?.target?.closest?.(UPDATE_SELECTOR);
        if (!button) return;
        const apiId = button.id === 'update_oai_preset'
            ? 'openai'
            : button.getAttribute?.('data-preset-manager-update');
        if (!apiId) return;
        intent = { apiId, expiresAt: now() + INTENT_TTL_MS };
    };

    async function observedFetch(...args) {
        const payload = getRequestPayload(args[0], args[1], windowObject.location?.href || 'http://localhost/');
        const response = await originalFetch.apply(this, args);
        const activeIntent = intent;
        if (
            response?.ok
            && payload
            && activeIntent
            && activeIntent.expiresAt >= now()
            && activeIntent.apiId === payload.apiId
            && shouldCapture(payload)
        ) {
            intent = null;
            queueMicrotask(() => {
                Promise.resolve(onSaved?.(payload)).catch(onError);
            });
        }
        return response;
    }

    documentObject.addEventListener('click', clickHandler, true);
    windowObject.fetch = observedFetch;

    return () => {
        documentObject.removeEventListener('click', clickHandler, true);
        if (windowObject.fetch === observedFetch) windowObject.fetch = originalFetch;
        intent = null;
    };
}
