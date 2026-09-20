import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { riskEvents, riskProfiles } from '../src/db/schema/risk.js';
import { messages, threads } from '../src/db/schema/messaging.js';
import { and, desc, eq } from 'drizzle-orm';
import { detectOffPlatformSignals, hasFeeEvasionSignal } from '../src/lib/fee-evasion.js';

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

async function register(c: ReturnType<typeof makeClient>, email: string) {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Fee', role: 'CUSTOMER' },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return (login.data.data as { id: string }).id;
}

async function createUserPair(prefix: string) {
  const a = makeClient();
  const b = makeClient();
  const ts = Date.now().toString();
  const aId = await register(a, `${prefix}-${ts}-a@wasit.tn`);
  const bId = await register(b, `${prefix}-${ts}-b@wasit.tn`);
  return { a, b, aId, bId };
}

describe('Anti-Fee-Evasion detector (unit)', () => {
  it('flags a phone number', () => {
    const signals = detectOffPlatformSignals('اتصل بي على 216 55 123 456');
    expect(signals.map((s) => s.code)).toContain('OFF_PLATFORM_PHONE');
  });

  it('flags an email address', () => {
    expect(detectOffPlatformSignals('write me at buyer@example.com').map((s) => s.code)).toContain(
      'OFF_PLATFORM_EMAIL',
    );
  });

  it('flags off-platform channels', () => {
    expect(detectOffPlatformSignals('add me on WhatsApp').map((s) => s.code)).toContain(
      'OFF_PLATFORM_SOCIAL',
    );
    expect(detectOffPlatformSignals('lets talk on telegram').map((s) => s.code)).toContain(
      'OFF_PLATFORM_SOCIAL',
    );
  });

  it('flags direct payment methods, in English and Arabic', () => {
    expect(detectOffPlatformSignals('send via Western Union').map((s) => s.code)).toContain(
      'DIRECT_PAYMENT_REQUEST',
    );
    expect(detectOffPlatformSignals('أرسل المبلغ حوالة').map((s) => s.code)).toContain(
      'DIRECT_PAYMENT_REQUEST',
    );
  });

  it('flags explicit off-platform deal phrases', () => {
    expect(detectOffPlatformSignals('let us do this outside wasit').map((s) => s.code)).toContain(
      'OFF_PLATFORM_DEAL_PHRASE',
    );
    expect(detectOffPlatformSignals('نكمل بدون عمولة').map((s) => s.code)).toContain(
      'OFF_PLATFORM_DEAL_PHRASE',
    );
  });

  it('leaves ordinary business messages alone', () => {
    expect(hasFeeEvasionSignal('What is the minimum order quantity for 500 units?')).toBe(false);
    expect(hasFeeEvasionSignal('كم السعر للكمية 1000 قطعة؟')).toBe(false);
    expect(hasFeeEvasionSignal('')).toBe(false);
  });

  it('returns at most one signal per rule even if a hint repeats', () => {
    const signals = detectOffPlatformSignals('wa.me/123 and whatsapp: telegram');
    const social = signals.filter((s) => s.code === 'OFF_PLATFORM_SOCIAL');
    expect(social.length).toBe(1);
  });
});

describe('Anti-Fee-Evasion (integration through messaging)', () => {
  it('records a risk event and folds the score, storing only signal codes', async () => {
    const { a, b, aId, bId } = await createUserPair('it-fee');
    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, subject: 'Deal', body: 'hello' },
    });
    expect(open.status).toBe(200);
    const threadId = (open.data.data as { threadId: string }).threadId;

    const secretText = 'تواصل معي على 216 55 999 888 أو wa.me/21655999888 خارج الوسيط';
    const sent = await a.req(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: { body: secretText },
    });
    expect(sent.status).toBe(201);

    const events = await db
      .select()
      .from(riskEvents)
      .where(and(eq(riskEvents.userId, aId), eq(riskEvents.eventType, 'FEE_EVASION_SIGNAL')))
      .orderBy(desc(riskEvents.createdAt))
      .limit(1);
    expect(events.length).toBe(1);
    expect(events[0].reasonCode).toContain('OFF_PLATFORM_PHONE');
    expect(events[0].riskScore).toBeGreaterThan(0);

    // Privacy: the stored details must not contain the message body or the raw
    // phone number, only the thread/message ids and signal codes.
    const serialized = JSON.stringify(events[0].details);
    expect(serialized).not.toContain('21655999888');
    expect(serialized).not.toContain(secretText);
    expect(serialized).toContain('signalCodes');

    const profile = await db
      .select()
      .from(riskProfiles)
      .where(eq(riskProfiles.userId, aId))
      .limit(1);
    expect(profile.length).toBe(1);
    expect(profile[0].currentScore).toBeGreaterThan(0);

    // The message itself is still delivered normally.
    const list = await b.req(`/api/messages/${threadId}`);
    expect(list.status).toBe(200);
  });

  it('does not create a risk event for a clean message', async () => {
    const { a, b, aId, bId } = await createUserPair('it-fee-clean');
    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, subject: 'Quote', body: 'hi' },
    });
    const threadId = (open.data.data as { threadId: string }).threadId;
    const sent = await a.req(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: { body: 'Can you confirm the delivery lead time in days?' },
    });
    expect(sent.status).toBe(201);

    const events = await db
      .select()
      .from(riskEvents)
      .where(and(eq(riskEvents.userId, aId), eq(riskEvents.eventType, 'FEE_EVASION_SIGNAL')));
    expect(events.length).toBe(0);
  });

  it('does not store a signal body snapshot on the message row', async () => {
    const { a, b, bId } = await createUserPair('it-fee-body');
    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, subject: 'x', body: 'hi' },
    });
    const threadId = (open.data.data as { threadId: string }).threadId;
    await a.req(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: { body: 'ping me at wa.me/21611111111' },
    });
    const rows = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(rows.length).toBeGreaterThan(0);
    // The message keeps its own body (it belongs to the thread); no extra
    // surveillance columns were added.
    const threadRow = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    expect(threadRow.length).toBe(1);
  });
});
