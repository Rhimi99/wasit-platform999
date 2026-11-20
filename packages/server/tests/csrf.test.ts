import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  csrfProtection,
  csrfEnforced,
  isStateChangingMethod,
  requestOrigin,
  isTrustedOrigin,
  trustedOrigins,
} from '../src/middleware/csrf.js';
import { SESSION_COOKIE } from '../src/middleware/auth.js';
import { errorBody } from '../src/middleware/errors.js';
import { env } from '../src/lib/env.js';

/**
 * CSRF protection (CAN-SEC-CSRF-01).
 *
 * These are deliberately database-free: the middleware only reads headers and
 * cookies and decides before any route (or the database) is reached, so it can
 * be exercised against a throwaway Hono app. `withEnv` mutates the parsed env
 * object and restores it, mirroring the pattern used by the manual-payment
 * guard spec.
 */

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

/** A minimal app that mounts only the CSRF middleware and a state-changing route. */
function makeApp() {
  const app = new Hono();
  // Same error translation the real app installs, so a rejected request yields
  // the structured 403 rather than an unhandled 500.
  app.onError((err, c) => errorBody(err, c));
  app.use('*', csrfProtection());
  app.post('/write', (c) => c.json({ ok: true }));
  app.put('/write', (c) => c.json({ ok: true }));
  app.patch('/write', (c) => c.json({ ok: true }));
  app.delete('/write', (c) => c.json({ ok: true }));
  app.get('/read', (c) => c.json({ ok: true }));
  app.options('/write', (c) => c.body(null, 204));
  return app;
}

const COOKIE = { Cookie: `${SESSION_COOKIE}=session-token` };

describe('CAN-SEC-CSRF-01 — CSRF enforcement scope', () => {
  it('classifies only state-changing methods as unsafe', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(isStateChangingMethod(m)).toBe(true);
    }
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isStateChangingMethod(m)).toBe(false);
    }
  });

  it('auto mode enforces in production and staging, not in development/test', async () => {
    await withEnv({ CSRF_PROTECTION: 'auto' }, async () => {
      await withEnv({ NODE_ENV: 'production' }, async () => expect(csrfEnforced()).toBe(true));
      await withEnv({ NODE_ENV: 'staging' }, async () => expect(csrfEnforced()).toBe(true));
      await withEnv({ NODE_ENV: 'development' }, async () => expect(csrfEnforced()).toBe(false));
      await withEnv({ NODE_ENV: 'test' }, async () => expect(csrfEnforced()).toBe(false));
    });
  });

  it('on/off override the environment', async () => {
    await withEnv({ CSRF_PROTECTION: 'on', NODE_ENV: 'development' }, async () =>
      expect(csrfEnforced()).toBe(true),
    );
    await withEnv({ CSRF_PROTECTION: 'off', NODE_ENV: 'production' }, async () =>
      expect(csrfEnforced()).toBe(false),
    );
  });

  it('trusts the app origin plus configured CORS origins, normalised', async () => {
    await withEnv({ APP_URL: 'https://app.wasit.tn', CORS_ORIGIN: 'https://extra.wasit.tn/, https://x.tn' }, async () => {
      const set = trustedOrigins();
      expect(set.has('https://app.wasit.tn')).toBe(true);
      expect(set.has('https://extra.wasit.tn')).toBe(true);
      expect(set.has('https://x.tn')).toBe(true);
      expect(set.has('https://evil.example')).toBe(false);
      expect(isTrustedOrigin('https://evil.example')).toBe(false);
      expect(isTrustedOrigin(null)).toBe(false);
    });
  });
});

