import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { aiSpendLimits } from '../src/db/schema/ai-spend.js';
import { env } from '../src/lib/env.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import {
  setRateLimitStore,
  resolveRateLimitStore,
  rateLimitStoreRequired,
} from '../src/lib/rate-limit/resolve.js';
import { checkRateLimitStoreReadiness } from '../src/lib/rate-limit/readiness.js';
import { MemoryRateLimitStore } from '../src/lib/rate-limit/memory.js';
import { PostgresRateLimitStore } from '../src/lib/rate-limit/postgres.js';
import {
  deploymentTier,
  durableStoreRequired,
  rateLimitConfigViolations,
  type RateLimitConfig,
} from '../src/lib/rate-limit/policy.js';
import { AI_LIMIT_CLASSES, requireDurableAiStore } from '../src/lib/rate-limit/ai-policy.js';
import type { RateLimitStore } from '../src/lib/rate-limit/port.js';

/**
 * AI-RATE-LIMIT-HARDENING-01 — closes the three `DECISION REQUIRED` items of
 * AD-063: no in-process counters in production or staging, a store that must
 * answer before the process serves, and limits left at their measured-pending
 * defaults.
 *
 * The boot tests run the real entry point in a child process. Nothing is mocked:
 * the assertions are exit codes and the actual stderr of `process.exit(1)`.
 */

const app = createApp();
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX_BIN = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

const TEST_ENV = 'hardening-test';
const ENV_KEYS = [
  'NODE_ENV',
  'RATE_LIMIT_STORE',
  'AI_RATE_LIMIT_ALLOW_MEMORY_STORE',
  'AI_RATE_LIMIT_REQUIRE_DURABLE',
  'AI_CONFIG_ENVIRONMENT',
  'AI_RATE_LIMIT_READ_MAX',
  'AI_RATE_LIMIT_FEATURE_MAX',
  'AI_RATE_LIMIT_AGENT_MAX',
  'AI_RATE_LIMIT_ADMIN_READ_MAX',
  'AI_RATE_LIMIT_ADMIN_CONTROL_MAX',
  'AI_RATE_LIMIT_PROVIDER_MAX',
  'AI_RATE_LIMIT_MEMORY_MAX',
  'AI_RATE_LIMIT_ADMIN_MULTIPLIER',
  'RATE_LIMIT_AI_MAX',
  'RATE_LIMIT_AI_IP_MAX',
] as const;
const ORIGINAL: Record<string, unknown> = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));

beforeEach(async () => {
  Object.assign(env, ORIGINAL);
  (env as Record<string, unknown>).AI_CONFIG_ENVIRONMENT = TEST_ENV;
  await resetRateLimitStore();
  await db
    .delete(aiSpendLimits)
    .where(and(eq(aiSpendLimits.environment, TEST_ENV), eq(aiSpendLimits.scope, 'GLOBAL')));
});

afterEach(() => {
  Object.assign(env, ORIGINAL);
});

