import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;

export function contentTypeFor(pathname) {
    switch (extname(pathname).toLowerCase()) {
        case '.html': return 'text/html; charset=utf-8';
        case '.js':
        case '.mjs': return 'text/javascript; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.svg': return 'image/svg+xml; charset=utf-8';
        case '.png': return 'image/png';
        default: return 'application/octet-stream';
    }
}

export function resolveRequestPath(requestUrl, rootDirectory = DEFAULT_ROOT) {
    try {
        const rawPath = String(requestUrl || '/').split(/[?#]/, 1)[0];
        const decoded = decodeURIComponent(rawPath).replace(/\\/g, '/');
        if (decoded.includes('\0')) return null;
        const segments = decoded.split('/').filter(Boolean);
        if (segments.some(segment => segment === '..')) return null;

        const relativePath = decoded.endsWith('/')
            ? `${segments.join('/')}/index.html`
            : segments.join('/') || 'index.html';
        const root = resolve(rootDirectory);
        const candidate = resolve(root, relativePath);
        const fromRoot = relative(root, candidate);
        if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
        return candidate;
    } catch {
        return null;
    }
}

export function createHarnessServer({ rootDirectory = DEFAULT_ROOT } = {}) {
    return createServer(async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end('Method Not Allowed');
            return;
        }

        let filePath = resolveRequestPath(request.url, rootDirectory);
        if (!filePath) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Bad Request');
            return;
        }

        try {
            const metadata = await stat(filePath);
            if (metadata.isDirectory()) filePath = resolve(filePath, 'index.html');
            const body = await readFile(filePath);
            response.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Type': contentTypeFor(filePath),
                'Content-Length': body.byteLength,
            });
            response.end(request.method === 'HEAD' ? undefined : body);
        } catch {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not Found');
        }
    });
}

export async function startHarnessServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, rootDirectory = DEFAULT_ROOT } = {}) {
    const server = createHarnessServer({ rootDirectory });
    await new Promise((resolveStarted, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolveStarted);
    });
    return server;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entrypoint === import.meta.url) {
    const server = await startHarnessServer();
    const address = server.address();
    process.stdout.write(`Preset Auto Save harness: http://${address.address}:${address.port}/tests/harness/\n`);
}
