import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { audioWorklet } from './vite-plugins/audio-worklet';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [audioWorklet(), react()],
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'build',
    sourcemap: true,
    // The website Terraform module publishes the OG Lambda with one ENTRY_CSS
    // value, so keep Vite's production build to a single stylesheet.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index-[hash].js',
        chunkFileNames: 'assets/chunk-[name]-[hash].js',
        // The website module detects the entry stylesheet by globbing
        // `assets/index-*.css`, so the one stylesheet has to carry that name;
        // Vite would otherwise call it `style-[hash].css` and the module would
        // publish the OG Lambda with no ENTRY_CSS at all.
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? '';
          return name.endsWith('.css')
            ? 'assets/index-[hash][extname]'
            : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
