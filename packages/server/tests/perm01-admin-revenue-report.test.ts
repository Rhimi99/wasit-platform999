import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { readFileSync } from 'node:fs';
import { PERMISSIONS, roleHasPermission, getPermissionsForRole } from '@wasit/shared';
import type { UserRole } from '@wasit/shared';
import { coreMiddleware } from '../src/middleware/core.js';
import { requireAuth, requirePermission } from '../src/middleware/auth.js';
import { setAuthUser } from '../src/lib/request-context.js';
import { errorBody } from '../src/middleware/errors.js';
import { revenueRoutes } from '../src/modules/revenue/routes.js';
import { adminAnalyticsRoutes } from '../src/modules/admin/analytics-routes.js';
import { adminRoutes } from '../src/modules/admin/routes.js';

/**
 * PERM-01 — ADMIN revenue & reports permissions (database-free authorization).
 *
 * The question PERM-01 settles is whether ADMIN should hold `revenue:read`
 * and/or `report:read`. The answer, proved here against the *real* routers and
 * the *real* RBAC matrix, is **no**:
 *
 *  - `revenue:read` guards WASIT's own profitability report (`/api/revenue/*`).
 *    ADMIN must not hold it — the denial is the documented, live-verified policy
 *    (see docs/management/guide.html §8 and docs/API_SPECIFICATION.md): the real
 *    ADMIN↔SUPER_ADMIN difference is exactly `/api/revenue/*`.
 *  - `report:read` guards no endpoint at all. The reports desk
 *    (`/api/admin/analytics/reports`) is intentionally gated by `admin:reports`,
 *    which ADMIN already holds (PERM-01C R2). So there is no reports gap.
 *
 * The guards decide from the already-resolved request user (roles), so the real
 * routers can be mounted on a throwaway Hono app and exercised with the auth
 * user injected directly — no database, no session cookie. The probes that need
 * a database are never reached: the guard rejects (403) before the handler, or
 * the handler 500s on the absent DB — which still proves authorization, because
 * a 403 means "denied" while a non-403 means "authorized past the guard".
 */

/** Runs `fn` with `roles` injected as the request user, mounting the real guard stack. */
function makeApp(roles: UserRole[], mount: (app: Hono) => void): Hono {
  const app = new Hono();
  app.use('*', coreMiddleware);
  app.use('*', async (c: Context, next: Next) => {
    setAuthUser(c, {
      id: 'perm01-user',
      email: 'perm01@wasit.tn',
      emailVerified: true,
      isActive: true,
      mfaEnabled: true,
      roles,
    });
    await next();
  });
  mount(app);
  app.onError((err, c) => errorBody(err, c));
  return app;
}

/** The revenue sub-app with its own real guards (requireAuth + requirePermission). */
function revenueApp(roles: UserRole[]): Hono {
  return makeApp(roles, (app) => {
    app.route('/api/revenue', revenueRoutes);
  });
}

/** The admin analytics sub-app behind the real blanket `admin:analytics` guard. */
function analyticsApp(roles: UserRole[]): Hono {
  return makeApp(roles, (app) => {
    app.route('/api/admin/analytics', adminAnalyticsRoutes);
  });
}

/** The general admin sub-app behind the real `requireRole('ADMIN','SUPER_ADMIN')` guard. */
function adminApp(roles: UserRole[]): Hono {
  return makeApp(roles, (app) => {
    app.route('/api/admin', adminRoutes);
  });
}

async function status(app: Hono, path: string, method = 'GET'): Promise<number> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
  return res.status;
}

const ADMIN = 'ADMIN' as UserRole;
const SUPER_ADMIN = 'SUPER_ADMIN' as UserRole;

describe('PERM-01 — RBAC matrix (the decision is encoded, not accidental)', () => {
  it('ADMIN does not hold revenue:read / revenue:manage / revenue:simulate', () => {
    expect(roleHasPermission(ADMIN, PERMISSIONS.REVENUE_READ)).toBe(false);
    expect(roleHasPermission(ADMIN, PERMISSIONS.REVENUE_MANAGE)).toBe(false);
    expect(roleHasPermission(ADMIN, PERMISSIONS.REVENUE_SIMULATE)).toBe(false);
  });

  it('ADMIN does not hold report:read', () => {
    expect(roleHasPermission(ADMIN, PERMISSIONS.REPORT_READ)).toBe(false);
  });

  it('ADMIN holds admin:reports — the real reports-desk capability', () => {
    expect(roleHasPermission(ADMIN, PERMISSIONS.ADMIN_REPORTS)).toBe(true);
    expect(roleHasPermission(ADMIN, PERMISSIONS.ADMIN_ANALYTICS)).toBe(true);
  });

  it('SUPER_ADMIN holds the full set (revenue:read, report:read, admin:reports)', () => {
    expect(roleHasPermission(SUPER_ADMIN, PERMISSIONS.REVENUE_READ)).toBe(true);
    expect(roleHasPermission(SUPER_ADMIN, PERMISSIONS.REVENUE_SIMULATE)).toBe(true);
    expect(roleHasPermission(SUPER_ADMIN, PERMISSIONS.REPORT_READ)).toBe(true);
    expect(roleHasPermission(SUPER_ADMIN, PERMISSIONS.ADMIN_REPORTS)).toBe(true);
    // SUPER_ADMIN is the whole permission set, by definition.
    expect(getPermissionsForRole(SUPER_ADMIN).size).toBe(Object.values(PERMISSIONS).length);
  });
});

