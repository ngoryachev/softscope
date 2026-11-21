import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.SOFTSCOPE_PORT ?? 4319);

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    // Anchored with a trailing slash: a plain `/api` prefix also matches the UI module
    // `/api.ts`, which the backend answers with 404 and the app never mounts.
    proxy: { '^/api/': `http://127.0.0.1:${serverPort}` },
  },
});
