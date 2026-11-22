import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Public runtime hosts allowed to reach the demo web server.
 *
 * A runtime container gets a new hostname every time it is recreated, so the
 * demo's own origins (`APP_URL`/`CORS_ORIGIN`) are read from the environment and
 * `WEB_ALLOWED_HOSTS` adds any extra host. The list below only keeps the
 * hostnames of earlier runtimes reachable; it is not the gate itself — Vite
 * still refuses every host that is not listed.
 */
const RUNTIME_HOSTS = [
  'work-1-hnqubekeiztmrmck.prod-runtime.all-hands.dev',
  'work-2-hnqubekeiztmrmck.prod-runtime.all-hands.dev',
  'work-1-qpzssfljriaoounj.prod-runtime.all-hands.dev',
  'work-2-qpzssfljriaoounj.prod-runtime.all-hands.dev',
  'work-1-wqozutzaflweunqz.prod-runtime.all-hands.dev',
  'work-2-wqozutzaflweunqz.prod-runtime.all-hands.dev',
  'work-1-jbrbmtqnypyjfriv.prod-runtime.all-hands.dev',
  'work-2-jbrbmtqnypyjfriv.prod-runtime.all-hands.dev',
] as const;

/** Hostnames of the demo's own origins plus any explicit `WEB_ALLOWED_HOSTS`. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = new Set<string>(RUNTIME_HOSTS);
  for (const source of [env.WEB_ALLOWED_HOSTS, env.APP_URL, env.CORS_ORIGIN]) {
    if (!source) continue;
    for (const entry of source.split(',')) {
      const value = entry.trim();
      if (!value) continue;
      try {
        hosts.add(new URL(value.includes('://') ? value : `https://${value}`).hostname);
      } catch {
        // A malformed entry cannot widen the allow-list; ignore it.
      }
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
    allowedHosts: allowedHosts(),
    proxy: proxyToApi(),
  },
  // The public demo serves the built SPA through `vite preview` rather than the
  // dev server, so it must mirror the dev proxy (same-origin cookie) and the
  // production nginx security headers. Production itself uses nginx, not this.
  preview: {
    port: Number(process.env.WEB_PORT ?? 4173),
    host: true,
    allowedHosts: allowedHosts(),
    proxy: proxyToApi(),
  },
});