describe('PERM-01 — revenue endpoints deny ADMIN, allow SUPER_ADMIN', () => {
  it('GET /api/revenue/report → ADMIN 403, SUPER_ADMIN not 403', async () => {
    expect(await status(revenueApp([ADMIN]), '/api/revenue/report')).toBe(403);
    expect(await status(revenueApp([SUPER_ADMIN]), '/api/revenue/report')).not.toBe(403);
  });

  it('GET /api/revenue/scenarios → ADMIN 403, SUPER_ADMIN not 403 (owner-scoped)', async () => {
    expect(await status(revenueApp([ADMIN]), '/api/revenue/scenarios')).toBe(403);
    // Past the permission, the route still scopes to the caller's own scenarios
    // (`createdById` must equal the session user) — so SUPER_ADMIN passes the
    // permission but only for their own list. Supplying the id proves the
    // permission gate is what denied ADMIN above.
    expect(
      await status(revenueApp([SUPER_ADMIN]), '/api/revenue/scenarios?createdById=perm01-user'),
    ).not.toBe(403);
  });

  it('POST /api/revenue/scenario → ADMIN 403, SUPER_ADMIN not 403', async () => {
    expect(await status(revenueApp([ADMIN]), '/api/revenue/scenario', 'POST')).toBe(403);
    expect(await status(revenueApp([SUPER_ADMIN]), '/api/revenue/scenario', 'POST')).not.toBe(403);
  });

  it('an unauthenticated caller is 401, not 403 (auth is required first)', async () => {
    const app = new Hono();
    app.use('*', coreMiddleware);
    app.route('/api/revenue', revenueRoutes);
    app.onError((err, c) => errorBody(err, c));
    // No user injected ⇒ requireAuth refuses with 401 before the permission check.
    const res = await app.request('/api/revenue/report');
    expect(res.status).toBe(401);
  });
});

describe('PERM-01 — reports desk stays reachable by ADMIN via admin:reports', () => {
  it('GET /api/admin/analytics/reports → ADMIN not 403 (admin:reports)', async () => {
    expect(await status(analyticsApp([ADMIN]), '/api/admin/analytics/reports')).not.toBe(403);
  });

  it('MERCHANT is refused the reports desk (403)', async () => {
    expect(await status(analyticsApp(['MERCHANT' as UserRole]), '/api/admin/analytics/reports')).toBe(403);
  });

  it('CUSTOMER is refused the reports desk (403)', async () => {
    expect(await status(analyticsApp(['CUSTOMER' as UserRole]), '/api/admin/analytics/reports')).toBe(403);
  });
});

describe('PERM-01 — customers/merchants cannot reach the admin surface', () => {
  it('GET /api/admin/stats → ADMIN not 403, CUSTOMER/MERCHANT/SUPPLIER 403', async () => {
    expect(await status(adminApp([ADMIN]), '/api/admin/stats')).not.toBe(403);
    for (const role of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER'] as UserRole[]) {
      expect(await status(adminApp([role]), '/api/admin/stats'), role).toBe(403);
    }
  });
});

describe('PERM-01 — no alternate endpoint leaks the profitability report to ADMIN', () => {
  it('the financial endpoints are exactly the revenue module, all behind revenue:read/simulate', () => {
    // Every `/api/revenue/*` route in the module must carry a revenue permission.
    const src = readFileSync(
      new URL('../src/modules/revenue/routes.ts', import.meta.url),
      'utf8',
    );
    const guarded = src.match(/requirePermission\(PERMISSIONS\.(REVENUE_READ|REVENUE_SIMULATE)\)/g) ?? [];
    expect(guarded.length).toBe(3); // report, scenario, scenarios
    expect(src).not.toMatch(/requirePermission\(PERMISSIONS\.(?!REVENUE_)/);
  });

  it('ADMIN is denied revenue:read but authorized on the analytics breakdown (admin:analytics) — a distinct, documented surface', async () => {
    // The revenue-breakdown is intentionally admin:analytics (API_SPECIFICATION.md).
    // It is a ledger breakdown, not the profitability report; it does not bypass PERM-01.
    expect(await status(analyticsApp([ADMIN]), '/api/admin/analytics/revenue-breakdown')).not.toBe(403);
    // But the profitability report itself remains unreachable for ADMIN.
    expect(await status(revenueApp([ADMIN]), '/api/revenue/report')).toBe(403);
  });
});

describe('PERM-01 — authorization is per-request, not per-UI', () => {
  it('the same ADMIN session is allowed on /api/admin/* and denied on /api/revenue/* in one process', async () => {
    // Roles are read from the request user on every request; there is no cached
    // UI-side grant. The same ADMIN identity is 200-class on the admin surface
    // and 403 on the profitability report.
    expect(await status(adminApp([ADMIN]), '/api/admin/stats')).not.toBe(403);
    expect(await status(revenueApp([ADMIN]), '/api/revenue/report')).toBe(403);
  });
});

describe('PERM-01 — a role-less (or downgraded) request cannot bypass authorization', () => {
  it('a user whose roles do not include ADMIN is refused the admin surface', async () => {
    // An authenticated but unprivileged user (e.g. CUSTOMER) is 403, not 200 —
    // role checks are derived from the request user, so tampering with a role
    // name/order does not grant access.
    expect(await status(adminApp(['CUSTOMER']), '/api/admin/stats')).toBe(403);
    expect(await status(revenueApp(['CUSTOMER']), '/api/revenue/report')).toBe(403);
  });

  it('the RBAC matrix is the single source of truth for the deny (no wildcard for ADMIN)', () => {
    const admin = getPermissionsForRole(ADMIN);
    // ADMIN is an explicit set; it must not contain any revenue/report read.
    expect([...admin].some((p) => p.startsWith('revenue:'))).toBe(false);
    expect([...admin].includes(PERMISSIONS.REPORT_READ)).toBe(false);
    // SUPER_ADMIN alone carries the wildcard-equivalent full set.
    expect(getPermissionsForRole(SUPER_ADMIN).size).toBeGreaterThan(admin.size);
  });
});
