import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import argon2 from 'argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { aiProviders } from '../src/db/schema/ai_providers.js';
import { aiSpendLimits } from '../src/db/schema/ai-spend.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';
import { resolveAiRoute } from '../src/lib/ai/routing.js';
import { runAIFeature } from '../src/lib/ai/runtime.js';
import {
  catalogueProvidersFor,
  configEnvironment,
  resolveProviderChain,
} from '../src/lib/ai/provider-config.js';
import {
  HARD_DENY_TABLES,
  AGENT_SCOPE_CONTRACTS,
  assertTableAccess,
  withAgentDataScope,
} from '../src/modules/ai/agent-scope.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import type { UserRole } from '@wasit/shared';

/**
 * AI-04 — secure AI provider management.
 *
 * What is pinned here:
 *  - only platform administrators can read or change provider configuration;
 *  - a stored key is never returned, never logged and never written in plaintext;
 *  - without a master key outside the database the server refuses to store one;
 *  - a live probe is opt-in, carries a fixed one-word payload and no WASIT data;
 *  - demo/staging configuration can never serve another environment;
 *  - agents can never read the provider table;
 *  - the platform keeps working on the local engine when no vendor is configured.
 */

const app = createApp();
const PREFIX = 'afc09';
const createdUserIds: string[] = [];
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'sk-afc09-0123456789abcdefghij';

let adminId = '';
let superAdminId = '';
let customerId = '';
let supportId = '';
let merchantId = '';

const ENV_KEYS = [
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_SECRET_ENCRYPTION_KEY',
  'AI_PROVIDER_ALLOW_LIVE_TEST',
  'AI_PROVIDER_ALLOWED_HOSTS',
  'AI_CONFIG_ENVIRONMENT',
  // AI-RATE-LIMIT-01: this suite exercises provider management in bulk (store,
  // remove, probe, re-configure) for one admin, which is far above the per-user
  // provider ceiling. The documented master override lifts it for the suite.
  'RATE_LIMIT_AI_MAX',
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let savedEnv: Record<string, unknown>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k as keyof typeof env]]));
});

/**
 * AI-SPEND-GUARD-01: enabling or keying a vendor requires an active GLOBAL
 * daily+monthly cap. Provider management is the subject here, so the ceiling is
 * a fixture. Inserted idempotently and left in place — another suite shares the
 * `test` environment and deleting it here would race that suite.
 */
const GUARD_FIXTURE_ENVS = [configEnvironment(), 'production'] as const;

async function ensureGuardFixture() {
  for (const environment of GUARD_FIXTURE_ENVS) {
    for (const [period, maxCost] of [['DAILY', '1000'], ['MONTHLY', '1000']] as const) {
      await db
        .insert(aiSpendLimits)
        .values({
          id: randomUUID(),
          environment,
          scope: 'GLOBAL',
          targetKey: '',
          period,
          maxCost,
          maxRequests: null,
          warnRatio: '0.8000',
          currencyCode: 'USD',
          isActive: true,
        })
        .onConflictDoNothing();
    }
  }
}

beforeEach(ensureGuardFixture);

beforeEach(() => {
  (env as Record<string, unknown>).RATE_LIMIT_AI_MAX = 1000;
});

afterEach(() => {
  for (const k of ENV_KEYS) (env as Record<string, unknown>)[k] = savedEnv[k];
  delete process.env.AI_OPENAI_API_KEY;
  delete process.env.AI_ANTHROPIC_API_KEY;
});

