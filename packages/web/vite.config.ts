import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      'work-1-qpzssfljriaoounj.prod-runtime.all-hands.dev',
      'work-2-qpzssfljriaoounj.prod-runtime.all-hands.dev',
    ],
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      // Crawler-facing routes live on the backend; expose them on the web origin too.
      '/sitemap.xml': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      '/robots.txt': {
        target: process.env.API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
