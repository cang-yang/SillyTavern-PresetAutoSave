// Playwright CLI: run-code --filename=tests/harness/real-host-autosave.mjs
// Requires the isolated test host, with PASRegression1101 and no older PAS loaded.
async page => {
    if (!page.url().startsWith('http://127.0.0.1:4185/')) {
        throw new Error('Only run against the isolated local test host on port 4185');
    }
    await page.evaluate(async () => {
        const base = '/scripts/extensions/third-party/PASRegression1101/modules/';
        const [compatibility, auto, history, controls, schema, native] = await Promise.all([
            import(base + 'compatibility.js'), import(base + 'auto-save.js'),
            import(base + 'history-store.js'), import(base + 'host/preset-control-contract.js'),
            import(base + 'core/preset-schema.js'), import('/scripts/openai.js'),
        ]);
        if ([...document.scripts].some(script => /third-party\/PresetAutoSave\/index/.test(script.src))) {
            throw new Error('An older global extension shadows this test');
        }
        if (compatibility.getCurrentApiId() !== 'openai' || compatibility.getSelectedPresetName() !== 'Default') {
            throw new Error('Select the isolated default Chat Completion preset first');
        }
        let checked = 0;
        for (const [key, [selector, , , connection]] of Object.entries(native.settingsToUpdate)) {
            if (!selector || selector === '#NULL_SELECTOR') continue;
            const expected = !connection && !schema.EXPORT_EXCLUDED_FIELDS.has(key) ? key : null;
            const actual = controls.resolvePresetControlField(selector.slice(1), { apiId: 'openai' });
            if (actual !== expected) throw new Error(`Native selector mismatch: ${selector} -> ${actual}, expected ${expected}`);
            checked++;
        }
        window.__PAS_REAL_HOST_QA__ = { compatibility, auto, history, checked, results: [] };
    });

    const saved = () => page.evaluate(() => window.__PAS_REAL_HOST_QA__.auto.getCurrentTracking().stats.saved);
    const commit = async (label, edit, field, expected) => {
        const before = await saved();
        const responsePromise = page.waitForResponse(response => {
            if (!response.url().endsWith('/api/presets/save') || response.request().method() !== 'POST') return false;
            const body = response.request().postDataJSON();
            return body.apiId === 'openai' && body.name === 'Default'
                && (field === 'main'
                    ? body.preset?.prompts?.find(prompt => prompt.identifier === 'main')?.content === expected
                    : body.preset?.[field] === expected);
        }, { timeout: 6000 });
        await edit();
        const response = await responsePromise;
        if (!response.ok()) throw new Error(`${label}: native save response ${response.status()}`);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && await saved() === before) await page.waitForTimeout(25);
        if (await saved() === before) throw new Error(`${label}: no completed autosave`);
        await page.evaluate(async ({ label, field, expected }) => {
            const qa = window.__PAS_REAL_HOST_QA__;
            const snapshot = (await qa.history.getSnapshots('openai', 'Default'))[0];
            const actual = field === 'main'
                ? snapshot?.preset.prompts.find(prompt => prompt.identifier === 'main')?.content
                : snapshot?.preset[field];
            if (actual !== expected) throw new Error(`${label}: history does not contain committed edit`);
            qa.results.push({ label, field, expected, committed: true });
        }, { label, field, expected });
    };

    const stream = !(await page.locator('#stream_toggle').isChecked());
    await commit('native stream checkbox', () => page.locator('#stream_toggle').setChecked(stream), 'stream_openai', stream);
    const tokens = Number(await page.locator('#openai_max_tokens').inputValue()) === 412 ? 413 : 412;
    await commit('native numeric input', () => page.locator('#openai_max_tokens').fill(String(tokens)), 'openai_max_tokens', tokens);
    const utility = page.locator('#newchat_prompt_textarea');
    if (!await utility.isVisible()) {
        await page.locator('.inline-drawer:has(#newchat_prompt_textarea) > .inline-drawer-toggle').click();
    }
    const marker = `PAS real-host acceptance ${Date.now()}`;
    await commit('native utility prompt', () => utility.fill(marker), 'new_chat_prompt', marker);
    await page.locator('.completion_prompt_manager_prompt[data-pm-identifier="main"] .prompt-manager-edit-action').click();
    await page.locator('#completion_prompt_manager_popup_entry_form_prompt').fill(`${marker} main`);
    await commit('native prompt popup submit', () => page.locator('#completion_prompt_manager_popup_entry_form_save').click(), 'main', `${marker} main`);

    const beforeNoise = await saved();
    await page.evaluate(() => {
        const context = SillyTavern.getContext();
        const live = context.getPresetManager('openai').getPresetList().settings;
        for (let index = 0; index < 20; index++) {
            live.extensions ||= {};
            live.extensions.pasRegressionAmbient = { active: index % 2 === 0 };
            context.eventSource.emit(context.event_types.SETTINGS_UPDATED);
        }
        delete live.extensions.pasRegressionAmbient;
    });
    await page.waitForTimeout(1800);
    if (await saved() !== beforeNoise) throw new Error('Background-only changes created a save');
    await page.evaluate(() => { window.__PAS_REAL_HOST_QA__.results.push({ label: 'ambient noise ignored', committed: false }); });
    await page.screenshot({ path: 'output/playwright/native-autosave-real-host.png' });
}
