import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: 'client',
    plugins: [react()],
    // ExcelJS (the phone's Excel export, ~940 kB) is its own chunk, loaded only when exporting.
    build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
    // Phone database worker (sqlite-wasm): settings proven in decision-1.
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
    server: {
      host: '127.0.0.1',
      proxy: { '/api': `http://127.0.0.1:${env.PORT || 4780}` },
    },
  };
});
