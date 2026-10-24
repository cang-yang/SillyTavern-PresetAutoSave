import { SourceTextModule } from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const modules = new Map();
const graph = new Map();

async function discover(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...await discover(path));
        else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(path);
    }
    return files;
}

try {
    const files = [resolve(root, 'index.js'), ...await discover(resolve(root, 'modules'))];
    for (const file of files) {
        modules.set(file, new SourceTextModule(await readFile(file, 'utf8'), { identifier: file }));
    }
    for (const [file, module] of modules) {
        const dependencies = module.dependencySpecifiers.map(specifier => {
            if (!specifier.startsWith('.')) throw new Error(`Unexpected runtime dependency: ${specifier} in ${file}`);
            const target = resolve(dirname(file), specifier);
            if (!modules.has(target)) throw new Error(`Missing production module: ${specifier} in ${file}`);
            return target;
        });
        graph.set(file, dependencies);
    }
    const visited = new Set();
    const active = new Set();
    function visit(file, chain = []) {
        if (active.has(file)) throw new Error(`Circular dependency: ${[...chain, file].join(' -> ')}`);
        if (visited.has(file)) return;
        active.add(file);
        for (const dependency of graph.get(file)) visit(dependency, [...chain, file]);
        active.delete(file);
        visited.add(file);
    }
    for (const file of files) visit(file);
    // Linking validates import/re-export names, including default and namespace
    // dependencies, without evaluating any DOM or host-dependent module code.
    for (const module of modules.values()) {
        if (module.status === 'unlinked') {
            await module.link((specifier, parent) => modules.get(resolve(dirname(parent.identifier), specifier)));
        }
    }
    console.log(`Native module parse/link verified ${files.length} production files (no evaluation).`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
