import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { aiSpendLimits } from '../src/db/schema/ai-spend.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import { setRateLimitStore } from '../src/lib/rate-limit/resolve.js';
import { MemoryRateLimitStore } from '../src/lib/rate-limit/memory.js';
import type { RateLimitStore } from '../src/lib/rate-limit/port.js';
import { isAiPathCovered } from '../src/lib/rate-limit/ai-policy.js';

/**
 * AI-RATE-LIMIT-01 — the AI surfaces are the only ones where a request can cost
 * money, so each route class has its own ceiling. These tests drive the real app
 * over real HTTP: no middleware is called in isolation, and every assertion is a
 * status code, a header, or a row in the shared counter table.
 */

const app = createApp();

const ENV_KEYS = [
  'RATE_LIMIT_AI_MAX',
  'RATE_LIMIT_AI_IP_MAX',
  'RATE_LIMIT_AI_WINDOW_SECONDS',
  'AI_RATE_LIMIT_READ_MAX',
  'AI_RATE_LIMIT_FEATURE_MAX',
  'AI_RATE_LIMIT_AGENT_MAX',
  'AI_RATE_LIMIT_MEMORY_MAX',
  'AI_RATE_LIMIT_ADMIN_READ_MAX',
  'AI_RATE_LIMIT_ADMIN_CONTROL_MAX',
  'AI_RATE_LIMIT_PROVIDER_MAX',
  'AI_RATE_LIMIT_ADMIN_MULTIPLIER',
  'AI_RATE_LIMIT_REQUIRE_DURABLE',
  'AI_RATE_LIMIT_ALLOW_MEMORY_STORE',
  'AI_CONFIG_ENVIRONMENT',
] as const;

const ORIGINAL: Record<string, unknown> = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));

/** Every test runs in its own config environment, so no other suite's caps leak in. */
const TEST_ENV = 'rl-test' as typeof env.AI_CONFIG_ENVIRONMENT & string;

beforeAll(async () => {
  (env as Record<string, unknown>).AI_CONFIG_ENVIRONMENT = TEST_ENV;
  await resetRateLimitStore();
});

afterAll(async () => {
  Object.assign(env, ORIGINAL);
  await resetRateLimitStore();
  await closeDb();
});

/** Neutralise every knob, then let the caller tighten the one under test. */
async function resetLimits(overrides: Record<string, unknown> = {}): Promise<void> {
  await resetRateLimitStore();
  Object.assign(env, {
    RATE_LIMIT_AI_MAX: undefined,
    RATE_LIMIT_AI_IP_MAX: 10_000,
    RATE_LIMIT_AI_WINDOW_SECONDS: 60,
    AI_RATE_LIMIT_READ_MAX: 120,
    AI_RATE_LIMIT_FEATURE_MAX: 30,
    AI_RATE_LIMIT_AGENT_MAX: 15,
    AI_RATE_LIMIT_MEMORY_MAX: 60,
    AI_RATE_LIMIT_ADMIN_READ_MAX: 120,
    AI_RATE_LIMIT_ADMIN_CONTROL_MAX: 30,
    AI_RATE_LIMIT_PROVIDER_MAX: 10,
    AI_RATE_LIMIT_ADMIN_MULTIPLIER: 3,
    AI_RATE_LIMIT_REQUIRE_DURABLE: undefined,
    AI_RATE_LIMIT_ALLOW_MEMORY_STORE: false,
    ...overrides,
  });
  // This suite runs in its own config environment; clear any GLOBAL cap a
  // previous test wrote there so the spend-guard assertion is deterministic.
  await db
    .delete(aiSpendLimits)
    .where(and(eq(aiSpendLimits.environment, TEST_ENV), eq(aiSpendLimits.scope, 'GLOBAL')));
}

let ipSeq = 0;
const ipSubnet = Math.floor(Math.random() * 250) + 1;
function freshIp(): string {
  ipSeq += 1;
  return `198.18.${ipSubnet}.${(ipSeq % 250) + 1}`;
}

