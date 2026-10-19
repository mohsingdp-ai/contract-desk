import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: 'client',
    plugins: [react()],
    build: { outDir: '../dist', emptyOutDir: true },
    server: {
      host: '127.0.0.1',
      proxy: { '/api': `http://127.0.0.1:${env.PORT || 4780}` },
    },
  };
});
