// Playwright CLI run-code; disposable PASRegression1101 host only.
async page => {
    const context = await page.context().browser().newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    });
    const mobile = await context.newPage();
    const errors = [];
    mobile.on('pageerror', error => errors.push(error.message));
    try {
        await mobile.goto('http://127.0.0.1:4185/');
        await mobile.waitForFunction(() => Boolean(window.__pas?.debug.phase2Done()));
        await mobile.getByTitle('AI 响应配置').tap();
        await mobile.evaluate(async () => {
            const base = '/scripts/extensions/third-party/PASRegression1101/modules/';
            const [auto, compatibility, history] = await Promise.all([
                import(base + 'auto-save.js'), import(base + 'compatibility.js'), import(base + 'history-store.js'),
            ]);
            if (compatibility.getCurrentApiId() !== 'openai' || compatibility.getSelectedPresetName() !== 'Default'
                || [...document.scripts].some(s => /third-party\/PresetAutoSave\/index/.test(s.src))) {
                throw new Error('Expected the isolated default preset and only the current test extension');
            }
            window.touchQA = { auto, compatibility, history, events: [] };
            document.querySelector('#completion_prompt_manager').addEventListener('click', event => {
                if (event.target.matches('.prompt-manager-toggle-action')) {
                    touchQA.events.push({ trusted: event.isTrusted });
                }
            }, true);
        });
        const saved = () => mobile.evaluate(() => touchQA.auto.getCurrentTracking().stats.saved);
        const commit = async (edit, predicate) => {
            const before = await saved();
            const [response] = await Promise.all([
                mobile.waitForResponse(response => {
                    if (!response.url().endsWith('/api/presets/save') || response.request().method() !== 'POST') return false;
                    const body = response.request().postDataJSON();
                    return body.apiId === 'openai' && body.name === 'Default' && predicate(body.preset);
                }, { timeout: 6000 }),
                edit(),
            ]);
            if (!response.ok()) throw new Error(`Preset write failed: ${response.status()}`);
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline && await saved() === before) await mobile.waitForTimeout(25);
            if (await saved() === before) throw new Error('No committed autosave');
        };
        const identifier = 'enhanceDefinitions';
        const toggle = mobile.locator(`.completion_prompt_manager_prompt[data-pm-identifier="${identifier}"] .prompt-manager-toggle-action`);
        const initial = await mobile.evaluate(() => touchQA.compatibility.getLivePresetSnapshot().prompt_order
            .find(group => group.character_id === 100001).order.find(entry => entry.identifier === 'enhanceDefinitions').enabled);
        for (const enabled of [!initial, initial]) {
            await commit(() => toggle.tap(), preset => preset.prompt_order
                .find(group => group.character_id === 100001).order.find(entry => entry.identifier === identifier).enabled === enabled);
            const historyEnabled = await mobile.evaluate(async () => (await touchQA.history.getSnapshots('openai', 'Default'))[0]
                .preset.prompt_order.find(group => group.character_id === 100001)
                .order.find(entry => entry.identifier === 'enhanceDefinitions').enabled);
            if (historyEnabled !== enabled) throw new Error('Toggle missing from committed history');
        }
        const forwarded = await mobile.evaluate(() => touchQA.events);
        if (forwarded.length !== 2 || forwarded.some(event => event.trusted)) throw new Error('Touch Punch forwarding was not exercised');

        const beforeOpen = await saved();
        await mobile.locator('.completion_prompt_manager_prompt[data-pm-identifier="main"] .prompt-manager-edit-action').tap();
        await mobile.waitForTimeout(500);
        if (await saved() !== beforeOpen) throw new Error('Opening an editor caused a save');
        const marker = `PAS touch acceptance ${Date.now()}`;
        await mobile.locator('#completion_prompt_manager_popup_entry_form_prompt').fill(marker);
        await commit(() => mobile.locator('#completion_prompt_manager_popup_entry_form_save').tap(),
            preset => preset.prompts.find(prompt => prompt.identifier === 'main').content === marker);
        const main = await mobile.evaluate(async () => (await touchQA.history.getSnapshots('openai', 'Default'))[0]
            .preset.prompts.find(prompt => prompt.identifier === 'main').content);
        if (main !== marker) throw new Error('Popup content missing from history');

        const beforeNoise = await saved();
        await mobile.evaluate(() => {
            const ctx = SillyTavern.getContext();
            const live = ctx.getPresetManager('openai').getPresetList().settings;
            for (let i = 0; i < 20; i++) {
                live.extensions ||= {};
                live.extensions.touchAmbientTest = i;
                ctx.eventSource.emit(ctx.event_types.SETTINGS_UPDATED);
            }
            delete live.extensions.touchAmbientTest;
        });
        await mobile.waitForTimeout(1500);
        if (await saved() !== beforeNoise) throw new Error('Ambient state created a save');
        await mobile.reload();
        await mobile.waitForFunction(() => Boolean(window.__pas?.debug.phase2Done()));
        const reloaded = await mobile.evaluate(async () => {
            const { getLivePresetSnapshot } = await import('/scripts/extensions/third-party/PASRegression1101/modules/compatibility.js');
            const preset = getLivePresetSnapshot();
            return {
                main: preset.prompts.find(prompt => prompt.identifier === 'main').content,
                enabled: preset.prompt_order.find(group => group.character_id === 100001)
                    .order.find(entry => entry.identifier === 'enhanceDefinitions').enabled,
            };
        });
        if (reloaded.main !== marker || reloaded.enabled !== initial) throw new Error('Reload did not preserve committed changes');
        if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
        return { forwarded, marker, reloaded, pageErrors: errors, commits: beforeNoise, backgroundWrites: 0 };
    } finally {
        await context.close();
    }
}
