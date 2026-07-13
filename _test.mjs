import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function collectTestFiles(rootDirectory) {
    const files = [];

    async function visit(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
                files.push(path);
            }
        }
    }

    await visit(resolve(rootDirectory));
    return files;
}

async function main() {
    const tests = await collectTestFiles(resolve('tests'));
    if (tests.length === 0) {
        throw new Error('No tests matching tests/**/*.test.mjs were found');
    }

    const result = spawnSync(process.execPath, ['--test', ...tests], {
        stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entrypoint === import.meta.url) {
    await main();
}
