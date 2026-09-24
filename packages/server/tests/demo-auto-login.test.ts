import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env, demoAutoLoginEnabled } from '../src/lib/env.js';
import {
  DEMO_AUDIT_PERSONAS,
  DEMO_PUBLISHED_PASSWORD,
  DEMO_TEST_ACCOUNT_EMAIL,
  resolveDemoAuditPersona,
  resolveStaffPassword,
} from '../src/lib/demo-account.js';

/**
 * Staff-fixture credential policy (`resolveStaffPassword`).
 *
 * Regression guard: the seeder once handed `admin@`/`admin2@` the *published*
 * demo password, so the public demo opened its staff desks to anyone. The policy
 * is pure, so it is asserted directly rather than by inspecting a seeded database:
 *   * an explicit DEMO_STAFF_PASSWORD always wins;
 *   * the public demo (NODE_ENV=staging) never falls back to the published value;
 *   * dev/test keeps the known password so E2E can drive the admin desks.
 */
describe('resolveStaffPassword', () => {
  const generate = () => 'generated-secret-value';

  it('honours an explicitly configured staff password', () => {
    const pw = resolveStaffPassword({
      nodeEnv: 'staging',
      configuredPassword: 'operator-chosen',
      generate,
    });
    expect(pw).toBe('operator-chosen');
  });

  it('never falls back to the published password on the public demo', () => {
    const pw = resolveStaffPassword({ nodeEnv: 'staging', generate });
    expect(pw).toBe('generated-secret-value');
    expect(pw).not.toBe(DEMO_PUBLISHED_PASSWORD);
  });

  it('keeps the published password in development so E2E can reach staff', () => {
    const pw = resolveStaffPassword({ nodeEnv: 'development', generate });
    expect(pw).toBe(DEMO_PUBLISHED_PASSWORD);
  });

  it('keeps the published password in test', () => {
    const pw = resolveStaffPassword({ nodeEnv: 'test', generate });
    expect(pw).toBe(DEMO_PUBLISHED_PASSWORD);
  });

  it('ignores blank configured values instead of accepting an empty password', () => {
    const pw = resolveStaffPassword({ nodeEnv: 'staging', configuredPassword: '   ', generate });
    expect(pw).toBe('generated-secret-value');
  });
});


/**
 * Public-demo auto-login (`POST /api/auth/demo-session`).
 *
 * Exercises the real HTTP route against the real database. It flips the parsed
 * env flag (the route reads the live resolver, no mock) and proves the three
 * promises that make the route safe:
 *   1. it is refused outright when the flag is off — the default everywhere;
 *   2. it is refused in production even with the flag on;
 *   3. when enabled it opens a *real* session for the one seeded account and
 *      that session resolves through `/api/auth/me` (not just a 200 on the call).
 */

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { data: data as any, status: res.status };
    },
  };
}

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

/** Ensures the one seeded demo account exists, using the normal registration path. */
async function ensureDemoAccount(): Promise<string> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_TEST_ACCOUNT_EMAIL))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const c = makeClient();
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email: DEMO_TEST_ACCOUNT_EMAIL, password: 'DemoAccountPass123!', firstName: 'Demo', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const row = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_TEST_ACCOUNT_EMAIL))
    .limit(1);
  return row[0].id;
}

afterAll(async () => {
  await closeDb();
});

describe('Demo auto-login — configuration gate', () => {
  it('is off by default in test', () => {
    expect(process.env.DEMO_AUTO_LOGIN).toBeUndefined();
    expect(env.DEMO_AUTO_LOGIN).toBe(false);
    expect(demoAutoLoginEnabled()).toBe(false);
  });

  it('never opens in production, even when the flag is set', async () => {
    await withEnv({ NODE_ENV: 'production', DEMO_AUTO_LOGIN: true }, async () => {
      expect(demoAutoLoginEnabled()).toBe(false);
    });
  });

  it('honours the flag outside production', async () => {
    await withEnv({ NODE_ENV: 'staging', DEMO_AUTO_LOGIN: true }, async () => {
      expect(demoAutoLoginEnabled()).toBe(true);
    });
  });
});

