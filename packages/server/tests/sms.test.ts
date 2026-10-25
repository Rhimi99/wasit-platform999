import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, phoneVerificationTokens } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { resolveSmsTransport, resetSmsTransport, smsStatus } from '../src/lib/sms/resolve.js';
import { LogSmsTransport, maskPhone } from '../src/lib/sms/log.js';
import { HttpSmsTransport } from '../src/lib/sms/http.js';
import { buildPhoneVerificationSms } from '../src/lib/sms/templates.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import { hashToken } from '../src/lib/security.js';
import { newId } from '../src/lib/ids.js';
import { verifyPhoneCode } from '../src/modules/auth/service.js';

const app = createApp();

// Distinct IPs keep each case in its own rate-limit bucket (mirrors other suites).
let ipCounter = 200;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function makeClient(ip = nextIp()) {
  let cookie = '';
  return {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

/** Registers a phone-bearing user and logs in, returning the authenticated client. */
async function registerAndLogin(phone: string, locale = 'ar') {
  const c = makeClient();
  const email = `sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Sms', phone, locale },
  });
  expect(reg.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return { c, email, userId: row.id };
}

/**
 * Registers a user and inserts a known, unexpired phone code directly, so the
 * concurrency and replay cases can drive the same code without depending on the
 * random one the send path generates.
 */
async function registerWithKnownCode(phone: string) {
  const { c, email, userId } = await registerAndLogin(phone);
  const code = '654321';
  await db.insert(phoneVerificationTokens).values({
    id: newId(),
    userId,
    tokenHash: hashToken(code),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return { c, email, userId, code };
}

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  await resetRateLimitStore();
  await closeDb();
});

describe('SMS — transport resolution', () => {
  it('defaults to the no-network log transport when SMS_TRANSPORT is not http', () => {
    resetSmsTransport();
    expect(process.env.SMS_TRANSPORT ?? 'log').not.toBe('http');
    const transport = resolveSmsTransport();
    expect(transport).toBeInstanceOf(LogSmsTransport);
    expect(transport.id).toBe('log');
    expect(transport.isAvailable()).toBe(true);
  });

  it('reports the active transport without leaking credentials', () => {
    resetSmsTransport();
    const status = smsStatus();
    expect(status.transport).toBe('log');
    expect(status.available).toBe(true);
    expect(Object.keys(status)).toEqual(['transport', 'available', 'senderConfigured']);
  });

  it('the log transport records a send without throwing', async () => {
    await expect(
      new LogSmsTransport().send({ to: '+21620123456', text: 'code 123456' }),
    ).resolves.toBeUndefined();
  });

  it('the HTTP transport is unavailable without a gateway URL and refuses to send', async () => {
    const http = new HttpSmsTransport({
      url: '',
      auth: { scheme: 'none' },
      sender: 'WASIT',
      toField: 'to',
      textField: 'text',
      senderField: 'from',
    });
    expect(http.isAvailable()).toBe(false);
    await expect(http.send({ to: '+21620123456', text: 'x' })).rejects.toThrow(/SMS_HTTP_URL/);
  });

  it('the HTTP transport requires a token when the bearer scheme is selected', () => {
    const http = new HttpSmsTransport({
      url: 'https://gateway.example/send',
      auth: { scheme: 'bearer' },
      sender: 'WASIT',
      toField: 'to',
      textField: 'text',
      senderField: 'from',
    });
    expect(http.isAvailable()).toBe(false);
  });
});

describe('SMS — templates and masking', () => {
  it('renders the verification code in the requested locale', () => {
    const ar = buildPhoneVerificationSms({ to: '+21620123456', code: '123456', locale: 'ar', ttlMinutes: 10 });
    expect(ar.to).toBe('+21620123456');
    expect(ar.text).toContain('123456');
    expect(ar.text).toContain('10');

    const fr = buildPhoneVerificationSms({ to: '+21620123456', code: '123456', locale: 'fr', ttlMinutes: 5 });
    expect(fr.text).toContain('Code');
    expect(fr.text).toContain('123456');

    const en = buildPhoneVerificationSms({ to: '+21620123456', code: '123456', locale: 'en', ttlMinutes: 5 });
    expect(en.text).toContain('code');
  });

  it('falls back to Arabic for an unknown locale', () => {
    const unknown = buildPhoneVerificationSms({ to: '+21620123456', code: '1', locale: 'zz', ttlMinutes: 1 });
    const ar = buildPhoneVerificationSms({ to: '+21620123456', code: '1', locale: 'ar', ttlMinutes: 1 });
    expect(unknown.text).toBe(ar.text);
  });

  it('masks all but the last four digits of a phone number', () => {
    expect(maskPhone('+21620123456')).toBe('*******3456');
    expect(maskPhone('123')).toBe('***');
  });
});

describe('SMS — phone verification end to end (real DB, no mocks)', () => {
  it('registration stores the normalized phone and unverified state', async () => {
    const phone = '+216 20 111 222';
    const { userId } = await registerAndLogin(phone, 'fr');
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phone).toBe('+21620111222');
    expect(row.phoneVerified).toBe(false);
  });

  it('rejects a malformed phone number at registration', async () => {
    const c = makeClient();
    const r = await c.req('/api/auth/register', {
      method: 'POST',
      body: { email: `bad-phone-${Date.now()}@wasit.tn`, password: 'StrongPass123!', phone: 'not-a-phone' },
    });
    expect(r.status).toBe(422);
  });

  it('sends a code, audits it, and verifies the phone with the dev seam', async () => {
    const { c, email, userId } = await registerAndLogin('+21620999001');

    const send = await c.req('/api/auth/phone/send', { method: 'POST' });
    expect(send.status).toBe(200);

    // A real SMS.SENT audit row was written (log transport, but a real dispatch).
    const sent = await db.select().from(auditLogs).where(eq(auditLogs.action, 'SMS.SENT'));
    expect(sent.length).toBeGreaterThan(0);
    // The audit row never stores the full number.
    expect(JSON.stringify(sent.map((r) => r.after))).not.toContain('+21620999001');

    // Exactly one active token is stored, and it stores only a hash.
    const active = await db
      .select()
      .from(phoneVerificationTokens)
      .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)));
    expect(active.length).toBe(1);

    const dev = await c.req('/api/auth/dev/phone-code', { method: 'POST', body: { email } });
    expect(dev.status).toBe(200);
    const code = dev.data.data.code as string;
    expect(code).toMatch(/^\d{6}$/);

    const verify = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code } });
    expect(verify.status).toBe(200);

    const [after] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(after.phoneVerified).toBe(true);

    const auditVerify = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AUTH.PHONE_VERIFIED'));
    expect(auditVerify.some((r) => r.entityId === userId)).toBe(true);
  });

  it('rejects a wrong code and blocks after the attempt cap', async () => {
    const { c, userId } = await registerAndLogin('+21620999002');
    const send = await c.req('/api/auth/phone/send', { method: 'POST' });
    expect(send.status).toBe(200);

    // Five wrong attempts are all rejected and increment the counter.
    for (let i = 0; i < 5; i += 1) {
      const bad = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code: '000000' } });
      expect(bad.status).toBe(401);
    }
    const [token] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)));
    expect(token.attempts).toBeGreaterThanOrEqual(5);

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phoneVerified).toBe(false);
  });

  it('rejects a code with the wrong shape before touching the DB', async () => {
    const { c } = await registerAndLogin('+21620999003');
    await c.req('/api/auth/phone/send', { method: 'POST' });
    const r = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code: '123' } });
    expect(r.status).toBe(422);
  });

  it('requires authentication to request or confirm a code', async () => {
    const anon = makeClient();
    const send = await anon.req('/api/auth/phone/send', { method: 'POST' });
    expect(send.status).toBe(401);
    const verify = await anon.req('/api/auth/phone/verify', { method: 'POST', body: { code: '123456' } });
    expect(verify.status).toBe(401);
  });

  it('issues a fresh code on resend, invalidating the previous one', async () => {
    const { c, email } = await registerAndLogin('+21620999004');
    await c.req('/api/auth/phone/send', { method: 'POST' });
    const first = await c.req('/api/auth/dev/phone-code', { method: 'POST', body: { email } });
    const firstCode = first.data.data.code as string;

    const second = await c.req('/api/auth/dev/phone-code', { method: 'POST', body: { email } });
    const secondCode = second.data.data.code as string;

    // The old code is dead; the newest one works.
    const oldTry = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code: firstCode } });
    expect(oldTry.status).toBe(401);
    const newTry = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code: secondCode } });
    expect(newTry.status).toBe(200);
  });

  it('refuses to send a code once the phone is already verified', async () => {
    const { c, email } = await registerAndLogin('+21620999005');
    await c.req('/api/auth/phone/send', { method: 'POST' });
    const dev = await c.req('/api/auth/dev/phone-code', { method: 'POST', body: { email } });
    const code = dev.data.data.code as string;
    expect((await c.req('/api/auth/phone/verify', { method: 'POST', body: { code } })).status).toBe(200);

    const again = await c.req('/api/auth/phone/send', { method: 'POST' });
    expect(again.status).toBe(422);
  });

  it('exposes channel status on the health surface', async () => {
    const c = makeClient();
    const res = await c.req('/api/health/channels');
    expect(res.status).toBe(200);
    expect(res.data.mail.transport).toBe('log');
    expect(res.data.sms.transport).toBe('log');
    expect(JSON.stringify(res.data)).not.toMatch(/password|token/i);
  });
});

describe('SMS — phone code is single-use under concurrency', () => {
  it('rejects a replayed code after it has been consumed', async () => {
    const { c, userId, code } = await registerWithKnownCode('+21620999010');

    const first = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code } });
    expect(first.status).toBe(200);

    const replay = await c.req('/api/auth/phone/verify', { method: 'POST', body: { code } });
    expect(replay.status).toBe(401);

    // Exactly one verification was recorded, and the phone stayed verified.
    const verifiedAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, 'AUTH.PHONE_VERIFIED')));
    expect(verifiedAudits.length).toBe(1);
  });

  it('lets only one of many concurrent requests consume the same code', async () => {
    const { userId, code } = await registerWithKnownCode('+21620999011');

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => verifyPhoneCode(db, userId, code)),
    );
    const winners = results.filter((r) => r.status === 'fulfilled').length;
    const losers = results.filter((r) => r.status === 'rejected').length;
    expect(winners).toBe(1);
    expect(losers).toBe(11);

    // One claim, one audit row, one consumed token — no partial duplicates.
    const verifiedAudits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, userId), eq(auditLogs.action, 'AUTH.PHONE_VERIFIED')));
    expect(verifiedAudits.length).toBe(1);

    const [token] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(eq(phoneVerificationTokens.userId, userId))
      .limit(1);
    expect(token.usedAt).not.toBeNull();

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phoneVerified).toBe(true);
  });

  it('does not leave the phone verified or burn the code when the transaction fails', async () => {
    const { userId, code } = await registerWithKnownCode('+21620999012');

    // A failure that rolls the whole verification back: the claim and the
    // phone-verified effect must not survive it.
    await expect(
      db.transaction(async (outer) => {
        await verifyPhoneCode(outer as unknown as typeof db, userId, code);
        throw new Error('forced-rollback');
      }),
    ).rejects.toThrow('forced-rollback');

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phoneVerified).toBe(false);

    // The code was not consumed, so a legitimate retry still works.
    const [token] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)))
      .limit(1);
    expect(token).toBeTruthy();

    const retry = await verifyPhoneCode(db, userId, code);
    expect(retry).toBeUndefined();
    const [after] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(after.phoneVerified).toBe(true);
  });

  it('still counts a wrong code toward the attempt cap and never verifies', async () => {
    const { userId } = await registerWithKnownCode('+21620999013');

    // Five wrong attempts are rejected and each increments the counter.
    for (let i = 0; i < 5; i += 1) {
      await expect(verifyPhoneCode(db, userId, '000000')).rejects.toThrow(/Invalid or expired/);
    }
    const [token] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(and(eq(phoneVerificationTokens.userId, userId), isNull(phoneVerificationTokens.usedAt)))
      .limit(1);
    expect(token.attempts).toBeGreaterThanOrEqual(5);
    expect(token.usedAt).toBeNull();

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phoneVerified).toBe(false);
  });

  it('rejects an expired code without consuming it', async () => {
    const { userId } = await registerAndLogin('+21620999014');
    const code = '111222';
    await db.insert(phoneVerificationTokens).values({
      id: newId(),
      userId,
      tokenHash: hashToken(code),
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(verifyPhoneCode(db, userId, code)).rejects.toThrow(/Invalid or expired/);

    const [token] = await db
      .select()
      .from(phoneVerificationTokens)
      .where(eq(phoneVerificationTokens.userId, userId))
      .limit(1);
    expect(token.usedAt).toBeNull();

    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(row.phoneVerified).toBe(false);
  });
});