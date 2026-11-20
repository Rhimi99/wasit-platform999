import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createApp } from '../src/app.js';
import { coreMiddleware } from '../src/middleware/core.js';
import { requireStaffMfa, MFA_REQUIRED_CODE, isExemptFromStaffMfa } from '../src/middleware/mfa.js';
import { setAuthUser } from '../src/lib/request-context.js';
import { errorBody } from '../src/middleware/errors.js';
import { env, staffMfaEnforced } from '../src/lib/env.js';
import { STAFF_ROLES, isStaffRole } from '@wasit/shared';

/**
 * Mandatory staff MFA (LC-06) — database-free half.
 *
 * The middleware only inspects the already-resolved request user (roles +
 * `mfaEnabled`) and decides before any route is reached, so it can be exercised
 * against a throwaway Hono app whose request user is injected directly. This is
 * the same `coreMiddleware → requireStaffMfa → route` shape the real app mounts,
 * so it proves the enforcement decision and the mount behaviour without a
 * database. The end-to-end login/enrollment flow (which needs a database) lives
 * in `staff-mfa-login.test.ts`.
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

interface FakeUser {
  roles: string[];
  mfaEnabled: boolean;
}

/**
 * A minimal app mirroring the production mount order: core context, then the
 * authenticated user, then the staff-MFA gate over the whole `/api` surface,
 * then probe routes on several staff-reachable prefixes. The user is injected
 * instead of loaded from a session so the test needs no database.
 *
 * The gate is mounted with `app.use('/api/*', …)` *before* the probe routes —
 * the same `use → route` order `createApp()` uses. Hono runs middleware in
 * registration order, so this is what proves the real wiring actually gates the
 * routes rather than silently no-op'ing.
 */
function makeApp(user: FakeUser | null) {
  const app = new Hono();
  app.use('*', coreMiddleware);
  app.use('/api/*', async (c, next) => {
    if (user) {
      setAuthUser(c, {
        id: 'u-1',
        email: 'staff@wasit.tn',
        emailVerified: true,
        isActive: true,
        mfaEnabled: user.mfaEnabled,
        roles: user.roles as never,
      });
    }
    await next();
  });
  app.use('/api/*', requireStaffMfa());
  const ok = (c: Context) => c.json({ success: true, data: { ok: true } });
  // A spread of the staff-reachable prefixes: the admin surface, a desk, and the
  // mixed routes (orders, revenue) a staff role can reach without RBAC denying it.
  for (const prefix of ['/api/admin', '/api/verification', '/api/risk', '/api/revenue', '/api/orders', '/api/payments']) {
    app.get(`${prefix}/probe`, ok);
    app.post(`${prefix}/probe`, ok);
  }
  // Exempt surfaces: auth (sign in + enrollment) and health.
  app.get('/api/auth/mfa/status', ok);
  app.post('/api/auth/mfa/staff-confirm', ok);
  app.get('/api/health', ok);
  app.onError((err, c) => errorBody(err, c));
  return app;
}

async function get(app: Hono, path = '/api/admin/probe') {
  const res = await app.request(path, { method: 'GET' });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe('staff MFA — policy helpers', () => {
  it('STAFF_ROLES is exactly the internal staff set, excluding public roles', () => {
    expect([...STAFF_ROLES].sort()).toEqual(['ADMIN', 'DISPUTE', 'RISK', 'SUPER_ADMIN', 'SUPPORT']);
    for (const publicRole of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER']) {
      expect(isStaffRole([publicRole])).toBe(false);
    }
    for (const staff of STAFF_ROLES) {
      expect(isStaffRole([staff])).toBe(true);
    }
  });

  it('isStaffRole treats an empty or missing role set as non-staff', () => {
    expect(isStaffRole([])).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
    expect(isStaffRole(null)).toBe(false);
  });

  it('staffMfaEnforced maps auto/on/off onto the deployment', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on', NODE_ENV: 'test' }, async () => {
      expect(staffMfaEnforced()).toBe(true);
    });
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'off', NODE_ENV: 'production' }, async () => {
      expect(staffMfaEnforced()).toBe(false);
    });
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'auto', NODE_ENV: 'production' }, async () => {
      expect(staffMfaEnforced()).toBe(true);
    });
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'auto', NODE_ENV: 'test' }, async () => {
      expect(staffMfaEnforced()).toBe(false);
    });
    // Staging is the public demo and must NOT be locked out under `auto`.
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'auto', NODE_ENV: 'staging' }, async () => {
      expect(staffMfaEnforced()).toBe(false);
    });
  });

  it('isExemptFromStaffMfa exempts only /api/auth and /api/health', () => {
    for (const path of ['/api/auth', '/api/auth/login', '/api/auth/mfa/staff-confirm', '/api/health', '/api/health/ai']) {
      expect(isExemptFromStaffMfa(path), path).toBe(true);
    }
    for (const path of ['/api/authz', '/api/authentic', '/api/healthcheck', '/api/admin', '/api/revenue/report', '/api/orders']) {
      expect(isExemptFromStaffMfa(path), path).toBe(false);
    }
  });
});

