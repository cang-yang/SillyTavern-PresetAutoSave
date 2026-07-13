import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectTestFiles } from '../_test.mjs';

test('the test entrypoint discovers tracked test convention without executing unrelated scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pas-tests-'));
    try {
        await mkdir(join(root, 'core'));
        await mkdir(join(root, 'fixtures'));
        await writeFile(join(root, 'top.test.mjs'), '');
        await writeFile(join(root, 'core', 'nested.test.mjs'), '');
        await writeFile(join(root, 'database-companion.test.cjs'), '');
        await writeFile(join(root, '_e2e_test.js'), '');
        await writeFile(join(root, 'fixtures', 'helper.mjs'), '');

        const files = await collectTestFiles(root);

        assert.deepEqual(files, [
            join(root, 'core', 'nested.test.mjs'),
            join(root, 'top.test.mjs'),
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
