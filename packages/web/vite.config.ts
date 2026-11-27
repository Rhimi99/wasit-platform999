import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Hosts allowed to reach the web server.
 *
 * The preview URL is the runtime's public origin, which changes whenever the
 * workspace is recreated, so the list is derived from the environment rather
 * than pinned to one deployment: `APP_URL`/`API_URL` contribute their host,
 * `WEB_ALLOWED_HOSTS` (comma separated) adds extras, and the runtime wildcard
 * covers the rotating `work-N-<id>` subdomains. Vite treats a leading dot as a
 * subdomain wildcard.
 */
function resolveAllowedHosts(): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '.prod-runtime.all-hands.dev']);
  for (const raw of (process.env.WEB_ALLOWED_HOSTS ?? '').split(',')) {
    const host = raw.trim();
    if (host) hosts.add(host);
  }
  for (const key of ['APP_URL', 'API_URL'] as const) {
    try {
      const url = new URL(process.env[key] ?? '');
      if (url.hostname) hosts.add(url.hostname);
    } catch {
      // Not a URL: nothing to add.
    }
  }
  return [...hosts];
}

const API_FALLBACK = 'http://localhost:3000';

/**
 * Resolves the backend origin the web proxy forwards to.
 *
 * `API_URL` is the backend's *public* address — the payment provider builds
 * webhook URLs from it — so in a deployment that serves the SPA and the API on
 * one origin it points at the web server itself. Forwarding `/api` there makes
 * the proxy call its own listener: the request recurses and the edge finally
 * answers `431 Request Header Fields Too Large`, silently breaking every
 * proxied call (including login) while the SPA shell still renders.
 *
 * A target that equals `APP_URL` (the web's own public origin) is therefore a
 * loop, and so is one that names this server's own port. Both fall back to the
 * local backend; `WEB_PROXY_TARGET` overrides the choice outright.
 */
function resolveProxyTarget(): string {
  if (process.env.WEB_PROXY_TARGET) return process.env.WEB_PROXY_TARGET;

  const apiUrl = process.env.API_URL;
  if (!apiUrl) return API_FALLBACK;

  const sameOrigin = (a: string | undefined, b: string | undefined): boolean => {
    if (!a || !b) return false;
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return false;
    }
  };

  if (sameOrigin(apiUrl, process.env.APP_URL)) return API_FALLBACK;

  try {
    const api = new URL(apiUrl);
    const selfPort = process.env.WEB_PORT ?? '';
    if (selfPort && api.port === selfPort) return API_FALLBACK;
    return apiUrl;
  } catch {
    return API_FALLBACK;
  }
}

/**
 * Same-origin proxy shared by `server` and `preview`. The API and crawler routes
 * live on the backend; routing them through the web origin keeps the session
 * cookie same-origin exactly as production nginx does.
 */
function proxyToApi() {
  const target = resolveProxyTarget();
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
    allowedHosts: resolveAllowedHosts(),
    proxy: proxyToApi(),
  },
  // The public demo serves the built SPA through `vite preview` rather than the
  // dev server, so it must mirror the dev proxy (same-origin cookie) and the
  // production nginx security headers. Production itself uses nginx, not this.
  preview: {
    port: Number(process.env.WEB_PORT ?? 4173),
    host: true,
    allowedHosts: resolveAllowedHosts(),
    proxy: proxyToApi(),
  },
});
