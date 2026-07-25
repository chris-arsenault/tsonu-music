import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Bundles an AudioWorklet processor into a single import-free script.
 *
 * `audioWorklet.addModule` cannot load what Vite's worker pipeline serves in development. That path
 * bundles for a production build but serves an unbundled ES module in dev, whose first line imports
 * Vite's HMR client — a module that reaches for `window`, which an `AudioWorkletGlobalScope` does not
 * have. Chrome does not support static imports inside a worklet either. The result was that audio
 * analysis worked in a production build and silently failed under `pnpm dev`: the tap caught the
 * error, reported itself flatlined, and every feature stayed at zero while rendering carried on.
 *
 * A worklet is not a worker, so it goes through its own path rather than borrowing one whose dev and
 * build behaviour differ. esbuild produces the same self-contained script either way.
 */

const SUFFIX = '?audio-worklet';
const DEV_PREFIX = '/@audio-worklet/';

async function bundleWorklet(entry: string): Promise<string> {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        target: 'es2022',
        platform: 'browser',
        // A worklet has no module graph of its own: everything it uses has to be inlined.
        external: [],
    });

    return result.outputFiles[0].text;
}

export function audioWorklet(): Plugin {
    /** Dev-only: bundled scripts by the URL the middleware serves them at. */
    const served = new Map<string, string>();
    let config: ResolvedConfig;

    return {
        name: 'tsonu-audio-worklet',
        // Ahead of Vite's own asset and worker handling, so the query is ours to interpret.
        enforce: 'pre',

        configResolved(resolved) {
            config = resolved;
        },

        async resolveId(source, importer) {
            if (!source.endsWith(SUFFIX)) {
                return null;
            }

            const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, {
                skipSelf: true,
            });

            return resolved ? `${resolved.id}${SUFFIX}` : null;
        },

        async load(id) {
            if (!id.endsWith(SUFFIX)) {
                return null;
            }

            const entry = id.slice(0, -SUFFIX.length);
            const code = await bundleWorklet(entry);

            if (config.command === 'build') {
                const reference = this.emitFile({
                    type: 'asset',
                    name: 'analysis-worklet.js',
                    source: code,
                });

                return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
            }

            // Content-addressed, so editing the processor changes the URL and the next `addModule`
            // fetches the new script rather than a cached one.
            const digest = createHash('sha256').update(code).digest('hex').slice(0, 12);
            const url = `${DEV_PREFIX}${digest}.js`;
            served.set(url, code);

            return `export default ${JSON.stringify(url)};`;
        },

        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                const url = request.url?.split('?')[0] ?? '';
                const code = served.get(url);
                if (!code) {
                    next();
                    return;
                }

                response.setHeader('Content-Type', 'text/javascript');
                // Content-addressed above, so this can be cached hard without going stale.
                response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                response.end(code);
            });
        },
    };
}
