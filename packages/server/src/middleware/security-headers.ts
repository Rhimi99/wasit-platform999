import type { Context, Next } from 'hono';
import { env, cookieSecure } from '../lib/env';

/**
 * Security headers middleware.
 * HSTS is only applied for HTTPS deployments — never over plain HTTP on
 * localhost where it would lock the browser into HTTPS and break local testing.
 * `cookieSecure` carries the same resolved notion of "this deployment is HTTPS".
 */
export async function securityHeaders(c: Context, next: Next): Promise<Response | void> {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  const isLocal =
    c.req.url.startsWith('http://localhost') ||
    c.req.url.startsWith('http://127.0.0.1');
  if (cookieSecure && !isLocal) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const defaultSrc = `'self'`;
  // Allow development tools and frontend dev server in dev only.
  const devExtras =
    env.NODE_ENV === 'development'
      ? ` http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*`
      : '';
  c.header(
    'Content-Security-Policy',
    [
      `default-src ${defaultSrc}${devExtras}`,
      `script-src 'self'${env.NODE_ENV === 'development' ? ` http://localhost:*` : ``}`,
      `style-src 'self' 'unsafe-inline'${env.NODE_ENV === 'development' ? ` http://localhost:*` : ``}`,
      `img-src 'self' data: blob:`,
    ].join('; '),
  );

  return next();
}