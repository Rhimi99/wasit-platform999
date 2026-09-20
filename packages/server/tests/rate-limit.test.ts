import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { MemoryRateLimitStore } from '../src/lib/rate-limit/memory.js';
import { PostgresRateLimitStore } from '../src/lib/rate-limit/postgres.js';
import {
  resolveRateLimitStore,
  setRateLimitStore,
  rateLimitStoreStatus,
} from '../src/lib/rate-limit/resolve.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();

beforeAll(async () => {
  await resetRateLimitStore();
  // Start each run from a clean counter table.
  await db.execute(sql`DELETE FROM rate_limit_counters`);
});

afterAll(async () => {
  // Restore the environment-selected store so no other suite observes Postgres.
  setRateLimitStore(null);
  await db.execute(sql`DELETE FROM rate_limit_counters`);
  await closeDb();
});

describe('MemoryRateLimitStore', () => {
  it('counts hits within a window and resets once it lapses', async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.increment('k', 60)).toBe(1);
    expect(await store.increment('k', 60)).toBe(2);
    expect(await store.increment('k', 60)).toBe(3);
    // A zero-length window is always lapsed, so the next hit starts over.
    expect(await store.increment('zero', 0)).toBe(1);
    expect(await store.increment('zero', 0)).toBe(1);
  });

  it('keeps separate buckets per key', async () => {
    const store = new MemoryRateLimitStore();
    await store.increment('a', 60);
    expect(await store.increment('b', 60)).toBe(1);
    expect(await store.increment('a', 60)).toBe(2);
  });

  it('purges only expired buckets', async () => {
    const store = new MemoryRateLimitStore();
    await store.increment('live', 3600);
    await store.increment('stale', 0);
    expect(await store.purgeExpired()).toBe(1);
  });

  it('reset clears every bucket', async () => {
    const store = new MemoryRateLimitStore();
    await store.increment('x', 60);
    await store.reset();
    expect(await store.increment('x', 60)).toBe(1);
  });
});

describe('PostgresRateLimitStore (distributed)', () => {
  it('is selected when RATE_LIMIT_STORE=postgres', () => {
    const store = new PostgresRateLimitStore(db);
    setRateLimitStore(store);
    expect(resolveRateLimitStore().id).toBe('postgres');
    setRateLimitStore(null);
  });

  it('counts hits within a window and resets once it lapses', async () => {
    const store = new PostgresRateLimitStore(db);
    const key = `pg-window-${Date.now()}`;
    expect(await store.increment(key, 60)).toBe(1);
    expect(await store.increment(key, 60)).toBe(2);
    expect(await store.increment(key, 60)).toBe(3);
    // Zero-length window: each hit is its own (already expired) bucket.
    const zero = `pg-zero-${Date.now()}`;
    expect(await store.increment(zero, 0)).toBe(1);
    expect(await store.increment(zero, 0)).toBe(1);
  });

  it('persists counters so a second instance sees the same bucket', async () => {
    const a = new PostgresRateLimitStore(db);
    const b = new PostgresRateLimitStore(db);
    const key = `pg-shared-${Date.now()}`;
    expect(await a.increment(key, 60)).toBe(1);
    expect(await b.increment(key, 60)).toBe(2);
    expect(await a.increment(key, 60)).toBe(3);
  });

  it('counts concurrent hits atomically (no lost updates)', async () => {
    const store = new PostgresRateLimitStore(db);
    const key = `pg-concurrent-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.increment(key, 60)),
    );
    const sorted = [...results].sort((x, y) => x - y);
    expect(sorted).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('purges expired buckets and reports the count', async () => {
    const store = new PostgresRateLimitStore(db);
    await store.increment(`pg-stale-${Date.now()}`, 0);
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
  });
});

describe('rate-limit middleware with the Postgres store', () => {
  it('enforces the same limit end-to-end through the app', async () => {
    // The forgot-password route allows 5 requests / 300s per subject; it needs
    // no session, so the subject is the client IP.
    setRateLimitStore(new PostgresRateLimitStore(db));
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.request('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `rl-${i}@wasit.tn` }),
      });
      statuses.push(res.status);
    }
    // Requests 6 and 7 exceed the window of 5.
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(statuses[6]).toBe(429);

    // The counter really lives in Postgres, keyed by IP.
    const rows = await db.execute(
      sql`SELECT count FROM rate_limit_counters WHERE bucket_key = ${`auth-forgot:ip:${ip}`}`,
    );
    expect(rows.rows.length).toBe(1);
    expect(Number((rows.rows[0] as { count: number | string }).count)).toBeGreaterThan(5);

    setRateLimitStore(null);
  });

  it('keys authenticated requests by user, not by shared IP', async () => {
    setRateLimitStore(new PostgresRateLimitStore(db));

    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    function makeClient() {
      let cookie = '';
      return {
        async req(path: string, body?: unknown) {
          const headers: Record<string, string> = { 'x-forwarded-for': ip };
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          if (cookie) headers.Cookie = cookie;
          const res = await app.request(path, {
            method: 'POST',
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          const setCookie = res.headers.get('set-cookie');
          if (setCookie) cookie = setCookie;
          return res;
        },
      };
    }
    async function registerAndLogin(tag: string) {
      const client = makeClient();
      const email = `rl-user-${tag}-${Date.now()}@wasit.tn`;
      const reg = await client.req('/api/auth/register', {
        email,
        password: 'StrongPass123!',
        firstName: 'Rl',
      });
      expect(reg.status).toBe(201);
      const login = await client.req('/api/auth/login', {
        email,
        password: 'StrongPass123!',
        allowUnverifiedEmail: true,
      });
      expect(login.status).toBe(200);
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return { client, userId: row.id };
    }

    const first = await registerAndLogin('a');
    const second = await registerAndLogin('b');

    // Four sends each, from the *same IP*. Together that exceeds the per-IP
    // limit of 5, so both passing proves each user has their own bucket.
    for (let i = 0; i < 4; i++) {
      const res = await first.client.req('/api/auth/phone/send');
      expect(res.status).not.toBe(429);
    }
    for (let i = 0; i < 4; i++) {
      const res = await second.client.req('/api/auth/phone/send');
      expect(res.status).not.toBe(429);
    }

    const rows = await db.execute(
      sql`SELECT bucket_key FROM rate_limit_counters WHERE bucket_key LIKE ${'auth-phone-send:user:%'}`,
    );
    const keys = rows.rows.map((r) => (r as { bucket_key: string }).bucket_key);
    expect(keys).toContain(`auth-phone-send:user:${first.userId}`);
    expect(keys).toContain(`auth-phone-send:user:${second.userId}`);

    setRateLimitStore(null);
  });
});

describe('store status', () => {
  it('reports memory as non-durable in tests', () => {
    setRateLimitStore(null);
    const status = rateLimitStoreStatus();
    expect(status.store).toBe('memory');
    expect(status.durable).toBe(false);
  });
});