async function insertUser(roleName: UserRole, tag: string) {
  const id = randomUUID();
  const email = `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Afc09Pass123!'),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  return { id, email };
}

beforeAll(async () => {
  ({ id: adminId } = await insertUser('ADMIN', 'admin'));
  ({ id: superAdminId } = await insertUser('SUPER_ADMIN', 'super'));
  ({ id: customerId } = await insertUser('CUSTOMER', 'customer'));
  ({ id: supportId } = await insertUser('SUPPORT', 'support'));
  ({ id: merchantId } = await insertUser('MERCHANT', 'merchant'));
});

afterAll(async () => {
  await db.delete(auditLogs).where(sql`${auditLogs.entityType} = 'AI_PROVIDER'`);
  await db.delete(aiProviders).where(eq(aiProviders.environment, 'production'));
  await db
    .update(aiProviders)
    .set({ enabled: false, isDefault: false, isFallback: false, secretCiphertext: null, secretFingerprint: null, secretUpdatedAt: null, keySource: 'ENV', updatedBy: null })
    .where(and(eq(aiProviders.environment, configEnvironment()), sql`${aiProviders.providerKey} <> 'local-heuristic'`));
  await db
    .update(aiProviders)
    .set({ enabled: true, updatedBy: null })
    .where(and(eq(aiProviders.environment, configEnvironment()), eq(aiProviders.providerKey, 'local-heuristic')));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await closeDb();
});

function client() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { Origin: 'http://localhost:5173' };
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
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { status: res.status, data: data as any, text };
    },
  };
}

async function login(email: string) {
  const c = client();
  const res = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'Afc09Pass123!', allowUnverifiedEmail: true },
  });
  expect(res.status, `login ${email}`).toBe(200);
  return c;
}

async function emailOf(id: string) {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
  return row.email;
}

async function rowFor(providerKey: string, environment = configEnvironment()) {
  const [row] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.environment, environment), eq(aiProviders.providerKey, providerKey)))
    .limit(1);
  return row;
}

async function auditFor(action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'AI_PROVIDER'), eq(auditLogs.action, action)));
}

/** Minimal local stand-in for a vendor endpoint. Counts every hit. */
interface VendorServer {
  baseUrl: string;
  hits: () => number;
  lastBody: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

async function startVendorServer(status = 200): Promise<VendorServer> {
  let hits = 0;
  let last: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      hits += 1;
      try {
        last = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        last = null;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hits: () => hits,
    lastBody: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('AI-04 access control', () => {
  it('refuses every provider route to anonymous callers', async () => {
    const anon = client();
    expect((await anon.req('/api/admin/ai/providers')).status).toBe(401);
    expect((await anon.req('/api/admin/ai/providers/openai')).status).toBe(401);
    expect((await anon.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true } })).status).toBe(401);
    expect((await anon.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } })).status).toBe(401);
    expect((await anon.req('/api/admin/ai/providers/openai/test', { method: 'POST', body: { mode: 'CONFIG' } })).status).toBe(401);
    expect((await anon.req('/api/admin/ai/providers/openai/usage')).status).toBe(401);
  });

  it('refuses non-administrators, including staff roles that are not AI administrators', async () => {
    for (const id of [customerId, supportId, merchantId]) {
      const c = await login(await emailOf(id));
      expect((await c.req('/api/admin/ai/providers')).status).toBe(403);
      expect((await c.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true } })).status).toBe(403);
      expect((await c.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } })).status).toBe(403);
    }
  });

  it('lets an administrator read the masked configuration', async () => {
    const admin = await login(await emailOf(adminId));
    const res = await admin.req('/api/admin/ai/providers');
    expect(res.status).toBe(200);
    const keys = res.data.data.items.map((i: any) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['openai', 'anthropic', 'local-heuristic']));
    expect(res.data.data.environment).toBe(configEnvironment());
    expect(res.data.data.secretStorage).toHaveProperty('available');
    for (const item of res.data.data.items) {
      expect(item).not.toHaveProperty('secret');
      expect(item).not.toHaveProperty('secretCiphertext');
      expect(item).not.toHaveProperty('apiKey');
      expect(typeof item.keyState.present).toBe('boolean');
    }
  });
});

describe('AI-04 configuration writes', () => {
  it('rejects a model that is not in the catalogue, or that belongs to another provider', async () => {
    const admin = await login(await emailOf(adminId));
    const unknown = await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { model: 'does-not-exist' } });
    expect(unknown.status).toBe(422);
    const mismatch = await admin.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { model: 'anthropic-claude-sonnet-4' },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.data.error.fieldErrors[0].code).toBe('MODEL_PROVIDER_MISMATCH');
    const ok = await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { model: 'openai-gpt-4o-mini' } });
    expect(ok.status).toBe(200);
  });

  it('rejects an endpoint that is not allowlisted or not HTTPS', async () => {
    const admin = await login(await emailOf(adminId));
    const foreign = await admin.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { baseUrl: 'https://evil.example.com/v1' },
    });
    expect(foreign.status).toBe(422);
    const insecure = await admin.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { baseUrl: 'http://api.openai.com/v1' },
    });
    expect(insecure.status).toBe(422);
    const allowed = await admin.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { baseUrl: 'https://api.openai.com/v1' },
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects a malformed environment variable name', async () => {
    const admin = await login(await emailOf(adminId));
    const res = await admin.req('/api/admin/ai/providers/openai', {
      method: 'PATCH',
      body: { keyEnvVar: 'not a var name' },
    });
    expect(res.status).toBe(422);
  });

  it('keeps exactly one default and one fallback, and audits every change', async () => {
    const admin = await login(await emailOf(superAdminId));
    expect((await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, role: 'DEFAULT' } })).status).toBe(200);
    expect((await admin.req('/api/admin/ai/providers/anthropic', { method: 'PATCH', body: { enabled: true, role: 'DEFAULT' } })).status).toBe(200);
    expect((await admin.req('/api/admin/ai/providers/local-heuristic', { method: 'PATCH', body: { role: 'FALLBACK' } })).status).toBe(200);

    const list = await admin.req('/api/admin/ai/providers');
    const defaults = list.data.data.items.filter((i: any) => i.isDefault);
    const fallbacks = list.data.data.items.filter((i: any) => i.isFallback);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].key).toBe('anthropic');
    expect(fallbacks).toHaveLength(1);

    const audits = await auditFor('AI_PROVIDER.UPDATED');
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.some((a) => a.actorId === superAdminId)).toBe(true);
  });
});

describe('AI-04 key handling', () => {
  it('refuses to store a key when no master key exists outside the database', async () => {
    env.AI_SECRET_ENCRYPTION_KEY = undefined;
    const admin = await login(await emailOf(adminId));
    const res = await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('SECRET_STORAGE_DISABLED');
    const row = await rowFor('openai');
    expect(row.secretCiphertext).toBeNull();
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('rejects an empty, short or malformed key', async () => {
    env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
    const admin = await login(await emailOf(adminId));
    expect((await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: '' } })).status).toBe(422);
    expect((await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: 'short' } })).status).toBe(422);
    expect((await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: 'sk-has a space in it 123456' } })).status).toBe(422);
    // A key that does not look like the vendor's, against the vendor endpoint.
    await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { baseUrl: 'https://api.openai.com/v1' } });
    const wrongPrefix = await admin.req('/api/admin/ai/providers/openai/secret', {
      method: 'PUT',
      body: { secret: 'nope-0123456789abcdefghij' },
    });
    expect(wrongPrefix.status).toBe(422);
  });

  it('stores a key sealed, never returns it, and audits it without the value', async () => {
    env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
    const admin = await login(await emailOf(adminId));
    const put = await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(SECRET);
    expect(put.data.data.keyState).toMatchObject({ present: true, source: 'DB' });
    expect(put.data.data.keyState.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const row = await rowFor('openai');
    expect(row.secretCiphertext).toMatch(/^v1:/);
    expect(row.secretCiphertext).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(SECRET);

    const list = await admin.req('/api/admin/ai/providers');
    expect(list.text).not.toContain(SECRET);
    const detail = await admin.req('/api/admin/ai/providers/openai');
    expect(detail.text).not.toContain(SECRET);
    expect(detail.data.data.keyState.present).toBe(true);

    const audits = await auditFor('AI_PROVIDER.SECRET_SET');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(SECRET);
    expect((audits[0].metadata as Record<string, unknown>).fingerprint).toBe(row.secretFingerprint);
  });

  it('removes a stored key and falls back to the environment reference', async () => {
    env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
    const admin = await login(await emailOf(adminId));
    await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
    const del = await admin.req('/api/admin/ai/providers/openai/secret', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(del.data.data.keyState.present).toBe(false);
    const row = await rowFor('openai');
    expect(row.secretCiphertext).toBeNull();
    expect(row.secretFingerprint).toBeNull();
    expect(row.keySource).toBe('ENV');
    expect(await auditFor('AI_PROVIDER.SECRET_REMOVED')).toHaveLength(1);
  });

  it('never lets a stored key cross into another environment', async () => {
    env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
    const admin = await login(await emailOf(adminId));
    await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
    expect((await rowFor('openai')).secretCiphertext).toMatch(/^v1:/);

    // Same database, different deployment environment: no key, no default.
    env.AI_CONFIG_ENVIRONMENT = 'production';
    const list = await admin.req('/api/admin/ai/providers');
    const openai = list.data.data.items.find((i: any) => i.key === 'openai');
    expect(openai.keyState.present).toBe(false);
    expect(list.text).not.toContain(SECRET);
    const prodRow = await rowFor('openai', 'production');
    expect(prodRow.secretCiphertext).toBeNull();
    expect(await rowFor('openai', 'test')).toMatchObject({ secretCiphertext: expect.stringMatching(/^v1:/) });
  });
});

describe('AI-04 connection test', () => {
  it('does not open a socket in CONFIG mode', async () => {
    const server = await startVendorServer();
    try {
      const admin = await login(await emailOf(adminId));
      await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, baseUrl: server.baseUrl } });
      env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
      await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
      const res = await admin.req('/api/admin/ai/providers/openai/test', { method: 'POST', body: { mode: 'CONFIG' } });
      expect(res.status).toBe(200);
      expect(res.data.data.mode).toBe('CONFIG');
      expect(res.data.data.status).toBe('CONFIG_ONLY');
      expect(res.data.data.latencyMs).toBeNull();
      expect(server.hits()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('refuses a live probe unless the deployment opts in', async () => {
    const server = await startVendorServer();
    try {
      env.AI_PROVIDER_ALLOW_LIVE_TEST = false;
      const admin = await login(await emailOf(adminId));
      await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, baseUrl: server.baseUrl } });
      const res = await admin.req('/api/admin/ai/providers/openai/test', { method: 'POST', body: { mode: 'LIVE' } });
      expect(res.status).toBe(409);
      expect(server.hits()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('sends only a fixed probe when live testing is allowed, and records the result', async () => {
    const server = await startVendorServer();
    try {
      env.AI_PROVIDER_ALLOW_LIVE_TEST = true;
      env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
      const admin = await login(await emailOf(adminId));
      await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, baseUrl: server.baseUrl } });
      await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
      const res = await admin.req('/api/admin/ai/providers/openai/test', { method: 'POST', body: { mode: 'LIVE' } });
      expect(res.status).toBe(200);
      expect(res.data.data.status).toBe('OK');
      expect(server.hits()).toBe(1);

      const body = server.lastBody() as Record<string, any>;
      expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
      expect(body.max_tokens).toBe(1);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body).toLowerCase()).not.toContain('wasit');
      // No prompt, no platform data: the probe carries the word "ping" only.
      expect(JSON.stringify(body.messages)).toBe('[{"role":"user","content":"ping"}]');

      const row = await rowFor('openai');
      expect(row.lastTestStatus).toBe('OK');
      expect(row.lastTestMode).toBe('LIVE');
      expect(JSON.stringify(row.lastTestDetail)).not.toContain(SECRET);
      expect((await auditFor('AI_PROVIDER.TESTED')).length).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it('records a failed live probe without leaking the vendor body', async () => {
    const server = await startVendorServer(500);
    try {
      env.AI_PROVIDER_ALLOW_LIVE_TEST = true;
      env.AI_SECRET_ENCRYPTION_KEY = MASTER_KEY;
      const admin = await login(await emailOf(adminId));
      await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, baseUrl: server.baseUrl } });
      await admin.req('/api/admin/ai/providers/openai/secret', { method: 'PUT', body: { secret: SECRET } });
      const res = await admin.req('/api/admin/ai/providers/openai/test', { method: 'POST', body: { mode: 'LIVE' } });
      expect(res.status).toBe(200);
      expect(res.data.data.status).toBe('FAILED');
      expect(res.text).not.toContain(SECRET);
      expect((await rowFor('openai')).lastTestStatus).toBe('FAILED');
    } finally {
      await server.close();
    }
  });
});

describe('AI-04 resolution, fallback and agent isolation', () => {
  it('keeps the platform working on the local engine when no vendor key exists', async () => {
    env.AI_PROVIDER = 'none';
    env.AI_API_KEY = undefined;
    env.AI_SECRET_ENCRYPTION_KEY = undefined;
    await db
      .update(aiProviders)
      .set({ enabled: false, isDefault: false, isFallback: false, secretCiphertext: null, updatedBy: 'afc09-test' })
      .where(and(eq(aiProviders.environment, configEnvironment()), sql`${aiProviders.providerKey} <> 'local-heuristic'`));

    const chain = await resolveProviderChain(db);
    expect(chain.map((e) => e.key)).toContain('local-heuristic');
    expect(chain.some((e) => e.key === 'openai')).toBe(false);

    const route = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN']);
    expect(route.providerId).toBe('local-heuristic');

    const out = await runAIFeature(db, {
      userId: adminId,
      roles: ['ADMIN'],
      requestType: 'AFC09_NO_KEY',
      user: 'ping',
    });
    expect(Number(out.cost)).toBe(0);
    expect(out.model).toBe('local-heuristic');
  });

  it('falls back to the configured fallback provider with its own model', async () => {
    process.env.AI_ANTHROPIC_API_KEY = 'sk-ant-afc09-0123456789abcdef';
    env.AI_PROVIDER = 'none';
    env.AI_API_KEY = undefined;
    const admin = await login(await emailOf(adminId));
    // Default: OpenAI (enabled but with no key). Fallback: Anthropic (key present).
    await admin.req('/api/admin/ai/providers/openai', { method: 'PATCH', body: { enabled: true, role: 'DEFAULT' } });
    await admin.req('/api/admin/ai/providers/anthropic', { method: 'PATCH', body: { enabled: true, role: 'FALLBACK' } });

    const route = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN']);
    expect(route.providerId).toBe('anthropic');
    expect(route.modelKey).toBe('anthropic-claude-sonnet-4');
    expect(route.vendorModel).toBe('claude-sonnet-4-20250514');
  });

  it('never selects a provider that is not allowed in production', async () => {
    const originalNodeEnv = env.NODE_ENV;
    try {
      (env as Record<string, unknown>).NODE_ENV = 'production';
      env.AI_CONFIG_ENVIRONMENT = 'production';
      const existingNoop = await rowFor('noop', 'production');
      if (existingNoop) {
        await db
          .update(aiProviders)
          .set({ enabled: true, isDefault: true, model: 'noop' })
          .where(eq(aiProviders.id, existingNoop.id));
      } else {
        await db.insert(aiProviders).values({
          id: randomUUID(),
          environment: 'production',
          providerKey: 'noop',
          displayName: 'Noop harness',
          enabled: true,
          isDefault: true,
          model: 'noop',
        });
      }
      const chain = await resolveProviderChain(db);
      expect(chain.map((e) => e.key)).not.toContain('noop');
      expect(chain.map((e) => e.key)).toContain('local-heuristic');
    } finally {
      (env as Record<string, unknown>).NODE_ENV = originalNodeEnv;
    }
  });

  it('keeps the provider table out of every agent scope', () => {
    expect(HARD_DENY_TABLES.has('ai_providers')).toBe(true);
    for (const contract of Object.values(AGENT_SCOPE_CONTRACTS)) {
      expect(contract.allowedTables).not.toContain('ai_providers');
    }
    // Even a trusted run context cannot read the provider table.
    const trustedCtx = {
      agentKey: 'analytics-agent',
      allowedTables: ['ai_providers'],
    } as unknown as Parameters<typeof assertTableAccess>[0];
    expect(() => assertTableAccess(trustedCtx, 'ai_providers', 'read')).toThrow();
  });

  it('resolves the configured provider inside an agent run, while the agent itself stays denied', async () => {
    process.env.AI_ANTHROPIC_API_KEY = 'sk-ant-afc09-0123456789abcdef';
    env.AI_PROVIDER = 'none';
    env.AI_API_KEY = undefined;
    const admin = await login(await emailOf(adminId));
    await admin.req('/api/admin/ai/providers/anthropic', { method: 'PATCH', body: { enabled: true, role: 'DEFAULT' } });

    const scoped = withAgentDataScope(db);
    const runCtx = {
      taskId: 'afc09-task',
      agentKey: 'analytics-agent',
      requestedBy: adminId,
      requesterRoles: ['ADMIN'],
      authorizedActions: [],
      allowedTools: [],
    } as unknown as Parameters<typeof withAgentRunContext>[0];

    await withAgentRunContext(runCtx, async () => {
      // The agent's own query is refused...
      expect(() => scoped.select().from(aiProviders)).toThrow(/prohibited/i);
      // ...while platform provider resolution still works and never leaks a key.
      const chain = await resolveProviderChain(scoped);
      expect(chain[0].key).toBe('anthropic');
      expect(JSON.stringify(chain.map((e) => ({ key: e.key, model: e.model, role: e.role })))).not.toContain('sk-ant');
    });

    await admin.req('/api/admin/ai/providers/anthropic', { method: 'PATCH', body: { role: 'NONE', enabled: false } });
  });

  it('maps the local engine catalogue name so usage is attributable', () => {
    expect(catalogueProvidersFor('local-heuristic')).toContain('local');
    expect(catalogueProvidersFor('openai')).toEqual(['openai']);
  });

  it('reports which agents and tasks ran on a provider', async () => {
    const admin = await login(await emailOf(adminId));
    const usage = await admin.req('/api/admin/ai/providers/local-heuristic/usage?days=30');
    expect(usage.status).toBe(200);
    expect(usage.data.data.provider).toBe('local-heuristic');
    expect(Array.isArray(usage.data.data.agents)).toBe(true);
    expect(typeof usage.data.data.requests).toBe('number');
  });
});
