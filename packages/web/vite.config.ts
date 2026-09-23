import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** Public runtime hosts allowed to reach the demo web server. */
const ALLOWED_HOSTS = [
  'work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev',
  'work-2-hnqubekeiztmrmck.prod-runtime.all-hands.dev',
  'work-1-qpzssfljriaoounj.prod-runtime.all-hands.dev',
  'work-2-qpzssfljriaoounj.prod-runtime.all-hands.dev',
] as const;

/**
 * Same-origin proxy shared by `server` and `preview`. The API and crawler routes
 * live on the backend; routing them through the web origin keeps the session
 * cookie same-origin exactly as production nginx does.
 */
function proxyToApi() {
  const target = process.env.API_URL ?? 'http://localhost:3000';
  return {
    '/api': { target, changeOrigin: true },
    '/sitemap.xml': { target, changeOrigin: true },
    '/robots.txt': { target, changeOrigin: true },
  };
}

/** Mirrors the production nginx security headers (deploy/nginx.conf) on preview. */
function previewSecurityHeaders(): Plugin {
  return {
    name: 'wasit-preview-security-headers',
    apply: 'serve',
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), previewSecurityHeaders()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    host: true,
    allowedHosts: [...ALLOWED_HOSTS],
    proxy: proxyToApi(),
  },
  // The public demo serves the built SPA through `vite preview` rather than the
  // dev server, so it must mirror the dev proxy (same-origin cookie) and the
  // production nginx security headers. Production itself uses nginx, not this.
  preview: {
    port: Number(process.env.WEB_PORT ?? 4173),
    host: true,
    allowedHosts: [...ALLOWED_HOSTS],
    proxy: proxyToApi(),
  },
});
