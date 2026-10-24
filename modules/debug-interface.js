function collectPresetOptions(documentObject, logger) {
    const output = [];
    try {
        const selects = documentObject?.querySelectorAll?.('select[data-preset-manager-for]') || [];
        for (const select of selects) {
            const apiId = select.getAttribute?.('data-preset-manager-for') || '';
            const presetNames = Array.from(select?.options || [])
                .map(option => {
                    if (!option) return '';
                    const text = typeof option.textContent === 'string' ? option.textContent.trim() : '';
                    const value = typeof option.value === 'string' ? option.value : '';
                    return text || value;
                })
                .filter(Boolean);
            output.push({ apiId, count: presetNames.length, presetNames });
        }
    } catch (error) {
        logger?.warn?.('[debug.listAllOptions] failed:', error);
    }
    return output;
}

/**
 * Build the production diagnostics surface.
 *
 * Recovery data is intentionally read-only here. Destructive maintenance must
 * remain in a confirmed, transactional product workflow with rollback.
 */
export function createDebugInterface({
    version,
    env,
    logger,
    showHistoryPanel,
    refreshTakeover,
    phaseState,
    isActive,
    ensureRuntimeReady,
    listSeries,
    parsePresetName,
    groupNamesBySeries,
    listArchived,
    restoreArchives,
    reseed,
    listPanelPresets,
    documentObject = globalThis.document,
}) {
    const currentPhases = () => phaseState?.() || {};
    const mutate = action => (...args) => {
        if (!(isActive ? isActive() : currentPhases().phase1)) {
            throw new Error('Preset Auto Save runtime is inactive');
        }
        return action(...args);
    };
    const debug = Object.freeze({
        phase1Done: () => Boolean(currentPhases().phase1),
        takeoverDone: () => Boolean(currentPhases().takeover),
        phase2Done: () => Boolean(currentPhases().phase2),
        listSeries: () => listSeries(),
        forceInit: async () => {
            await ensureRuntimeReady();
            const phases = currentPhases();
            return {
                phase1: Boolean(phases.phase1),
                takeover: Boolean(phases.takeover),
                phase2: Boolean(phases.phase2),
            };
        },
        parse: name => parsePresetName(name),
        group: names => groupNamesBySeries(names || [], {}, {}),
        listAllOptions: () => collectPresetOptions(documentObject, logger),
        listArchived: () => listArchived(),
        restoreArchives: mutate(() => restoreArchives()),
        reseed: mutate(() => reseed()),
        listPanelPresets: () => listPanelPresets(),
    });

    return Object.freeze({
        version,
        ENV: env,
        showHistoryPanel,
        refreshTakeover: mutate((...args) => refreshTakeover(...args)),
        logger,
        debug,
    });
}
