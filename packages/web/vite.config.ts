import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the panel API runs on :8080 (see scripts/dev.mjs); Vite proxies
// /api (including the websocket) so the browser sees a single origin.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true, changeOrigin: false },
    },
  },
});
