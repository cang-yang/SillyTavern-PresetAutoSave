const SCENARIOS = new Set(['ordinary', 'empty', 'performance', 'loading', 'error']);
const THEMES = new Set(['dark', 'light']);
const VIEWS = new Set(['series', 'flat']);

export function normalizeHarnessOptions(search = '') {
    const params = new URLSearchParams(String(search).replace(/^\?/, ''));
    const scenario = params.get('scenario');
    const theme = params.get('theme');
    const view = params.get('view');
    return Object.freeze({
        scenario: SCENARIOS.has(scenario) ? scenario : 'ordinary',
        theme: THEMES.has(theme) ? theme : 'dark',
        view: VIEWS.has(view) ? view : 'series',
    });
}