function makeClient(ip = freshIp()) {
  let cookie = '';
  return {
    ip,
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip, ...(options.headers ?? {}) };
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

async function createUser(roleName: string) {
  const email = `it-airl-${roleName.toLowerCase()}-${randomUUID()}@wasit.tn`;
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email,
      passwordHash: await argon2.hash('StrongPass123!'),
      firstName: 'Rl',
      emailVerified: true,
      isActive: true,
    })
    .returning();
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!roleRow) throw new Error(`missing role ${roleName}`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: user.id, roleId: roleRow.id });

  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login for ${roleName}`).toBe(200);
  return { client, userId: user.id };
}

describe('AI-RATE-LIMIT-01 — per-class ceilings', () => {
  beforeEach(async () => {
    await resetLimits();
  });

  it('lets a caller stay within its class limit', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 3 });
    const { client } = await createUser('CUSTOMER');
    for (let i = 0; i < 3; i += 1) {
      expect((await client.req('/api/ai/status')).status).toBe(200);
    }
  });

  it('refuses the request over the limit with 429, a stable code and Retry-After', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 2 });
    const { client } = await createUser('CUSTOMER');
    await client.req('/api/ai/status');
    await client.req('/api/ai/status');
    const over = await client.req('/api/ai/status');

    expect(over.status).toBe(429);
    expect(over.data.error.code).toBe('RATE_LIMITED');
    expect(over.res.headers.get('retry-after')).toBe(String(env.RATE_LIMIT_AI_WINDOW_SECONDS));
    // Nothing about the bucket, the address or the store may leak.
    expect(JSON.stringify(over.data)).not.toMatch(/198\.18|bucket|ip:|user:|memory|postgres/i);
  });

  it('keeps buckets separate per user', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 2 });
    const a = (await createUser('CUSTOMER')).client;
    const b = (await createUser('CUSTOMER')).client;

    expect((await a.req('/api/ai/status')).status).toBe(200);
    expect((await a.req('/api/ai/status')).status).toBe(200);
    expect((await a.req('/api/ai/status')).status).toBe(429);

    // B is untouched: the limit is per identity, not global.
    expect((await b.req('/api/ai/status')).status).toBe(200);
  });

  it('applies a tighter ceiling to money paths than to reads, in separate buckets', async () => {
    await resetLimits({ AI_RATE_LIMIT_FEATURE_MAX: 2, AI_RATE_LIMIT_READ_MAX: 5 });
    const { client } = await createUser('CUSTOMER');

    const run = () =>
      client.req('/api/ai/run', { method: 'POST', body: { requestType: 'status', user: 'hello' } });

    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    const third = await run();
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe('RATE_LIMITED');

    // Exhausting the feature bucket did not consume the read bucket.
    for (let i = 0; i < 5; i += 1) {
      expect((await client.req('/api/ai/status')).status).toBe(200);
    }
  });

  it('limits agent task creation in its own class', async () => {
    await resetLimits({ AI_RATE_LIMIT_AGENT_MAX: 1, AI_RATE_LIMIT_READ_MAX: 50 });
    const { client } = await createUser('SUPPLIER');

    const first = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(first.status).not.toBe(429);
    const second = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: {} },
    });
    expect(second.status).toBe(429);

    // Reads are unaffected by the agent bucket.
    expect((await client.req('/api/ai/agents')).status).toBe(200);
  });

  it('applies a tight ceiling to provider configuration and live probes', async () => {
    await resetLimits({ AI_RATE_LIMIT_PROVIDER_MAX: 2, AI_RATE_LIMIT_ADMIN_CONTROL_MAX: 100 });
    const { client } = await createUser('ADMIN');

    const patch = () =>
      client.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: false } });

    expect((await patch()).status).not.toBe(429);
    expect((await patch()).status).not.toBe(429);
    const third = await patch();
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe('RATE_LIMITED');
  });

  it('caps admin spend management (the guard itself is protected)', async () => {
    await resetLimits({ AI_RATE_LIMIT_ADMIN_CONTROL_MAX: 1, AI_RATE_LIMIT_ADMIN_MULTIPLIER: 1 });
    const { client } = await createUser('ADMIN');

    const read = await client.req('/api/admin/ai/spend/guard');
    expect(read.status).toBe(200);
    const secondRead = await client.req('/api/admin/ai/spend/guard');
    expect(secondRead.status).not.toBe(429); // reads have their own, roomier class

    const put = await client.req('/api/admin/ai/spend/guard', {
      method: 'PUT',
      body: { dailyMaxCost: '5', monthlyMaxCost: '20' },
    });
    expect(put.status).toBe(200);
    const over = await client.req('/api/admin/ai/spend/guard', {
      method: 'PUT',
      body: { dailyMaxCost: '6', monthlyMaxCost: '21' },
    });
    expect(over.status).toBe(429);
  });
});

describe('AI-RATE-LIMIT-01 — identity cannot be forged', () => {
  beforeEach(async () => {
    await resetLimits();
  });

  it('ignores client-supplied identity headers', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 2 });
    const { client } = await createUser('CUSTOMER');

    // A client that pretends to be someone else on every call must still be
    // counted against its own authenticated id.
    for (let i = 0; i < 2; i += 1) {
      expect(
        (await client.req('/api/ai/status', {
          headers: { 'x-user-id': `spoof-${i}`, 'x-wasit-user': `spoof-${i}`, 'x-forwarded-for': `203.0.113.${i}` },
        })).status,
      ).toBe(200);
    }
    expect(
      (await client.req('/api/ai/status', {
        headers: { 'x-user-id': 'spoof-final', 'x-wasit-user': 'spoof-final', 'x-forwarded-for': '203.0.113.99' },
      })).status,
    ).toBe(429);
  });

  it('keeps the per-IP backstop on AI surfaces even across users', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 1000, RATE_LIMIT_AI_IP_MAX: 2 });
    // With no trusted proxy configured every request resolves to the same
    // socket-derived bucket, which is exactly the "one host, many accounts" case.
    const a = (await createUser('CUSTOMER')).client;
    const b = (await createUser('CUSTOMER')).client;
    expect((await a.req('/api/ai/status')).status).toBe(200);
    expect((await b.req('/api/ai/status')).status).toBe(200);
    expect((await b.req('/api/ai/status')).status).toBe(429);
  });
});

describe('AI-RATE-LIMIT-01 — concurrency and store failure', () => {
  beforeEach(async () => {
    await resetLimits();
  });

  it('does not let a parallel burst exceed the ceiling', async () => {
    await resetLimits({ AI_RATE_LIMIT_READ_MAX: 5 });
    const { client } = await createUser('CUSTOMER');

    const results = await Promise.all(Array.from({ length: 25 }, () => client.req('/api/ai/status')));
    const passed = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 429).length;

    expect(passed).toBe(5);
    expect(refused).toBe(20);
  });

  /** A store that fails only for the AI classes under test. */
  function failingFor(prefixes: readonly string[]): RateLimitStore {
    return {
      id: 'memory',
      async increment(key: string) {
        if (prefixes.some((p) => key.startsWith(`${p}:`))) throw new Error('counter store unavailable');
        return 1;
      },
      async reset() {},
      async purgeExpired() {
        return 0;
      },
      async probe() {},
    };
  }

  it('fails closed for money paths when the counter store is down', async () => {
    const failing = failingFor(['ai.feature']);
    const { client } = await createUser('CUSTOMER');
    setRateLimitStore(failing);
    try {
      const run = await client.req('/api/ai/run', {
        method: 'POST',
        body: { requestType: 'status', user: 'hello' },
      });
      expect(run.status).toBe(503);
      expect(run.data.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(run.data)).not.toMatch(/counter store|increment|memory|postgres/i);
    } finally {
      await resetRateLimitStore();
    }
  });

  it('keeps read-only local surfaces available when the counter store is down', async () => {
    const failing = failingFor(['ai.read']);
    const { client } = await createUser('CUSTOMER');
    setRateLimitStore(failing);
    try {
      const read = await client.req('/api/ai/status');
      expect(read.status).toBe(200);
    } finally {
      await resetRateLimitStore();
    }
  });

  it('refuses money paths on an in-process store when a shared one is required', async () => {
    await resetLimits({ AI_RATE_LIMIT_REQUIRE_DURABLE: true });
    const { client } = await createUser('CUSTOMER');
    setRateLimitStore(new MemoryRateLimitStore());
    try {
      const run = await client.req('/api/ai/run', {
        method: 'POST',
        body: { requestType: 'status', user: 'hello' },
      });
      expect(run.status).toBe(503);
      // Reads keep working: they cannot spend.
      expect((await client.req('/api/ai/status')).status).toBe(200);
    } finally {
      await resetRateLimitStore();
    }
  });
});

describe('AI-RATE-LIMIT-01 — coverage and boundaries', () => {
  beforeEach(async () => {
    await resetLimits();
  });

  it('assigns a class to every non-GET AI route registered on the app', () => {
    const uncovered = app.routes
      .filter((route) => route.method !== 'ALL')
      .filter((route) => route.path.startsWith('/api/ai/') || route.path.startsWith('/api/admin/ai/'))
      .filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method.toUpperCase()))
      .filter((route) => !isAiPathCovered(route.path, route.method))
      .map((route) => `${route.method} ${route.path}`);

    expect(uncovered).toEqual([]);
  });

  it('does not let platform staff escape the money-path limit', async () => {
    await resetLimits({ AI_RATE_LIMIT_FEATURE_MAX: 1, AI_RATE_LIMIT_ADMIN_MULTIPLIER: 3 });
    const { client } = await createUser('ADMIN');
    const run = () =>
      client.req('/api/ai/run', { method: 'POST', body: { requestType: 'status', user: 'hello' } });

    expect((await run()).status).toBe(200);
    // The staff multiplier applies to admin desks, never to spend-capable
    // feature calls.
    expect((await run()).status).toBe(429);
  });

  it('multiplies admin desk limits for staff without making them unlimited', async () => {
    await resetLimits({ AI_RATE_LIMIT_ADMIN_READ_MAX: 2, AI_RATE_LIMIT_ADMIN_MULTIPLIER: 2 });
    const { client } = await createUser('ADMIN');

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await client.req('/api/admin/ai/usage')).status);

    expect(statuses.slice(0, 4).every((s) => s !== 429)).toBe(true);
    expect(statuses[4]).toBe(429);
  });

  it('never stores request content in the counter table', async () => {
    await resetLimits({ AI_RATE_LIMIT_FEATURE_MAX: 5 });
    const { client } = await createUser('CUSTOMER');
    const secretish = `payload-marker-${randomUUID()}`;
    await client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'status', user: secretish, system: secretish },
    });

    const rows = await db.execute(
      sql`SELECT bucket_key FROM rate_limit_counters WHERE bucket_key LIKE ${`%${secretish}%`}`,
    );
    expect(rows.rows.length).toBe(0);

    // And the bucket key only carries a prefix plus an opaque identity.
    const any = await db.execute(sql`SELECT bucket_key FROM rate_limit_counters WHERE bucket_key LIKE 'ai.%' LIMIT 5`);
    for (const row of any.rows as Array<{ bucket_key: string }>) {
      expect(row.bucket_key).toMatch(/^ai\.[a-z.]+\:(user|ip):[^:]+$/);
    }
  });
});

describe('AI-RATE-LIMIT-01 — does not disturb the spend guard or the local engine', () => {
  beforeEach(async () => {
    await resetLimits();
  });

  it('still refuses to enable a paid provider without GLOBAL caps', async () => {
    const { client } = await createUser('ADMIN');
    const guard = await client.req('/api/admin/ai/spend/guard');
    expect(guard.status).toBe(200);
    expect(guard.data.data.ready).toBe(false);

    const enable = await client.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { enabled: true },
    });
    expect(enable.status).toBe(409);
    expect(enable.data.error.code).toBe('SPEND_GUARD_REQUIRED');
  });

  it('lets the local engine serve feature calls under the limiter', async () => {
    await resetLimits({ AI_RATE_LIMIT_FEATURE_MAX: 3 });
    const { client } = await createUser('CUSTOMER');
    const run = await client.req('/api/ai/run', {
      method: 'POST',
      body: { requestType: 'status', user: 'ping', maxTokens: 16 },
    });
    expect(run.status).toBe(200);
    expect(run.data.success).toBe(true);
  });
});
