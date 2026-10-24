import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function runFixture(files) {
    const root = await mkdtemp(join(tmpdir(), 'pas-module-check-'));
    try {
        await mkdir(join(root, 'modules'));
        await mkdir(join(root, 'i18n'));
        await writeFile(join(root, '_check.cjs'), await readFile(new URL('../_check.cjs', import.meta.url)));
        try {
            await writeFile(join(root, '_module-check.mjs'), await readFile(new URL('../_module-check.mjs', import.meta.url)));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await writeFile(join(root, 'style.css'), '');
        await writeFile(join(root, 'i18n/en-us.json'), '{}');
        await writeFile(join(root, 'i18n/zh-cn.json'), '{}');
        for (const [path, source] of Object.entries(files)) await writeFile(join(root, path), source);
        return spawnSync(process.execPath, [join(root, '_check.cjs')], { encoding: 'utf8' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

for (const [name, files] of [
    ['missing namespace target', { 'index.js': "import * as absent from './modules/absent.js';" }],
    ['missing default export', { 'index.js': "import missing from './modules/a.js';", 'modules/a.js': 'export const value = 1;' }],
    ['re-export cycle', {
        'index.js': "export * from './modules/a.js';",
        'modules/a.js': "export * from './b.mjs';",
        'modules/b.mjs': "export * from './a.js';",
    }],
    ['syntax in production mjs', { 'index.js': '', 'modules/broken.mjs': 'export const = ;' }],
]) {
    test(`module check rejects ${name}`, async () => {
        const result = await runFixture(files);
        assert.notEqual(result.status, 0, `${name} unexpectedly passed:\n${result.stdout}`);
    });
}

test('module check links exports without evaluating host code', async () => {
    const result = await runFixture({
        'index.js': "import value, * as ns from './modules/a.mjs'; window.unavailable();",
        'modules/a.mjs': 'export default 1; export const other = 2;',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