afterAll(async () => {
  await resetRateLimitStore();
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1. The rule itself (pure, exhaustive)
// ---------------------------------------------------------------------------

const base: RateLimitConfig = {
  nodeEnv: 'production',
  store: 'postgres',
  allowMemoryStore: false,
  requireDurable: undefined,
};

describe('hardening — the rule', () => {
  it('classifies only production and staging as deployed', () => {
    expect(deploymentTier('production')).toBe('production');
    expect(deploymentTier('staging')).toBe('staging');
    expect(deploymentTier('development')).toBe('local');
    expect(deploymentTier('test')).toBe('local');
  });

  it('accepts the shared store in a deployed tier', () => {
    expect(rateLimitConfigViolations(base)).toEqual([]);
    expect(rateLimitConfigViolations({ ...base, nodeEnv: 'staging' })).toEqual([]);
  });

  it('refuses the in-process store in production and staging', () => {
    for (const nodeEnv of ['production', 'staging']) {
      const violations = rateLimitConfigViolations({ ...base, nodeEnv, store: 'memory' });
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain(`RATE_LIMIT_STORE must be postgres in ${nodeEnv}`);
    }
  });

  it('refuses the memory escape hatch in a deployed tier, even with the shared store configured', () => {
    const violations = rateLimitConfigViolations({ ...base, allowMemoryStore: true });
    expect(violations).toEqual(['AI_RATE_LIMIT_ALLOW_MEMORY_STORE cannot be enabled in production']);
  });

  it('refuses to let a deployment disable the durable requirement', () => {
    const violations = rateLimitConfigViolations({ ...base, requireDurable: false });
    expect(violations).toEqual(['AI_RATE_LIMIT_REQUIRE_DURABLE cannot be disabled in production']);
  });

  it('keeps the local tiers permissive', () => {
    const local: RateLimitConfig = {
      nodeEnv: 'test',
      store: 'memory',
      allowMemoryStore: true,
      requireDurable: false,
    };
    expect(rateLimitConfigViolations(local)).toEqual([]);
    expect(durableStoreRequired(local)).toBe(false);
    expect(durableStoreRequired({ ...local, allowMemoryStore: false, requireDurable: true })).toBe(true);
  });

  it('requires shared counters in a deployed tier whatever the flags say', () => {
    for (const nodeEnv of ['production', 'staging']) {
      for (const allowMemoryStore of [true, false]) {
        for (const requireDurable of [true, false, undefined]) {
          expect(durableStoreRequired({ ...base, nodeEnv, allowMemoryStore, requireDurable })).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Boot: the real process refuses to start
// ---------------------------------------------------------------------------

function boot(overrides: Record<string, string>) {
  const result = spawnSync(TSX_BIN, ['tests/fixtures/boot-env-probe.ts'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      DOTENV_CONFIG_PATH: '/nonexistent',
      JWT_SECRET: 'hardening-boot-secret-0123456789abcdefghij',
      ...overrides,
    },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('hardening — boot refusal', () => {
  it('production refuses to start on the in-process store, even with the escape hatch set', () => {
    const { status, output } = boot({
      NODE_ENV: 'production',
      RATE_LIMIT_STORE: 'memory',
      AI_RATE_LIMIT_ALLOW_MEMORY_STORE: 'true',
    });
    expect(status).toBe(1);
    expect(output).toContain('Refusing to start: RATE_LIMIT_STORE must be postgres in production');
    expect(output).not.toContain('BOOTED');
  });

  it('staging refuses to start on the in-process store', () => {
    const { status, output } = boot({ NODE_ENV: 'staging', RATE_LIMIT_STORE: 'memory' });
    expect(status).toBe(1);
    expect(output).toContain('Refusing to start: RATE_LIMIT_STORE must be postgres in staging');
  });

  it('production refuses the escape hatch even when the shared store is configured', () => {
    const { status, output } = boot({
      NODE_ENV: 'production',
      RATE_LIMIT_STORE: 'postgres',
      AI_RATE_LIMIT_ALLOW_MEMORY_STORE: 'true',
    });
    expect(status).toBe(1);
    expect(output).toContain('AI_RATE_LIMIT_ALLOW_MEMORY_STORE cannot be enabled in production');
  });

  it('production refuses to disable the durable requirement', () => {
    const { status, output } = boot({
      NODE_ENV: 'production',
      RATE_LIMIT_STORE: 'postgres',
      AI_RATE_LIMIT_REQUIRE_DURABLE: 'false',
    });
    expect(status).toBe(1);
    expect(output).toContain('AI_RATE_LIMIT_REQUIRE_DURABLE cannot be disabled in production');
  });

  it('starts when a deployed tier is configured correctly', () => {
    const { status, output } = boot({ NODE_ENV: 'production', RATE_LIMIT_STORE: 'postgres' });
    expect(output).toContain('BOOTED');
    expect(status).toBe(0);
  });

  it('leaves the isolated local environment alone', () => {
    const { status, output } = boot({
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      AI_RATE_LIMIT_ALLOW_MEMORY_STORE: 'true',
    });
    expect(output).toContain('BOOTED');
    expect(status).toBe(0);
  });

  it('refuses to serve when the shared store cannot answer at boot', () => {
    const result = spawnSync(TSX_BIN, ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        DOTENV_CONFIG_PATH: '/nonexistent',
        JWT_SECRET: 'hardening-boot-secret-0123456789abcdefghij',
        NODE_ENV: 'production',
        RATE_LIMIT_STORE: 'postgres',
        // Nothing listens there: the readiness probe must fail and stop the boot.
        DATABASE_URL: 'postgresql://wasit:unused@127.0.0.1:5999/wasit_test?connect_timeout=2',
        PORT: '0',
        SCHEDULER_ENABLED: 'false',
      },
      encoding: 'utf8',
      timeout: 90_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(1);
    expect(output).toContain('refusing to start: rate-limit store is not usable');
    expect(output).not.toContain('wasit api listening');
    expect(output).not.toContain('unused'); // no connection string in logs
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime: the second gate, independent of the boot check
// ---------------------------------------------------------------------------

describe('hardening — runtime gate', () => {
  function asDeployed(nodeEnv: 'production' | 'staging', overrides: Record<string, unknown>) {
    Object.assign(env, { NODE_ENV: nodeEnv, ...overrides });
  }

  it('never builds an in-process store in a deployed tier', () => {
    asDeployed('production', { RATE_LIMIT_STORE: 'memory' });
    expect(() => setRateLimitStore(null)).not.toThrow();
    // Re-resolve from the (mutated) environment, as a fresh process would.
    expect(() => resolveRateLimitStore(db)).toThrow(/in-process rate-limit store/);
  });

  it('refuses a memory store handed in directly', () => {
    asDeployed('staging', { RATE_LIMIT_STORE: 'postgres' });
    expect(() => setRateLimitStore(new MemoryRateLimitStore())).toThrow(/in-process rate-limit store/);
  });

  it('keeps the paid AI classes on a shared store whatever the flags say', () => {
    for (const nodeEnv of ['production', 'staging'] as const) {
      asDeployed(nodeEnv, {
        RATE_LIMIT_STORE: 'memory',
        AI_RATE_LIMIT_ALLOW_MEMORY_STORE: true,
        AI_RATE_LIMIT_REQUIRE_DURABLE: false,
      });
      expect(rateLimitStoreRequired()).toBe(true);
      expect(requireDurableAiStore()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Readiness surface
// ---------------------------------------------------------------------------

describe('hardening — readiness', () => {
  it('reports a healthy shared store as ready', async () => {
    setRateLimitStore(new PostgresRateLimitStore(db));
    const readiness = await checkRateLimitStoreReadiness(db);
    expect(readiness).toMatchObject({ store: 'postgres', durable: true, ready: true });
    expect(readiness.required).toBe(false); // this suite runs in the local tier
  });

  it('reports an unreachable store without leaking the driver message', async () => {
    const failing: RateLimitStore = {
      id: 'postgres',
      async increment() {
        return 1;
      },
      async reset() {},
      async purgeExpired() {
        return 0;
      },
      async probe() {
        throw new Error('password authentication failed for user "wasit" at 10.0.0.7');
      },
    };
    setRateLimitStore(failing);
    const readiness = await checkRateLimitStoreReadiness(db);
    expect(readiness.ready).toBe(false);
    expect(readiness.detail).toBe('counter store unreachable');
    expect(JSON.stringify(readiness)).not.toContain('10.0.0.7');
    expect(JSON.stringify(readiness)).not.toContain('password');
  });

  it('reports a deployed tier without a shared store as not ready', async () => {
    (env as Record<string, unknown>).NODE_ENV = 'production';
    (env as Record<string, unknown>).RATE_LIMIT_STORE = 'memory';
    setRateLimitStore(null);
    const readiness = await checkRateLimitStoreReadiness(db);
    expect(readiness).toMatchObject({ ready: false, required: true, durable: false });
    expect(readiness.detail).toBe('a shared counter store is required in this environment');
  });

  it('exposes the store state on the health endpoints', async () => {
    setRateLimitStore(new PostgresRateLimitStore(db));
    const ready = await app.request('/api/health/ready');
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { rateLimit: { store: string; ready: boolean } };
    expect(readyBody.rateLimit).toMatchObject({ store: 'postgres', ready: true });

    const channels = await app.request('/api/health/channels');
    expect(channels.status).toBe(200);
    const channelsBody = (await channels.json()) as {
      rateLimit: { store: string; durable: boolean; required: boolean; ready: boolean };
    };
    expect(channelsBody.rateLimit).toMatchObject({
      store: 'postgres',
      durable: true,
      required: false,
      ready: true,
    });
  });

  it('keeps the isolated local environment ready on the in-process store', async () => {
    setRateLimitStore(new MemoryRateLimitStore());
    const readiness = await checkRateLimitStoreReadiness(db);
    expect(readiness).toMatchObject({ store: 'memory', durable: false, required: false, ready: true });
    const ready = await app.request('/api/health/ready');
    expect(ready.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. The shared store under concurrency
// ---------------------------------------------------------------------------

describe('hardening — shared store', () => {
  it('shares one counter between two replicas', async () => {
    const replicaA = new PostgresRateLimitStore(db);
    const replicaB = new PostgresRateLimitStore(db);
    const key = `hardening:shared:${randomUUID()}`;

    expect(await replicaA.increment(key, 60)).toBe(1);
    expect(await replicaB.increment(key, 60)).toBe(2);
    expect(await replicaA.increment(key, 60)).toBe(3);
  });

  it('loses no increment when two replicas race', async () => {
    const replicaA = new PostgresRateLimitStore(db);
    const replicaB = new PostgresRateLimitStore(db);
    const key = `hardening:race:${randomUUID()}`;

    const counts = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? replicaA : replicaB).increment(key, 60)),
    );

    expect(Math.max(...counts)).toBe(50);
    expect(new Set(counts).size).toBe(50); // every increment produced a distinct count
  });

  it('enforces the AI ceiling end to end on the shared store', async () => {
    setRateLimitStore(new PostgresRateLimitStore(db));
    (env as Record<string, unknown>).AI_RATE_LIMIT_READ_MAX = 5;
    const { client } = await createUser('CUSTOMER');

    const results = await Promise.all(Array.from({ length: 25 }, () => client.req('/api/ai/status')));
    expect(results.filter((r) => r.status === 200).length).toBe(5);
    expect(results.filter((r) => r.status === 429).length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 6. No bypass of the two protections
// ---------------------------------------------------------------------------

describe('hardening — no bypass', () => {
  it('keeps AI-SPEND-GUARD-01 in force on the shared store', async () => {
    setRateLimitStore(new PostgresRateLimitStore(db));
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

  it('does not let the memory escape hatch widen an AI ceiling', async () => {
    (env as Record<string, unknown>).AI_RATE_LIMIT_ALLOW_MEMORY_STORE = true;
    (env as Record<string, unknown>).AI_RATE_LIMIT_FEATURE_MAX = 1;
    const { client } = await createUser('CUSTOMER');
    const run = () =>
      client.req('/api/ai/run', { method: 'POST', body: { requestType: 'status', user: 'hi' } });

    expect((await run()).status).toBe(200);
    const second = await run();
    expect(second.status).toBe(429);
    expect(second.data.error.code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// 7. Defaults untouched (AD-063 decision C)
// ---------------------------------------------------------------------------

describe('hardening — defaults are not lowered without measurements', () => {
  it('keeps the ceilings AI-RATE-LIMIT-01 shipped', () => {
    const max = (id: keyof typeof AI_LIMIT_CLASSES) => AI_LIMIT_CLASSES[id].max();
    expect(max('ai.read')).toBe(120);
    expect(max('ai.feature')).toBe(30);
    expect(max('ai.agent')).toBe(15);
    expect(max('ai.memory')).toBe(60);
    expect(max('ai.admin.read')).toBe(120);
    expect(max('ai.admin.control')).toBe(30);
    expect(max('ai.provider')).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

async function createUser(roleName: string) {
  const email = `it-hardening-${roleName.toLowerCase()}-${randomUUID()}@wasit.tn`;
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      email,
      passwordHash: await argon2.hash('StrongPass123!'),
      firstName: 'Hd',
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
