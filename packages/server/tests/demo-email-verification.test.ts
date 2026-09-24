import { describe, it, expect, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, emailVerificationTokens } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env, demoEmailVerificationSkipped, devToolingActive } from '../src/lib/env.js';

/**
 * Public-demo email-verification bypass.
 *
 * The service and the login route read the live resolvers (`demoEmailVerificationSkipped`
 * / `devToolingActive`), so these tests flip the parsed `env` and drive the real
 * HTTP surface — no mocks and no direct DB writes to fake the outcome.
 */

const app = createApp();

function makeClient(base: Hono) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await base.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
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

/** Runs `fn` with the parsed env fields overridden, restoring them afterwards. */
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

afterAll(async () => {
  await closeDb();
});

describe('Demo email-verification bypass — configuration gate', () => {
  it('is off by default in test, so the suite exercises mandatory verification', () => {
    expect(process.env.DEMO_SKIP_EMAIL_VERIFICATION).toBeUndefined();
    expect(env.DEMO_SKIP_EMAIL_VERIFICATION).toBe(false);
    expect(demoEmailVerificationSkipped()).toBe(false);
  });

  it('never relaxes the gate in production, even when the flag is set', async () => {
    await withEnv({ NODE_ENV: 'production', DEMO_SKIP_EMAIL_VERIFICATION: true }, async () => {
      expect(demoEmailVerificationSkipped()).toBe(false);
      // Production also refuses to serve the dev-tooling routes that surface
      // tokens, so a stray ALLOW_DEV_TOOLING cannot be smuggled in either.
      expect(devToolingActive()).toBe(false);
    });
  });

  it('honours the flag outside production', async () => {
    await withEnv({ NODE_ENV: 'staging', DEMO_SKIP_EMAIL_VERIFICATION: true }, async () => {
      expect(demoEmailVerificationSkipped()).toBe(true);
    });
  });
});

describe('Verification mandatory (default) — production behavior unchanged', () => {
  it('stores the account unverified, mints a token, and refuses login until verified', async () => {
    const email = `verify-required-${Date.now()}@wasit.tn`;
    const password = 'StrongPass123!';
    const c = makeClient(app);

    const reg = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email, password, firstName: 'Gate', role: 'CUSTOMER' },
    });
    expect(reg.status).toBe(201);
    expect(reg.data.data.requiresEmailVerification).toBe(true);

    const row = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row[0].emailVerified).toBe(false);

    const active = await db
      .select()
      .from(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, row[0].id), isNull(emailVerificationTokens.usedAt)));
    expect(active.length).toBe(1);

    const denied = await c.req('/api/auth/login', { method: 'POST', body: { email, password } });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('EMAIL_NOT_VERIFIED');

    // The verification route still exists and completes the flow.
    const link = await c.req('/api/auth/dev/verification-link', { method: 'POST', body: { email } });
    expect(link.status).toBe(200);
    const verified = await c.req('/api/auth/verify-email', {
      method: 'POST',
      body: { token: link.data.data.token },
    });
    expect(verified.status).toBe(200);

    const allowed = await c.req('/api/auth/login', { method: 'POST', body: { email, password } });
    expect(allowed.status).toBe(200);
  });
});

describe('Demo bypass enabled — registration is immediately usable', () => {
  it('stores the account verified, mints no token, and allows an immediate login', async () => {
    const email = `demo-skip-${Date.now()}@wasit.tn`;
    const password = 'StrongPass123!';
    const c = makeClient(app);

    const reg = await withEnv({ DEMO_SKIP_EMAIL_VERIFICATION: true }, () =>
      c.req('/api/auth/register', {
        method: 'POST',
        body: { email, password, firstName: 'Demo', role: 'CUSTOMER' },
      }),
    );
    expect(reg.status).toBe(201);
    expect(reg.data.data.requiresEmailVerification).toBe(false);

    const row = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row[0].emailVerified).toBe(true);

    // No verification token is minted: there is nothing to click.
    const active = await db
      .select()
      .from(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, row[0].id), isNull(emailVerificationTokens.usedAt)));
    expect(active.length).toBe(0);

    // The skip is auditable, so a demo account is distinguishable from a verified one.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, row[0].id));
    expect(audits.some((a) => a.action === 'AUTH.EMAIL_VERIFICATION_SKIPPED')).toBe(true);

    const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password } });
    expect(login.status).toBe(200);
    expect(login.data.data.mfaRequired).toBe(false);
    expect(login.data.data.emailVerified).toBe(true);

    const me = await c.req('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.data.emailVerified).toBe(true);
  });
});

describe('The verification gate cannot be skipped by the caller', () => {
  it('ignores allowUnverifiedEmail when the dev tooling is disabled', async () => {
    const email = `force-bypass-${Date.now()}@wasit.tn`;
    const password = 'StrongPass123!';
    const c = makeClient(app);

    const reg = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email, password, firstName: 'Force', role: 'CUSTOMER' },
    });
    expect(reg.status).toBe(201);
    expect(reg.data.data.requiresEmailVerification).toBe(true);

    // Simulate a deployed environment: no dev tooling, and the request claims the
    // override. The route ANDs the two, so the account stays locked out.
    await withEnv({ NODE_ENV: 'production', ALLOW_DEV_TOOLING: false }, async () => {
      const attempt = await c.req('/api/auth/login', {
        method: 'POST',
        body: { email, password, allowUnverifiedEmail: true },
      });
      expect(attempt.status).toBe(403);
      expect(attempt.data.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    // Where the dev tooling is genuinely on, the documented affordance still works.
    const devAttempt = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password, allowUnverifiedEmail: true },
    });
    expect(devAttempt.status).toBe(200);
  });
});
