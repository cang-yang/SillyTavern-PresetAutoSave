// Playwright CLI run-code --filename=tests/harness/tauritavern-command-acceptance.mjs
// Attach to the user's backed-up Tauri WebView; select an explicitly disposable
// PAS-QA-* copy first. Never run against an original preset.
async page => {
    if (!page.url().startsWith('http://tauri.localhost/')) throw new Error('Expected actual TauriTavern');
    await page.evaluate(async () => {
        const base = '/scripts/extensions/third-party/SillyTavern-PresetAutoSave/modules/';
        const [auto, compat, history] = await Promise.all([
            import(base + 'auto-save.js'), import(base + 'compatibility.js'), import(base + 'history-store.js'),
        ]);
        const target = auto.getCurrentTracking();
        if (target.apiId !== 'openai' || !target.presetName?.startsWith('PAS-QA-')) {
            throw new Error('Select a disposable PAS-QA-* preset before testing');
        }
        window.pasQA = { auto, compat, history, target, commands: [] };
    });
    const drawer = page.getByRole('button', { name: 'AI响应配置', exact: true });
    if (await drawer.getAttribute('aria-expanded') !== 'true') await drawer.click();
    const identifier = await page.locator('.completion_prompt_manager_prompt').nth(2).getAttribute('data-pm-identifier');
    const row = page.locator(`.completion_prompt_manager_prompt[data-pm-identifier="${identifier}"]`).first();
    const toggle = row.locator('.prompt-manager-toggle-action');
    const saved = () => page.evaluate(() => pasQA.auto.getCurrentTracking().stats.saved);
    const enabled = () => page.evaluate(id => pasQA.compat.getLivePresetSnapshot().prompt_order
        .find(group => group.character_id === 100001).order.find(item => item.identifier === id).enabled, identifier);
    const verify = async (label, edit, expected) => {
        const before = await saved();
        await edit();
        await page.waitForFunction(count => pasQA.auto.getCurrentTracking().stats.saved > count, before, { timeout: 8000 });
        const result = await page.evaluate(async ({ identifier, expected }) => {
            const snapshots = await pasQA.history.getSnapshots('openai', pasQA.target.presetName);
            const snapshot = snapshots[0];
            const actual = typeof expected === 'boolean'
                ? snapshot?.preset.prompt_order.find(group => group.character_id === 100001)
                    .order.find(item => item.identifier === identifier)?.enabled
                : snapshot?.preset.prompts.find(item => item.identifier === identifier)?.content;
            return { matches: actual === expected, status: snapshot?.saveStatus, trigger: snapshot?.trigger };
        }, { identifier, expected });
        if (!result.matches || result.status !== 'committed' || result.trigger !== 'auto') {
            throw new Error(`${label}: history did not commit the requested edit: ${JSON.stringify(result)}`);
        }
        return { label, ...result };
    };
    const results = [];
    const cdp = await page.context().newCDPSession(page);
    const tap = async locator => {
        await locator.scrollIntoViewIfNeeded();
        const bounds = await locator.boundingBox();
        if (!bounds) throw new Error('Touch control is not visible');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
            touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    try {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        results.push(await verify('mouse toggle', () => toggle.click(), !(await enabled())));
        for (const key of ['Enter', 'Space']) {
            results.push(await verify(`keyboard ${key}`, async () => {
                await toggle.focus();
                await page.keyboard.press(key);
            }, !(await enabled())));
        }
        for (const [width, height] of [[390, 844], [360, 800]]) {
            await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
            results.push(await verify(`touch ${width}x${height}`, () => tap(toggle), !(await enabled())));
        }
        const beforeOpen = await saved();
        await tap(row.locator('[data-preset-prompt-action=edit]'));
        await page.waitForTimeout(1000);
        if (await saved() !== beforeOpen) throw new Error('Opening the editor created a save');
        const marker = `PAS actual Tauri acceptance ${Date.now()}`;
        await page.locator('#completion_prompt_manager_popup .cm-content').fill(marker);
        results.push(await verify('touch editor commit', () => tap(
            page.locator('#completion_prompt_manager_popup_entry_form_save')), marker));
        await tap(row.locator('[data-preset-prompt-action=edit]'));
        const beforeUnchanged = await saved();
        await tap(page.locator('#completion_prompt_manager_popup_entry_form_save'));
        await page.waitForTimeout(2200);
        if (await saved() !== beforeUnchanged) throw new Error('Unchanged editor commit created a save');
        const beforeNoise = await saved();
        await page.evaluate(() => {
            const context = SillyTavern.getContext();
            for (let index = 0; index < 20; index++) context.eventSource.emit(context.event_types.SETTINGS_UPDATED);
        });
        await page.waitForTimeout(2500);
        if (await saved() !== beforeNoise) throw new Error('Ambient notifications created a save');
        return { results, unchangedWrites: 0, ambientWrites: 0, marker,
            finalEnabled: await enabled(), target: await page.evaluate(() => pasQA.target.presetName) };
    } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await cdp.detach();
    }
}
