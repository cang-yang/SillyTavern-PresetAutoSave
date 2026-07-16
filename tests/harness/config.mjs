const SCENARIOS = new Set(['ordinary', 'empty', 'performance', 'loading', 'error']);
const THEMES = new Set(['dark', 'light']);
const VIEWS = new Set(['series', 'flat']);
const CATALOG_MODES = new Set(['warm', 'cold']);
const HISTORY_SIZES = new Set(['1mb', '15mb', '46mb']);

export function normalizeHarnessOptions(search = '') {
    const params = new URLSearchParams(String(search).replace(/^\?/, ''));
    const scenario = params.get('scenario');
    const theme = params.get('theme');
    const view = params.get('view');
    const catalog = params.get('catalog');
    const historySize = params.get('history');
    return Object.freeze({
        scenario: SCENARIOS.has(scenario) ? scenario : 'ordinary',
        theme: THEMES.has(theme) ? theme : 'dark',
        view: VIEWS.has(view) ? view : 'series',
        catalog: CATALOG_MODES.has(catalog) ? catalog : 'warm',
        history: HISTORY_SIZES.has(historySize) ? historySize : '46mb',
    });
}