describe('staff MFA — enforcement decision', () => {
  it('blocks a staff account without an enabled second factor', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { status, body } = await get(makeApp({ roles: ['ADMIN'], mfaEnabled: false }));
      expect(status).toBe(403);
      expect((body?.error as { code: string }).code).toBe(MFA_REQUIRED_CODE);
    });
  });

  it('allows a staff account that has an enabled second factor', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { status } = await get(makeApp({ roles: ['ADMIN'], mfaEnabled: true }));
      expect(status).toBe(200);
    });
  });

  it('gates every internal staff role identically', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      for (const role of STAFF_ROLES) {
        const blocked = await get(makeApp({ roles: [role], mfaEnabled: false }));
        expect(blocked.status, `${role} without MFA`).toBe(403);
        const allowed = await get(makeApp({ roles: [role], mfaEnabled: true }));
        expect(allowed.status, `${role} with MFA`).toBe(200);
      }
    });
  });

  it('SUPER_ADMIN gets no special MFA bypass', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { status, body } = await get(makeApp({ roles: ['SUPER_ADMIN'], mfaEnabled: false }));
      expect(status).toBe(403);
      expect((body?.error as { code: string }).code).toBe(MFA_REQUIRED_CODE);
    });
  });

  it('leaves non-staff roles untouched (customer, merchant, supplier, company, marketer)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      for (const role of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER']) {
        const { status } = await get(makeApp({ roles: [role], mfaEnabled: false }));
        expect(status, role).toBe(200);
      }
    });
  });

  it('does not block anonymous requests (the route guard owns authentication)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const { status } = await get(makeApp(null));
      expect(status).toBe(200);
    });
  });

  it('is inert when enforcement resolves off', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'off' }, async () => {
      const { status } = await get(makeApp({ roles: ['ADMIN'], mfaEnabled: false }));
      expect(status).toBe(200);
    });
  });

  it('cannot be satisfied by client-side state — the account flag is authoritative', async () => {
    // The middleware reads the resolved user, never the request body or query.
    // A crafted body claiming MFA must not change the decision.
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const app = makeApp({ roles: ['ADMIN'], mfaEnabled: false });
      const res = await app.request('/api/admin/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mfaEnabled: true, roles: ['ADMIN'] }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('gates every staff-reachable prefix — admin, desks, revenue, and mixed routes', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const app = makeApp({ roles: ['SUPPORT'], mfaEnabled: false });
      for (const prefix of ['/api/admin', '/api/verification', '/api/risk', '/api/revenue', '/api/orders', '/api/payments']) {
        const blocked = await app.request(`${prefix}/probe`);
        expect(blocked.status, `${prefix} without MFA`).toBe(403);
        const allowed = await app.request(`${prefix}/probe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(allowed.status, `${prefix} POST without MFA`).toBe(403);
      }
    });
  });

  it('exempts /api/auth and /api/health so a staff member can sign in and enroll', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const app = makeApp({ roles: ['ADMIN'], mfaEnabled: false });
      for (const path of ['/api/auth/mfa/status', '/api/health']) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
      }
      // The enrollment confirmation must also be reachable — it is how the staff
      // member's first session is opened.
      const confirm = await app.request('/api/auth/mfa/staff-confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(confirm.status).toBe(200);
    });
  });

  it('does not leak the exemption to sibling paths (prefix is exact or slash-delimited)', async () => {
    await withEnv({ STAFF_MFA_ENFORCEMENT: 'on' }, async () => {
      const app = makeApp({ roles: ['ADMIN'], mfaEnabled: false });
      // `/api/authz` must not be treated as under the exempt `/api/auth` prefix.
      app.get('/api/authz/probe', (c) => c.json({ success: true }));
      const res = await app.request('/api/authz/probe');
      expect(res.status).toBe(403);
    });
  });
});

/**
 * Wiring proof against the *real* application.
 *
 * `createApp()` registers the staff-MFA gate as an `/api/*` middleware, but Hono
 * runs middleware in registration order — a gate registered after a router would
 * never run for that router's routes (the exact bug this closure fixes). These
 * assertions read the real route table, so they fail if the gate is ever moved
 * after a router, renamed off the `/api/*` pattern, or dropped.
 */
describe('staff MFA — real app wiring (createApp)', () => {
  interface RouteRow {
    path: string;
    method: string;
  }
  const apiMiddleware = (): RouteRow[] => {
    const rows = (createApp() as unknown as { routes: RouteRow[] }).routes;
    return rows.filter((r) => r.method === 'ALL' && r.path.startsWith('/api'));
  };

  it('registers an /api/* middleware gate', () => {
    const rows = apiMiddleware();
    expect(rows.some((r) => r.path === '/api/*'), 'expected an /api/* middleware').toBe(true);
  });

  it('registers the /api/* gate before every /api router', () => {
    const rows = apiMiddleware();
    const gateIndex = rows.findIndex((r) => r.path === '/api/*');
    expect(gateIndex).toBe(0);
    // The gate must precede the staff surfaces this closure protects.
    for (const prefix of [
      '/api/orders/*',
      '/api/payments/*',
      '/api/verification/*',
      '/api/risk/*',
      '/api/disputes/*',
      '/api/admin/*',
    ]) {
      const idx = rows.findIndex((r) => r.path === prefix);
      expect(idx, `${prefix} should be registered after the gate`).toBeGreaterThan(gateIndex);
    }
  });
});
