async (page) => {
    const results = [];
    for (const theme of ['dark', 'light']) {
        for (const [width, height] of [[1280, 900], [768, 900], [390, 844], [360, 800]]) {
            await page.setViewportSize({ width, height });
            await page.goto(`http://127.0.0.1:4173/tests/harness/?theme=${theme}`);
            await page.waitForFunction(() => window.__PAS_HARNESS__?.ready);
            const history = await page.evaluate(async () => {
                const harness = window.__PAS_HARNESS__;
                const select = document.querySelector('.pas-harness-native-select');
                select.selectedIndex = 3;
                const currentName = select.options[3].textContent;
                await harness.remount();
                const firstGroup = document.querySelector('.pas-history-list > .pas-series-group')
                    || document.querySelector('.pas-series-group');
                const firstVersion = document.querySelector('.pas-version-group');
                if (!firstGroup?.classList.contains('pas-series-current-node')
                    || firstVersion?.getAttribute('data-preset-name') !== currentName) {
                    throw new Error('History current group/path/version is not first');
                }
                return { currentName, audit: harness.audit() };
            });
            if (!history.audit.passed) throw new Error(JSON.stringify(history.audit));
            await page.screenshot({ path: `output/playwright/current-first-${theme}-${width}.png` });
            await page.locator('[data-view="flat"]').click();
            await page.waitForFunction(() => document.querySelector('.pas-preset-group')?.classList.contains('pas-preset-current'));
            await page.locator('[data-view="series"]').click();
            await page.waitForFunction(() => document.querySelector('.pas-version-group')?.classList.contains('pas-version-current'));
            const dropdown = await page.evaluate(async () => {
                const { exerciseCurrentPresetOrder } = await import('./current-order-scenario.mjs');
                return [await exerciseCurrentPresetOrder(), await exerciseCurrentPresetOrder({ nested: true }),
                    await exerciseCurrentPresetOrder({ nested: true, expand: true })];
            });
            const metrics = await page.evaluate(() => window.__PAS_HARNESS__.collectMetrics());
            if (metrics.consoleErrors?.length) throw new Error(JSON.stringify(metrics.consoleErrors));
            await page.evaluate(async () => {
                const { batchUpdate } = await import('../../modules/settings.js');
                const { initPresetTakeover } = await import('../../modules/preset-takeover.js');
                batchUpdate({ takeoverEnabled: true });
                await initPresetTakeover();
            });
            await page.locator('.pas-dd-trigger').click();
            await page.screenshot({ path: `output/playwright/current-first-dropdown-${theme}-${width}.png` });
            await page.locator('.pas-dd-panel').press('Escape');
            await page.evaluate(async () => {
                await (await import('../../modules/preset-takeover.js')).teardown();
                (await import('../../modules/settings.js')).batchUpdate({ takeoverEnabled: false });
            });
            results.push({ theme, width, height, history, dropdown });
        }
    }
    await page.evaluate(value => { window.__PAS_CURRENT_ORDER_RESULTS__ = value; }, results);
}
