const SELECT_SELECTOR = 'select[data-preset-manager-for]';

export function fingerprintPresetSelect(select) {
    if (!select) return '';
    return JSON.stringify([
        select.id || '', getPresetSelectApiId(select), select.value,
        Array.from(select.options || [], option => [
            option.value, option.textContent || '', Boolean(option.disabled),
        ]),
    ]);
}

export function getPresetSelectApiId(select) {
    return (select?.getAttribute?.('data-preset-manager-for') || '')
        .split(',').map(value => value.trim()).filter(Boolean)[0] || 'openai';
}

export function readPresetInventory({ apiId = '*', documentObject = globalThis.document } = {}) {
    let selects;
    try { selects = documentObject?.querySelectorAll(SELECT_SELECTOR) || []; }
    catch (_) { return Object.freeze([]); }
    const result = [];
    const seen = new Set();
    for (const select of selects) {
        if (!select?.isConnected) continue;
        const targetApi = getPresetSelectApiId(select);
        if (apiId !== '*' && targetApi !== apiId) continue;
        for (const option of select.options || []) {
            const presetName = option.textContent || option.value || '';
            if (!presetName) continue;
            const key = JSON.stringify([targetApi, presetName]);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(Object.freeze({
                apiId: targetApi, presetName,
                hostValue: String(option.value ?? ''),
                detached: false,
            }));
        }
    }
    return Object.freeze(result);
}
