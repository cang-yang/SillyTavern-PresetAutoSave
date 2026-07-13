import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function collectJavaScriptFiles(directory, base = process.cwd()) {
    const files = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...await collectJavaScriptFiles(path, base));
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(path.slice(resolve(base).length + 1).replaceAll('\\', '/'));
        }
    }
    return files.sort();
}

test('coordination checks automatically cover every production JavaScript module', async () => {
    const output = execFileSync(process.execPath, ['_check.cjs', '--list-files'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    const checked = JSON.parse(output).sort();
    const expected = ['index.js', ...await collectJavaScriptFiles(resolve('modules'))].sort();
    assert.deepEqual(checked, expected);
});
