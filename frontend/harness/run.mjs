/**
 * Runs the render harness in a headless browser and prints the measurements.
 *
 * No browser-automation dependency: the page computes everything itself and writes JSON into the DOM,
 * and Chromium's own `--dump-dom` hands that back. The only thing needed from outside is a browser
 * binary and a Vite server, both of which are already here.
 *
 *   node harness/run.mjs --scenes 8 --seconds 12
 */

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HARNESS_PORT = 26011;

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** The Playwright browser cache, which is present here without the Playwright package. */
function findChromium() {
    const root = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
    if (!existsSync(root)) {
        throw new Error(`no browser cache at ${root}`);
    }

    const candidates = readdirSync(root)
        .filter((entry) => entry.startsWith('chromium'))
        .sort()
        .reverse()
        .flatMap((entry) => [
            join(root, entry, 'chrome-linux64', 'chrome'),
            join(root, entry, 'chrome-linux', 'chrome'),
            join(root, entry, 'chrome-linux', 'headless_shell'),
            join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        ]);

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(`no chromium binary under ${root}`);
    }

    return found;
}

async function waitForServer(url, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // Not up yet.
        }
        await delay(250);
    }
    throw new Error(`server at ${url} did not start`);
}

const scenes = argument('scenes', '8');
const seconds = argument('seconds', '12');
const prefix = argument('prefix', 'harness');
const width = argument('width', '320');
const height = argument('height', '180');
/** Repeat the audio exactly on this period. Zero leaves it free-running. */
const period = argument('period', '0');

const server = spawn(
    'npx',
    ['vite', '--config', 'harness/vite.config.ts'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
);

let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

try {
    await waitForServer(`http://127.0.0.1:${HARNESS_PORT}/`);

    const url = `http://127.0.0.1:${HARNESS_PORT}/?scenes=${scenes}&seconds=${seconds}`
        + `&prefix=${prefix}&width=${width}&height=${height}&period=${period}`;

    const result = spawnSync(findChromium(), [
        '--headless=new',
        '--disable-gpu-sandbox',
        '--no-sandbox',
        // SwiftShader gives a conformant WebGL2 with float render targets on a machine with no GPU,
        // which is what the kernel requires and refuses to start without.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        // The page runs the renderer for many simulated seconds per scene; the default dump timeout
        // is far shorter than that.
        '--virtual-time-budget=600000',
        '--dump-dom',
        url,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

    const dom = result.stdout ?? '';
    const match = dom.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);

    if (!match) {
        console.error('no results element in the dumped DOM');
        console.error(result.stderr?.slice(0, 4000) ?? '');
        console.error(serverLog.slice(0, 2000));
        process.exit(1);
    }

    const text = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

    if (text.trim() === '') {
        console.error('the harness produced no output; it was still running when the dump was taken');
        console.error(result.stderr?.slice(0, 4000) ?? '');
        process.exit(1);
    }

    console.log(text);
} finally {
    server.kill('SIGTERM');
}
