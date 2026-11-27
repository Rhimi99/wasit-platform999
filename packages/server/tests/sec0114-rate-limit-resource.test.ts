import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import { setRateLimitStore } from '../src/lib/rate-limit/resolve.js';
import { Semaphore } from '../src/lib/concurrency/semaphore.js';

/**
 * 011.4 — API resource protection & rate limiting.
 *
 * Exercises the real app end-to-end: the general `/api` backstop, the tighter
 * AI/search/video limits, the request-body cap (413), the `Retry-After` header on
 * a 429, the per-user active-agent-task cap, and the render-concurrency
 * semaphore. Limits are asserted through actual HTTP status codes on real routes,
 * never by calling middleware in isolation.
 */

const app = createApp();

// Keep the suite fast and deterministic: these bounds are read by the app-level
// limiters at request time, so overriding them before the requests makes the
// thresholds small enough to trip without thousands of calls.
const ORIGINAL = {
  api: env.RATE_LIMIT_API_MAX,
  ai: env.RATE_LIMIT_AI_MAX,
  aiIp: env.RATE_LIMIT_AI_IP_MAX,
  search: env.RATE_LIMIT_SEARCH_MAX,
  video: env.RATE_LIMIT_VIDEO_MAX,
  body: env.MAX_REQUEST_BODY_BYTES,
  maxTasks: env.AI_AGENT_MAX_ACTIVE_TASKS_PER_USER,
};

beforeAll(async () => {
  await resetRateLimitStore();
});

afterAll(async () => {
  Object.assign(env, {
    RATE_LIMIT_API_MAX: ORIGINAL.api,
    RATE_LIMIT_AI_MAX: ORIGINAL.ai,
    RATE_LIMIT_AI_IP_MAX: ORIGINAL.aiIp,
    RATE_LIMIT_SEARCH_MAX: ORIGINAL.search,
    RATE_LIMIT_VIDEO_MAX: ORIGINAL.video,
    MAX_REQUEST_BODY_BYTES: ORIGINAL.body,
    AI_AGENT_MAX_ACTIVE_TASKS_PER_USER: ORIGINAL.maxTasks,
  });
  await resetRateLimitStore();
  await closeDb();
});

let ipSeq = 0;
const ipSubnet = Math.floor(Math.random() * 250) + 1;
function freshIp(): string {
  ipSeq += 1;
  return `198.18.${ipSubnet}.${(ipSeq % 250) + 1}`;
}

/**
 * Reset counters and pin every limit to a value that cannot interfere with an
 * unrelated test, then let the caller raise only what it exercises. The limits
 * are read per request, so mutating `env` here is observed immediately.
 */
async function resetLimits(overrides: Partial<Record<string, number>> = {}): Promise<void> {
  await resetRateLimitStore();
  Object.assign(env, {
    RATE_LIMIT_API_MAX: 1000,
    RATE_LIMIT_AI_MAX: 1000,
    RATE_LIMIT_AI_IP_MAX: 1000,
    RATE_LIMIT_SEARCH_MAX: 1000,
    RATE_LIMIT_VIDEO_MAX: 1000,
    MAX_REQUEST_BODY_BYTES: ORIGINAL.body,
    ...overrides,
  });
}

