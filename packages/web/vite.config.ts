import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the panel API runs on DEV_PANEL_PORT (see scripts/dev.mjs);
// Vite proxies /api (including the websocket) so the browser sees a single
// origin. Ports come from the worktree's .env.dev through dev.mjs; strictPort
// makes a clash an error instead of a silent move into another slot's block.
const webPort = Number(process.env.DEV_WEB_PORT) || 5173;
const panelPort = Number(process.env.DEV_PANEL_PORT) || 8080;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${panelPort}`, ws: true, changeOrigin: false },
    },
  },
});
