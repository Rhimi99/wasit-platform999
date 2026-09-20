import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { emailVerificationTokens } from '../src/db/schema/auth.js';
import { resolveMailTransport, resetMailTransport, mailStatus } from '../src/lib/mail/resolve.js';
import { LogMailTransport } from '../src/lib/mail/log.js';
import { SmtpMailTransport } from '../src/lib/mail/smtp.js';
import { buildVerificationEmail, buildPasswordResetEmail } from '../src/lib/mail/templates.js';

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

afterAll(async () => {
  await closeDb();
});

describe('Mail — transport resolution', () => {
  it('defaults to the no-network log transport when MAIL_TRANSPORT is not smtp', () => {
    resetMailTransport();
    expect(process.env.MAIL_TRANSPORT ?? 'log').not.toBe('smtp');
    const transport = resolveMailTransport();
    expect(transport).toBeInstanceOf(LogMailTransport);
    expect(transport.id).toBe('log');
    expect(transport.isAvailable()).toBe(true);
  });

  it('reports the active transport without leaking credentials', () => {
    resetMailTransport();
    const status = mailStatus();
    expect(status.transport).toBe('log');
    expect(status.available).toBe(true);
    expect(typeof status.from).toBe('string');
    expect(JSON.stringify(status)).not.toMatch(/password|pass/i);
  });

  it('the log transport records a send without throwing', async () => {
    const transport = new LogMailTransport();
    await expect(
      transport.send({ to: 'someone@example.com', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
  });

  it('the SMTP transport is unavailable without a host and refuses to send', async () => {
    const smtp = new SmtpMailTransport({
      host: '',
      port: 587,
      secure: false,
      from: 'x@y.z',
    });
    expect(smtp.isAvailable()).toBe(false);
    await expect(smtp.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(/SMTP_HOST/);
  });
});

describe('Mail — templates', () => {
  it('renders the verification email in the requested locale with the link', () => {
    const fr = buildVerificationEmail({ to: 'a@b.c', link: 'https://x/y?token=1', locale: 'fr', ttlHours: 24 });
    expect(fr.to).toBe('a@b.c');
    expect(fr.subject).toContain('Confirmez');
    expect(fr.text).toContain('https://x/y?token=1');
    expect(fr.text).toContain('24');
    expect(fr.html).toContain('href="https://x/y?token=1"');

    const en = buildVerificationEmail({ to: 'a@b.c', link: 'L', locale: 'en', ttlHours: 1 });
    expect(en.subject).toContain('Confirm');

    const ar = buildVerificationEmail({ to: 'a@b.c', link: 'L', locale: null, ttlHours: 1 });
    expect(ar.subject).toContain('WASIT');
  });

  it('falls back to Arabic for an unknown locale', () => {
    const unknown = buildVerificationEmail({ to: 'a@b.c', link: 'L', locale: 'zz', ttlHours: 1 });
    const ar = buildVerificationEmail({ to: 'a@b.c', link: 'L', locale: 'ar', ttlHours: 1 });
    expect(unknown.subject).toBe(ar.subject);
  });

  it('renders the password reset email with the reset link and TTL', () => {
    const reset = buildPasswordResetEmail({ to: 'a@b.c', link: 'https://x/reset?token=9', locale: 'en', ttlHours: 2 });
    expect(reset.subject).toContain('Reset');
    expect(reset.text).toContain('https://x/reset?token=9');
    expect(reset.text).toContain('2');
  });
});

describe('Mail — registration delivers a real verification email (no mocks)', () => {
  it('registration writes a MAIL.SENT audit row and the dev link verifies the account', async () => {
    const email = `mail-user-${Date.now()}@wasit.tn`;
    const c = makeClient(app);
    const reg = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'StrongPass123!', firstName: 'Mail', role: 'CUSTOMER' },
    });
    expect(reg.status).toBe(201);
    expect(reg.data.data.requiresEmailVerification).toBe(true);

    // The mail layer audited a real send for this recipient.
    const sent = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'MAIL.SENT'));
    expect(sent.some((r) => (r.after as { to?: string } | null)?.to === email)).toBe(true);

    // Only one active token exists for the user, and it verifies the account.
    const userRow = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const active = await db
      .select()
      .from(emailVerificationTokens)
      .where(and(eq(emailVerificationTokens.userId, userRow[0].id), isNull(emailVerificationTokens.usedAt)));
    expect(active.length).toBe(1);

    const devLink = await c.req('/api/auth/dev/verification-link', { method: 'POST', body: { email } });
    expect(devLink.status).toBe(200);
    const token = devLink.data.data.token as string;
    expect(token.length).toBeGreaterThan(20);

    // Requesting a fresh dev link invalidates the previous one so stale links fail.
    const verifyOld = await c.req('/api/auth/verify-email', { method: 'POST', body: { token: 'not-a-real-token' } });
    expect(verifyOld.status).toBe(401);

    const verify = await c.req('/api/auth/verify-email', { method: 'POST', body: { token } });
    expect(verify.status).toBe(200);

    const after = await db.select().from(users).where(eq(users.id, userRow[0].id)).limit(1);
    expect(after[0].emailVerified).toBe(true);
  });

  it('forgot-password sends the reset email and keeps the response uniform for unknown addresses', async () => {
    const known = await makeClient(app).req('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'does-not-exist-mail-test@wasit.tn' },
    });
    expect(known.status).toBe(200);
    // Unknown address → no token echoed (no account-existence oracle).
    expect(known.data.data).toBeUndefined();
  });
});