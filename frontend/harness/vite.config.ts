import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const frontend = resolve(__dirname, '..');

/**
 * Serves the render harness for a headless browser.
 *
 * Deliberately smaller than the devlab's config: no React, no audio worklet, no public directory. The
 * harness drives `createRenderer` directly with a synthetic feature bus, so none of the audio path is
 * involved and none of it should be able to affect a measurement.
 */
export default defineConfig({
    root: __dirname,
    server: {
        port: 26011,
        host: '127.0.0.1',
        strictPort: true,
        fs: {
            // The harness imports the visualizer from `../src`, outside the Vite root.
            allow: [frontend],
        },
    },
});
