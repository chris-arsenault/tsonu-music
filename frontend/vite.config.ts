import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
  },
  // The visualizer's analysis processor is bundled through `?worker&url` and loaded with
  // `audioWorklet.addModule`, which fetches a module script. Declaring the format explicitly keeps
  // dev and build agreeing on module semantics.
  worker: {
    format: 'es',
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