describe('CAN-SEC-CSRF-01 — request decisions', () => {
  it('rejects a foreign-origin state-changing request that carries the session cookie', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a forged request whose Origin is the literal "null" (sandboxed page)', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'null' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin state-changing request (Origin matches APP_URL)', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://app.wasit.tn' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('fails closed when a cookie-authenticated write carries neither Origin nor Referer', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on' }, async () =>
      app.request('/write', { method: 'POST', headers: { ...COOKIE } }),
    );
    // No origin evidence at all ⇒ the request cannot be proven same-origin, so it
    // is refused. Browsers always send Origin for non-GET/HEAD, so the SPA is
    // unaffected; a non-browser client must send an explicit Origin.
    expect(res.status).toBe(403);
  });

  it('does not require an Origin from a client that presents no session cookie', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on' }, async () =>
      app.request('/write', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
  });

  it('accepts a cookie-authenticated request whose Referer is same-origin when Origin is absent', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Referer: 'https://app.wasit.tn/dashboard' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a cookie-authenticated request whose Referer is foreign when Origin is absent', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Referer: 'https://evil.example/attack' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('does not touch requests without the session cookie (token/HMAC clients unaffected)', async () => {
    const app = makeApp();
    await withEnv({ CSRF_PROTECTION: 'on' }, async () => {
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        const res = await app.request('/write', {
          method,
          headers: { Origin: 'https://evil.example' },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  it('rejects every state-changing method when a cookie is present and the origin is foreign', async () => {
    const app = makeApp();
    await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.request('/write', {
          method,
          headers: { ...COOKIE, Origin: 'https://evil.example' },
        });
        expect(res.status, method).toBe(403);
      }
      // The same method from the trusted origin is accepted, so the block is
      // about the origin, not the method.
      const ok = await app.request('/write', {
        method: 'PUT',
        headers: { ...COOKIE, Origin: 'https://app.wasit.tn' },
      });
      expect(ok.status).toBe(200);
    });
  });

  it('never blocks safe methods, even with a cookie and a foreign origin', async () => {
    const app = makeApp();
    await withEnv({ CSRF_PROTECTION: 'on' }, async () => {
      const get = await app.request('/read', { headers: { ...COOKIE, Origin: 'https://evil.example' } });
      expect(get.status).toBe(200);
      const options = await app.request('/write', { method: 'OPTIONS', headers: { ...COOKIE, Origin: 'https://evil.example' } });
      expect(options.status).toBe(204);
    });
  });

  it('is inert when disabled (off) or outside production/staging (auto)', async () => {
    const app = makeApp();
    await withEnv({ CSRF_PROTECTION: 'off', NODE_ENV: 'production' }, async () => {
      const res = await app.request('/write', { method: 'POST', headers: { ...COOKIE, Origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
    });
    await withEnv({ CSRF_PROTECTION: 'auto', NODE_ENV: 'development' }, async () => {
      const res = await app.request('/write', { method: 'POST', headers: { ...COOKIE, Origin: 'https://evil.example' } });
      expect(res.status).toBe(200);
    });
  });

  it('error body is terse and does not echo the rejected origin', async () => {
    const app = makeApp();
    const res = await withEnv({ CSRF_PROTECTION: 'on' }, async () =>
      app.request('/write', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://evil.example' },
      }),
    );
    const text = await res.text();
    expect(text).not.toContain('evil.example');
  });

  it('requestOrigin falls back to Referer and returns null when neither is present', async () => {
    const app = new Hono();
    let seen: string | null = 'unset';
    app.get('/', (c) => {
      seen = requestOrigin(c);
      return c.json({ ok: true });
    });
    await app.request('/', { headers: { Referer: 'https://a.example/path' } });
    expect(seen).toBe('https://a.example');
    await app.request('/', {});
    expect(seen).toBeNull();
  });
});

describe('CAN-SEC-CSRF-01 — wired into the real application', () => {
  it('blocks a forged cross-origin write before it can reach a route, and lets a safe read through', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () => {
      // State-changing request with a session cookie and a foreign origin is
      // rejected by the middleware — no route or database is reached.
      const forged = await app.request('/api/orders', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ buyerId: 'x', items: [{ productId: 'p', quantity: 1 }] }),
      });
      expect(forged.status).toBe(403);

      // A safe read is never affected, even from a foreign origin.
      const read = await app.request('/api/health/live', {
        headers: { Origin: 'https://evil.example' },
      });
      expect(read.status).toBe(200);
    });
  });

  it('enforces in the default `auto` mode when NODE_ENV=production (the production guarantee)', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    await withEnv({ CSRF_PROTECTION: 'auto', NODE_ENV: 'production', APP_URL: 'https://app.wasit.tn' }, async () => {
      const forged = await app.request('/api/orders', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ buyerId: 'x', items: [{ productId: 'p', quantity: 1 }] }),
      });
      // Default configuration on a production deployment must refuse the forged
      // write — no explicit `CSRF_PROTECTION=on` required.
      expect(forged.status).toBe(403);

      const own = await app.request('/api/orders', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://app.wasit.tn', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(own.status).not.toBe(403);
    });
  });

  it('applies to sensitive admin routes too — no path is exempt', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn' }, async () => {
      for (const path of ['/api/admin/users', '/api/payments/orders/x/intent']) {
        const res = await app.request(path, {
          method: 'POST',
          headers: { ...COOKIE, Origin: 'https://evil.example', 'content-type': 'application/json' },
          body: '{}',
        });
        expect(res.status, path).toBe(403);
      }
    });
  });

  it('runs after CORS and before routing: the 403 still carries CORS headers', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();

    // `CORS_ORIGIN` unset keeps the permissive dev behavior, so a foreign origin
    // is reflected; the point is that the CSRF 403 happens *downstream* of CORS,
    // so the rejection is still readable by the browser instead of an opaque
    // network error.
    await withEnv({ CSRF_PROTECTION: 'on', APP_URL: 'https://app.wasit.tn', CORS_ORIGIN: '' }, async () => {
      const res = await app.request('/api/orders', {
        method: 'POST',
        headers: { ...COOKIE, Origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://evil.example');
    });
  });
});
