import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { audioWorklet } from '../vite-plugins/audio-worklet';

const frontend = resolve(__dirname, '..');

/**
 * Checked-in development harness for the visualizer. Its local music is ignored, and the harness is
 * never built or deployed with the public site.
 *
 * It drives `startKernel` against a plain `<audio>` element, which bypasses HLS, the playback engine,
 * the React player, and the availability gate — none of which are what you are looking at when you
 * are judging whether the picture moves.
 */
export default defineConfig({
    plugins: [audioWorklet(), react()],
    root: __dirname,
    // The kernel fetches `/masks/manifest.json` from the app's public directory, so mask-derived
    // plugins are eligible here exactly as they are in the real player.
    publicDir: resolve(frontend, 'public'),
    server: {
        // Sulion exposes the 26xxx range; catalyst-castellum sits on 26007.
        port: 26010,
        host: '0.0.0.0',
        strictPort: true,
        fs: {
            // The lab imports the visualizer from `../src`, which is outside the Vite root.
            allow: [frontend],
        },
    },
});
