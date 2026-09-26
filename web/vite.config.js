import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds web/ into public/, which the Worker serves (wrangler.jsonc "assets").
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: resolve(import.meta.dirname, '../public'),
    emptyOutDir: true,
    // three.js is most of the bundle; one file is fine and caches well.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        teacher: resolve(import.meta.dirname, 'teacher/index.html'),
      },
    },
  },
  server: {
    // `npm run dev:web` against a running `wrangler dev` on :8787
    proxy: { '/api': 'http://localhost:8787' },
  },
});