function makeClient(ip = freshIp()) {
  let cookie = '';
  return {
    ip,
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

async function createUser(
  role: string,
  opts: { verified?: boolean; ip?: string } = {},
): Promise<ReturnType<typeof makeClient>> {
  const email = `it-rl4-${role.toLowerCase()}-${randomUUID()}@wasit.tn`;
  const hash = await argon2.hash('StrongPass123!');
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email,
      passwordHash: hash,
      firstName: 'Rl',
      emailVerified: opts.verified ?? true,
      isActive: true,
    })
    .returning();
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  if (!roleRow) throw new Error(`missing role ${role}`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleId: roleRow.id });

  const client = makeClient(opts.ip);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login for ${role}`).toBe(200);
  return client;
}

describe('011.4 — request body cap (413)', () => {
  it('rejects an oversized JSON body with 413 before the handler runs', async () => {
    await resetLimits({ MAX_REQUEST_BODY_BYTES: 512 });
    const client = makeClient();
    // A body well past the (temporarily tiny) cap. The route would reject it
    // anyway, but the point is the body never reaches the route.
    const r = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: 'x'.repeat(2000), password: 'y'.repeat(2000) },
    });
    expect(r.status).toBe(413);
    expect(r.data.error.code).toBe('PAYLOAD_TOO_LARGE');
    // The rejection must not echo any size or internal detail.
    expect(JSON.stringify(r.data)).not.toMatch(/512|byte|buffer|stack/i);
  });

  it('still accepts a normal body under the cap', async () => {
    await resetLimits({ MAX_REQUEST_BODY_BYTES: 512 });
    const client = makeClient();
    const r = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@wasit.tn', password: 'StrongPass123!' },
    });
    // Reaches the route (401 for unknown credentials), not 413.
    expect(r.status).not.toBe(413);
  });
});

describe('011.4 — general API backstop', () => {
  it('sheds a burst over the general limit with a 429 and Retry-After, without leaking internals', async () => {
    await resetLimits({ RATE_LIMIT_API_MAX: 3 });
    const client = makeClient();

    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof client.req>> | null = null;
    for (let i = 0; i < 5; i++) {
      last = await client.req('/api/categories');
      statuses.push(last.status);
    }
    // First 3 pass; the 4th and 5th are shed.
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);

    expect(last!.data.error.code).toBe('RATE_LIMITED');
    expect(last!.res.headers.get('retry-after')).toBe(String(env.RATE_LIMIT_API_WINDOW_SECONDS));
    // No bucket key, address or store detail is surfaced.
    expect(JSON.stringify(last!.data)).not.toMatch(/198\.18|bucket|memory|postgres|ip:/i);
  });

  it('exempts /api/auth and /api/health from the general backstop', async () => {
    await resetLimits({ RATE_LIMIT_API_MAX: 1 });
    const client = makeClient();
    // Blow past the general limit on a normal route...
    await client.req('/api/categories');
    await client.req('/api/categories');
    const over = await client.req('/api/categories');
    expect(over.status).toBe(429);
    // ...but the health probe and the auth surface are unaffected.
    const health = await client.req('/api/health/live');
    expect(health.status).toBe(200);
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@wasit.tn', password: 'StrongPass123!' },
    });
    expect(login.status).not.toBe(429);
  });
});

describe('011.4 — AI endpoint limits', () => {
  it('limits AI calls per authenticated user, independently of other users', async () => {
    await resetLimits({ RATE_LIMIT_AI_MAX: 2 });

    const a = await createUser('CUSTOMER');
    const b = await createUser('CUSTOMER');

    // First two AI calls for A pass; the third is shed.
    expect((await a.req('/api/ai/status')).status).toBe(200);
    expect((await a.req('/api/ai/status')).status).toBe(200);
    const aThird = await a.req('/api/ai/status');
    expect(aThird.status).toBe(429);
    expect(aThird.data.error.code).toBe('RATE_LIMITED');
    expect(aThird.res.headers.get('retry-after')).toBeTruthy();

    // B is unaffected — the limit is per user, not global.
    expect((await b.req('/api/ai/status')).status).toBe(200);
  });

  it('enforces a per-IP backstop on AI even across users', async () => {
    await resetLimits({ RATE_LIMIT_AI_IP_MAX: 2 });
    const ip = freshIp();

    const a = await createUser('CUSTOMER', { ip });
    const b = await createUser('CUSTOMER', { ip });

    expect((await a.req('/api/ai/status')).status).toBe(200);
    expect((await b.req('/api/ai/status')).status).toBe(200);
    // Third AI call from the same host, different user: the IP backstop fires.
    const c = await b.req('/api/ai/status');
    expect(c.status).toBe(429);
  });

  it('never bypasses auth: an anonymous AI call is still 401, not served', async () => {
    await resetLimits();
    const anon = makeClient();
    const r = await anon.req('/api/ai/status');
    expect(r.status).toBe(401);
  });
});

describe('011.4 — search limit', () => {
  it('limits public search per client IP', async () => {
    await resetLimits({ RATE_LIMIT_SEARCH_MAX: 2 });
    const client = makeClient();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await client.req('/api/search?q=oil');
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses[2]).toBe(429);
    expect(statuses[3]).toBe(429);
  });
});

describe('011.4 — marketing video limit and concurrency', () => {
  it('limits video generation per user (tighter than the general limit)', async () => {
    await resetLimits({ RATE_LIMIT_VIDEO_MAX: 1 });
    const client = await createUser('SUPPLIER');
    // The first call reaches the route (it fails validation for a missing
    // product, but it is not shed); the second is refused by the limiter.
    const first = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: randomUUID() },
    });
    expect(first.status).not.toBe(429);
    const second = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: randomUUID() },
    });
    expect(second.status).toBe(429);
    expect(second.data.error.code).toBe('RATE_LIMITED');
  });
});

describe('011.4 — per-user active agent task cap', () => {
  it('refuses new tasks once the user holds the maximum active tasks', async () => {
    await resetLimits({ AI_AGENT_MAX_ACTIVE_TASKS_PER_USER: 2 });
    const client = await createUser('SUPPLIER');

    // marketing-agent does not require approval, so each task settles
    // immediately to a terminal status. Use an approval-gated agent so the
    // tasks stay active (awaiting_approval) and accumulate.
    const mk = () =>
      client.req('/api/ai/agents/sales-agent/tasks', { method: 'POST', body: { input: {} } });

    const first = await mk();
    expect(first.status).toBe(201);
    const second = await mk();
    expect(second.status).toBe(201);
    const third = await mk();
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe('RATE_LIMITED');
  });
});

describe('011.4 — X-Forwarded-For spoofing cannot move the bucket', () => {
  it('ignores a rotating XFF on the general limit: the real peer is the bucket key', async () => {
    await resetLimits({ RATE_LIMIT_API_MAX: 2 });
    // Same real peer for every call (default TRUSTED_PROXY_HOPS=0 → the socket
    // address is used and XFF is ignored), but a different spoofed XFF each time.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.request('/api/categories', {
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      statuses.push(res.status);
    }
    // If XFF were trusted, each call would get a fresh bucket and never 429.
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses[2]).toBe(429);
    expect(statuses[3]).toBe(429);
  });

  it('ignores a rotating XFF on the search limit too', async () => {
    await resetLimits({ RATE_LIMIT_SEARCH_MAX: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.request('/api/search?q=oil', {
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 2).every((s) => s !== 429)).toBe(true);
    expect(statuses[2]).toBe(429);
  });
});

describe('011.4 — fail-closed when the store is unavailable', () => {
  it('returns 503 (not a silent pass) when the rate-limit store throws', async () => {
    await resetLimits();
    // Pin a store whose increment always fails, simulating a Postgres outage.
    setRateLimitStore({
      id: 'postgres',
      increment: async () => {
        throw new Error('connection terminated unexpectedly');
      },
      reset: async () => {},
      purgeExpired: async () => 0,
      probe: async () => {},
    });
    try {
      const client = makeClient();
      const r = await client.req('/api/categories');
      // Fail closed: the request is refused, not allowed through unguarded.
      expect(r.status).toBe(503);
      expect(r.data.error.code).toBe('SERVICE_UNAVAILABLE');
      // The internal error message is never surfaced to the client.
      expect(JSON.stringify(r.data)).not.toMatch(/connection terminated|postgres|stack/i);
    } finally {
      setRateLimitStore(null);
      await resetRateLimitStore();
    }
  });
});

describe('011.4 — Semaphore (render concurrency cap)', () => {
  it('caps concurrent holders and sheds waiters after the timeout', async () => {
    const sem = new Semaphore(1);
    expect(sem.free).toBe(1);

    await sem.acquire(1000);
    expect(sem.free).toBe(0);

    // A second acquire cannot proceed while the slot is held; it sheds with 503.
    await expect(sem.acquire(20)).rejects.toMatchObject({ statusCode: 503 });

    sem.release();
    expect(sem.free).toBe(1);
  });

  it('hands a released slot to a queued waiter instead of shedding it', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(1000);
    const waiter = sem.acquire(1000);
    expect(sem.waiting).toBe(1);
    sem.release();
    await expect(waiter).resolves.toBeUndefined();
    expect(sem.free).toBe(0);
    sem.release();
  });

  it('releases the slot even when the guarded work throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(1000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sem.free).toBe(1);
  });
});
