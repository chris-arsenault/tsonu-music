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
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
