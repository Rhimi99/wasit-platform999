import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { sessions, users } from '../src/db/schema/auth.js';
import { generateTotp } from '../src/lib/mfa.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  await resetRateLimitStore();
});

function makeClient(ip = `203.0.113.${Math.floor(Math.random() * 200 + 1)}`) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
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
      return { res, data: data as Record<string, never>, status: res.status };
    },
  };
}

async function createUser(prefix: string, password = 'Passw0rd!Secure') {
  const id = randomUUID();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const passwordHash = await argon2.hash(password);
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: prefix,
    emailVerified: true,
    isActive: true,
  });
  return { id, email, password };
}

/** Creates a user and returns a client with MFA enabled, plus the TOTP secret. */
async function createMfaUser(prefix: string) {
  const user = await createUser(prefix);
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);

  const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
  expect(enroll.status).toBe(200);
  const { secretBase32, recoveryCodes } = enroll.data.data as {
    secretBase32: string;
    recoveryCodes: string[];
  };
  const confirm = await client.req('/api/auth/mfa/confirm', {
    method: 'POST',
    body: { code: generateTotp(secretBase32) },
  });
  expect(confirm.status).toBe(200);
  await client.req('/api/auth/logout', { method: 'POST' });
  return { ...user, secretBase32, recoveryCodes };
}

describe('MFA login challenge', () => {
  it('a correct password on an MFA account returns mfaRequired and sets no session cookie', async () => {
    const user = await createMfaUser('mfa-login');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);
    const data = login.data.data as { mfaRequired: boolean; challengeToken: string; expiresAt: string };
    expect(data.mfaRequired).toBe(true);
    expect(data.challengeToken).toBeTruthy();
    expect(data.expiresAt).toBeTruthy();
    // No session was issued — the protected endpoint must reject.
    expect(client.cookie).not.toMatch(/wasit_session=/);
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('the challenge endpoint issues a real session after a valid TOTP', async () => {
    const user = await createMfaUser('mfa-complete');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    const verify = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(verify.status).toBe(200);
    const data = verify.data.data as { mfaRequired: boolean; id: string };
    expect(data.mfaRequired).toBe(false);
    expect(data.id).toBe(user.id);
    expect(client.cookie).toMatch(/wasit_session=/);

    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(200);
    expect((me.data.data as { id: string }).id).toBe(user.id);
  });

  it('rejects a wrong code without issuing a session', async () => {
    const user = await createMfaUser('mfa-wrong');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    const bad = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: '000000' },
    });
    expect(bad.status).toBe(401);
    expect(client.cookie).not.toMatch(/wasit_session=/);

    // The valid code still works on the same challenge (attempts < max).
    const good = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(good.status).toBe(200);
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(200);
  });

  it('consumes the challenge so it cannot be reused', async () => {
    const user = await createMfaUser('mfa-reuse');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    const first = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(first.status).toBe(200);

    const other = makeClient();
    const second = await other.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(second.status).toBe(401);
    expect(other.cookie).not.toMatch(/wasit_session=/);
  });

  it('rejects an unknown or malformed challenge token', async () => {
    const client = makeClient();
    const unknown = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: 'not-a-real-challenge-token-0000000000', code: '123456' },
    });
    expect(unknown.status).toBe(401);

    const malformed = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: 'short', code: '123456' },
    });
    expect(malformed.status).toBe(422);
  });

  it('accepts a recovery code once and consumes it', async () => {
    const user = await createMfaUser('mfa-recovery');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    const ok = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: user.recoveryCodes[0] },
    });
    expect(ok.status).toBe(200);
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(200);

    // Same recovery code on a fresh challenge must now fail.
    await client.req('/api/auth/logout', { method: 'POST' });
    const login2 = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken: ct2 } = login2.data.data as { challengeToken: string };
    const reuse = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: ct2, code: user.recoveryCodes[0] },
    });
    expect(reuse.status).toBe(401);
  });

  it('invalidate the challenge after too many wrong attempts', async () => {
    const user = await createMfaUser('mfa-lockout');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    for (let i = 0; i < 5; i++) {
      const bad = await client.req('/api/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken, code: '000000' },
      });
      expect(bad.status).toBe(401);
    }

    // Even the correct code is now refused.
    const good = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(good.status).toBe(401);
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('rejects a challenge whose account had MFA disabled in the meantime', async () => {
    const user = await createMfaUser('mfa-disabled');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    await db.update(users).set({ mfaEnabled: false }).where(eq(users.id, user.id));

    const res = await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });
    expect(res.status).toBe(401);
    const me = await client.req('/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('records audit events for challenge issue, failure, and success', async () => {
    const user = await createMfaUser('mfa-audit');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const { challengeToken } = login.data.data as { challengeToken: string };

    await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: '000000' },
    });
    await client.req('/api/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code: generateTotp(user.secretBase32) },
    });

    const { auditLogs } = await import('../src/db/schema/audit.js');
    const rows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.actorId, user.id));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('AUTH.MFA_CHALLENGE_ISSUED');
    expect(actions).toContain('AUTH.MFA_CHALLENGE_FAILED');
    expect(actions).toContain('AUTH.LOGIN');
  });

  it('non-MFA accounts still log in with a session directly', async () => {
    const user = await createUser('no-mfa');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);
    const data = login.data.data as { mfaRequired: boolean; id: string };
    expect(data.mfaRequired).toBe(false);
    expect(data.id).toBe(user.id);
    expect(client.cookie).toMatch(/wasit_session=/);

    const count = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(count.length).toBe(1);
  });
});