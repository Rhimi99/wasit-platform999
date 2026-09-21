import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { countries } from '../src/db/schema/geo.js';
import { categories } from '../src/db/schema/products.js';
import { MemoryReadCache, NoopReadCache } from '../src/lib/cache/memory.js';
import { setReadCache, peekReadCache, cached, invalidateCache, readCacheStatus } from '../src/lib/cache/resolve.js';
import { CACHE_PREFIX } from '../src/lib/cache/keys.js';

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
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createAdmin() {
  const id = randomUUID();
  const email = `it-cache-admin-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('CachePass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: 'ADMIN', isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'CachePass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client: c, id };
}

/** Category rows created by this suite, removed afterwards. */
const createdCategoryIds: string[] = [];

// Enable a real cache for the whole file; individual tests reset its contents.
beforeAll(() => {
  setReadCache(new MemoryReadCache(500));
});

afterAll(async () => {
  setReadCache(null);
  for (const id of createdCategoryIds) {
    await db.delete(categories).where(eq(categories.id, id));
  }
  await closeDb();
});

describe('read cache — unit-level contract via the app helpers', () => {
  it('serves the second read from cache with an identical body', async () => {
    const cache = peekReadCache() as MemoryReadCache;
    await cache.clear();

    const first = await app.request('/api/geo/countries?pageSize=50');
    const second = await app.request('/api/geo/countries?pageSize=50');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await first.json()).toEqual(await second.json());
    const stats = await cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('normalises the q/iso3 params into distinct keys', async () => {
    const cache = peekReadCache() as MemoryReadCache;
    await cache.clear();

    await app.request('/api/geo/countries?q=Tunis');
    await app.request('/api/geo/countries?q=Sfax');
    // Two different filters must not collide on one entry.
    expect((await cache.stats()).misses).toBe(2);
  });

  it('does not cache a miss: a 404 is re-evaluated every time', async () => {
    const cache = peekReadCache() as MemoryReadCache;
    await cache.clear();

    const id = randomUUID();
    const a = await app.request(`/api/geo/countries/${id}`);
    const b = await app.request(`/api/geo/countries/${id}`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // Both attempts were misses — nothing was stored from the error.
    expect((await cache.stats()).hits).toBe(0);
    expect((await cache.stats()).entries).toBe(0);
  });

  it('cached() returns the loaded value and reuses the stored one on the next call', async () => {
    const cache = peekReadCache() as MemoryReadCache;
    await cache.clear();

    let loads = 0;
    const load = async () => {
      loads += 1;
      return { n: loads };
    };
    expect(await cached('test:key', 60, load)).toEqual({ n: 1 });
    expect(await cached('test:key', 60, load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
  });

  it('invalidateCache removes only the named namespace', async () => {
    const cache = peekReadCache() as MemoryReadCache;
    await cache.clear();
    // Use keys that cannot collide with the real routes' keys.
    await cached(`${CACHE_PREFIX.GEO}it-scratch`, 60, async () => ({ a: 1 }));
    await cached('it:other-namespace', 60, async () => ({ b: 2 }));

    expect(await invalidateCache(CACHE_PREFIX.GEO)).toBe(1);
    expect(await cache.get(`${CACHE_PREFIX.GEO}it-scratch`)).toBeNull();
    expect(await cache.get('it:other-namespace')).not.toBeNull();
  });
});

describe('read cache — writes invalidate what they changed', () => {
  it('a new category appears immediately despite a warm cache', async () => {
    const { client } = await createAdmin();

    // Warm the (empty-ish) list first.
    const before = await client.req('/api/categories');
    expect(before.status).toBe(200);
    const beforeCount = before.data.data.length;

    const name = `Cache Test Category ${Date.now()}`;
    const create = await client.req('/api/categories', {
      method: 'POST',
      body: { name, sortOrder: 999 },
    });
    expect(create.status).toBe(201);
    createdCategoryIds.push(create.data.data.id);

    // The write must have busted `categories:`, so the next read sees the row.
    const after = await client.req('/api/categories');
    expect(after.status).toBe(200);
    expect(after.data.data.length).toBe(beforeCount + 1);
    expect(after.data.data.some((c: { name: string }) => c.name === name)).toBe(true);
  });

  it('activating a market is visible immediately despite a warm cache', async () => {
    const { client } = await createAdmin();
    const [fr] = await db.select().from(countries).where(eq(countries.code, 'FR')).limit(1);
    if (!fr) throw new Error('seed missing country FR');

    // Force FR inactive and warm both the list and the by-code lookup.
    await db.update(countries).set({ isActive: false, activatedAt: null }).where(eq(countries.id, fr.id));
    await invalidateCache(CACHE_PREFIX.GEO);
    const hidden = await client.req('/api/geo/countries/by-code/FR');
    expect(hidden.status).toBe(404);

    const activate = await client.req(`/api/admin/countries/${fr.id}/activation`, {
      method: 'PUT',
      body: { isActive: true, reason: 'Cache invalidation test: activate France.' },
    });
    expect(activate.status).toBe(200);

    const nowVisible = await client.req('/api/geo/countries/by-code/FR');
    expect(nowVisible.status).toBe(200);
    expect(nowVisible.data.data.code).toBe('FR');

    // Restore the seed state.
    await db.update(countries).set({ isActive: false, activatedAt: null }).where(eq(countries.id, fr.id));
    await invalidateCache(CACHE_PREFIX.GEO);
  });
});

describe('read cache — disabled and health surfaces', () => {
  it('a disabled cache always reads the source', async () => {
    setReadCache(new NoopReadCache());
    const a = await app.request('/api/geo/languages');
    const b = await app.request('/api/geo/languages');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    // Noop cache reports nothing stored; reads are transparent.
    expect(await readCacheStatus()).toMatchObject({
      enabled: false,
      store: 'none',
    });
    setReadCache(new MemoryReadCache(500));
  });

  it('health/channels reports the cache store and stats', async () => {
    setReadCache(new MemoryReadCache(500));
    const r = await app.request('/api/health/channels');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { cache: Record<string, unknown> };
    expect(body.cache.store).toBe('memory');
    expect(body.cache.enabled).toBe(true);
    expect(body.cache).toHaveProperty('ttlSeconds');
    expect(body.cache.stats).toHaveProperty('hitRate');
  });
});