describe('Demo auto-login — route behavior', () => {
  it('is refused when the flag is off, opening no session', async () => {
    await ensureDemoAccount();
    const c = makeClient();
    const res = await c.req('/api/auth/demo-session', { method: 'POST' });
    expect(res.status).toBe(404);
    // And no session cookie was issued by that call.
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('is refused in production even with the flag on', async () => {
    await ensureDemoAccount();
    const c = makeClient();
    const res = await withEnv({ NODE_ENV: 'production', DEMO_AUTO_LOGIN: true }, () =>
      c.req('/api/auth/demo-session', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('opens a real session for the seeded demo account when enabled', async () => {
    await ensureDemoAccount();
    const c = makeClient();

    const res = await withEnv({ DEMO_AUTO_LOGIN: true }, () =>
      c.req('/api/auth/demo-session', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.email).toBe(DEMO_TEST_ACCOUNT_EMAIL);
    expect(res.data.data.roles).toContain('CUSTOMER');
    // The point of the route is never to mint staff access.
    expect(res.data.data.roles).not.toContain('ADMIN');
    expect(res.data.data.roles).not.toContain('SUPER_ADMIN');

    // The session is real: the same client resolves it on an authenticated route.
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.data.email).toBe(DEMO_TEST_ACCOUNT_EMAIL);

    // And the auto-login is auditable.
    const row = await db
      .select()
      .from(users)
      .where(eq(users.email, DEMO_TEST_ACCOUNT_EMAIL))
      .limit(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row[0].id));
    expect(audits.some((a) => a.action === 'AUTH.DEMO_AUTO_LOGIN')).toBe(true);
  });
});


/**
 * Demo persona roster (`resolveDemoAuditPersona`) — the whitelist behind the
 * Owner Audit Center. The id must resolve to a compiled-in fixture and nothing
 * else; an arbitrary address or unknown id is refused rather than trusted.
 */
describe('resolveDemoAuditPersona', () => {
  it('resolves every roster id to its compiled-in fixture', () => {
    for (const [id, persona] of Object.entries(DEMO_AUDIT_PERSONAS)) {
      const resolved = resolveDemoAuditPersona(id);
      expect(resolved).not.toBeNull();
      expect(resolved!.email).toBe(persona.email);
      expect(resolved!.role).toBe(persona.role);
      expect(resolved!.fallbackEmail).toBe(persona.fallbackEmail);
    }
  });

  it('only offers a role-less fallback for the trade fixtures', () => {
    // The fallback exists so a base-seed demo can still open the entry point, but
    // it must never be the fixture's own account nor a staff account.
    for (const id of ['customer', 'admin', 'super-admin'] as const) {
      expect(resolveDemoAuditPersona(id)!.fallbackEmail).toBeNull();
    }
    for (const id of ['merchant', 'supplier', 'company'] as const) {
      expect(resolveDemoAuditPersona(id)!.fallbackEmail).toBe('customer1@wasit.tn');
    }
  });

  it('is case/whitespace tolerant but never maps an unknown id', () => {
    expect(resolveDemoAuditPersona(' MERCHANT ')?.email).toBe(DEMO_AUDIT_PERSONAS.merchant.email);
    expect(resolveDemoAuditPersona('superuser')).toBeNull();
    expect(resolveDemoAuditPersona('admin@wasit.tn')).toBeNull();
    expect(resolveDemoAuditPersona('')).toBeNull();
    expect(resolveDemoAuditPersona(null)).toBeNull();
    expect(resolveDemoAuditPersona(42)).toBeNull();
  });
});

/**
 * Owner Audit Center session opener (`POST /api/auth/demo-audit-session`).
 *
 * Proves the two properties the audit center relies on, against the real route:
 *   1. the same demo-only gate as the customer entry — 404 when off, and 404 in
 *      production even with the flag on;
 *   2. the opened session holds the fixture's *real* stored role, so a customer
 *      persona is refused by the staff API (no role is forged for the UI).
 */
describe('Demo audit session — route behavior', () => {
  it('refuses an unknown persona even when auto-login is enabled', async () => {
    const c = makeClient();
    const res = await withEnv({ DEMO_AUTO_LOGIN: true }, () =>
      c.req('/api/auth/demo-audit-session', { method: 'POST', body: { persona: 'nope' } }),
    );
    expect(res.status).toBe(400);
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('is refused when the flag is off', async () => {
    const c = makeClient();
    const res = await c.req('/api/auth/demo-audit-session', {
      method: 'POST',
      body: { persona: 'customer' },
    });
    expect(res.status).toBe(404);
  });

  it('is refused in production even with the flag on', async () => {
    const c = makeClient();
    const res = await withEnv({ NODE_ENV: 'production', DEMO_AUTO_LOGIN: true }, () =>
      c.req('/api/auth/demo-audit-session', { method: 'POST', body: { persona: 'super-admin' } }),
    );
    expect(res.status).toBe(404);
  });

  it('opens a real customer session that cannot reach the staff API', async () => {
    await ensureDemoAccount();
    const c = makeClient();
    const res = await withEnv({ DEMO_AUTO_LOGIN: true }, () =>
      c.req('/api/auth/demo-audit-session', { method: 'POST', body: { persona: 'customer' } }),
    );
    expect(res.status).toBe(200);
    expect(res.data.data.email).toBe(DEMO_TEST_ACCOUNT_EMAIL);
    expect(res.data.data.roles).toEqual(['CUSTOMER']);
    expect(res.data.data.persona).toBe('customer');

    // The session is real and carries no staff authority.
    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(200);
    const stats = await c.req('/api/admin/stats');
    expect(stats.status).toBe(403);
  });
});
