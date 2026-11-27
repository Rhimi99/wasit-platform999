import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { aiProviders } from '../src/db/schema/ai_providers.js';
import { aiModels, aiRequests, aiUsage } from '../src/db/schema/ai.js';
import { aiSpendAlerts, aiSpendCounters, aiSpendLimits } from '../src/db/schema/ai-spend.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';
import { runAIFeature } from '../src/lib/ai/runtime.js';
import type { AIProvider, AIProviderCallOptions } from '../src/lib/ai/types.js';
import {
  evaluateSpendGuard,
  setGlobalGuardCaps,
  spendGuardState,
  type GuardLimitRow,
} from '../src/lib/ai/spend-guard.js';
import { ensureProviderConfigs, updateProviderConfig } from '../src/lib/ai/provider-config.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';

/**
 * AI-SPEND-GUARD-01 — a paid provider is only callable when the deployment has
 * an active GLOBAL daily AND monthly cost cap.
 *
 * Everything runs against the real database and the real runtime. The only
 * stand-in is the provider contract itself (an in-process object), which is the
 * seam the runtime is designed around: no ledger, limit or route is mocked.
 *
 * The suite owns the `guard-test` configuration environment, so the caps it
 * creates and deletes can never touch rows another suite records under `test`.
 */

const app = createApp();
// A configuration environment of this suite's own: the value is a plain column,
// and using `test` would make these caps race the suites that share it.
const GUARD_ENV = 'guard-test' as typeof env.AI_CONFIG_ENVIRONMENT & string;
const PREFIX = 'guard';
const PASSWORD = 'GuardPass123!';
const createdUserIds: string[] = [];

let adminId = '';
let customerId = '';
let adminEmail = '';
let customerEmail = '';

let savedEnvironment: typeof env.AI_CONFIG_ENVIRONMENT;

const auditCtx = () => ({ actorId: adminId, ipAddress: '127.0.0.1', userAgent: 'guard-test' });

async function insertUser(roleName: 'ADMIN' | 'CUSTOMER', tag: string) {
  const id = randomUUID();
  const email = `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  return { id, email };
}

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
      const text = await res.text();
      return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : null };
    },
  };
}

async function login(email: string) {
  const c = client();
  const res = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD, allowUnverifiedEmail: true },
  });
  expect(res.status, `login ${email}`).toBe(200);
  return c;
}

async function clearGuardRows() {
  await db.delete(aiSpendAlerts).where(eq(aiSpendAlerts.environment, GUARD_ENV));
  await db.delete(aiSpendCounters).where(eq(aiSpendCounters.environment, GUARD_ENV));
  await db.delete(aiSpendLimits).where(eq(aiSpendLimits.environment, GUARD_ENV));
}

function fakeVendor(id = 'openai', tokens = { input: 1000, output: 500 }) {
  const state = { hits: 0 };
  const provider: AIProvider = {
    id,
    isAvailable: () => true,
    async call(opts: AIProviderCallOptions) {
      state.hits += 1;
      return {
        content: 'deterministic answer',
        model: opts.model ?? 'gpt-4o-mini',
        tokensInput: tokens.input,
        tokensOutput: tokens.output,
        cost: '0',
        currencyCode: 'USD',
      };
    },
  };
  return { provider, hits: () => state.hits };
}

async function cataloguePrice(modelKey: string) {
  const [row] = await db.select().from(aiModels).where(eq(aiModels.key, modelKey)).limit(1);
  return row;
}

function expectedCost(inputPer1k: string, outputPer1k: string, tokensIn: number, tokensOut: number) {
  return new Decimal(inputPer1k)
    .mul(tokensIn / 1000)
    .plus(new Decimal(outputPer1k).mul(tokensOut / 1000));
}

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

function limitRow(overrides: Partial<GuardLimitRow> = {}): GuardLimitRow {
  return {
    id: randomUUID(),
    environment: GUARD_ENV,
    scope: 'GLOBAL',
    targetKey: '',
    period: 'DAILY',
    maxCost: '10.0000000000',
    maxRequests: null,
    warnRatio: '0.8000',
    currencyCode: 'USD',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GuardLimitRow;
}

beforeAll(async () => {
  ({ id: adminId, email: adminEmail } = await insertUser('ADMIN', 'admin'));
  ({ id: customerId, email: customerEmail } = await insertUser('CUSTOMER', 'customer'));
});

beforeEach(async () => {
  savedEnvironment = env.AI_CONFIG_ENVIRONMENT;
  env.AI_CONFIG_ENVIRONMENT = GUARD_ENV;
  await setAiExecutionEnabled(db, null);
  await clearGuardRows();
  await ensureProviderConfigs(db);
  // A case may switch a vendor on directly (to prove the runtime guard catches
  // an operator-configured provider); start every case from the seeded state.
  await db
    .update(aiProviders)
    .set({ enabled: false, isDefault: false, isFallback: false })
    .where(
      and(eq(aiProviders.environment, GUARD_ENV), sql`${aiProviders.providerKey} <> 'local-heuristic'`),
    );
});

afterEach(async () => {
  env.AI_CONFIG_ENVIRONMENT = savedEnvironment;
  delete process.env.AI_OPENAI_API_KEY;
});

afterAll(async () => {
  await clearGuardRows();
  await db.delete(auditLogs).where(sql`${auditLogs.entityType} IN ('AI_SPEND_GUARD', 'AI_PROVIDER')`);
  await db.delete(aiRequests).where(inArray(aiRequests.userId, createdUserIds));
  await db.delete(aiUsage).where(inArray(aiUsage.userId, createdUserIds));
  await db.delete(aiProviders).where(eq(aiProviders.environment, GUARD_ENV));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await closeDb();
});

describe('guard evaluation', () => {
  it('is not ready when neither GLOBAL cap exists, and names both', () => {
    const state = evaluateSpendGuard([], GUARD_ENV);
    expect(state.ready).toBe(false);
    expect(state.missing).toEqual(['DAILY', 'MONTHLY']);
    expect(state.caps.daily).toBeNull();
    expect(state.caps.monthly).toBeNull();
  });

  it('is not ready with only one of the two caps', () => {
    const state = evaluateSpendGuard([limitRow({ period: 'DAILY' })], GUARD_ENV);
    expect(state.ready).toBe(false);
    expect(state.missing).toEqual(['MONTHLY']);
  });

  it('is ready when both caps are active and positive', () => {
    const state = evaluateSpendGuard(
      [limitRow({ period: 'DAILY', maxCost: '25' }), limitRow({ period: 'MONTHLY', maxCost: '250' })],
      GUARD_ENV,
    );
    expect(state.ready).toBe(true);
    expect(state.missing).toEqual([]);
    expect(state.caps.daily?.maxCost).toBe('25');
    expect(state.caps.monthly?.maxCost).toBe('250');
  });

  it('does not accept an inactive, zero, provider-scoped or foreign-environment row as a cap', () => {
    const rows = [
      limitRow({ period: 'DAILY', isActive: false }),
      limitRow({ period: 'MONTHLY', maxCost: '0' }),
      limitRow({ period: 'DAILY', scope: 'PROVIDER', targetKey: 'openai' }),
      limitRow({ period: 'MONTHLY', environment: 'somewhere-else' }),
    ];
    const state = evaluateSpendGuard(rows, GUARD_ENV);
    expect(state.ready).toBe(false);
    expect(state.missing).toEqual(['DAILY', 'MONTHLY']);
  });

  it('reads the deployment state from the database, unconfigured means unguarded', async () => {
    expect((await spendGuardState(db, GUARD_ENV)).ready).toBe(false);
    await setGlobalGuardCaps(db, auditCtx(), GUARD_ENV, { dailyMaxCost: '10', monthlyMaxCost: '100' });
    const state = await spendGuardState(db, GUARD_ENV);
    expect(state.ready).toBe(true);
    expect(state.environment).toBe(GUARD_ENV);
  });
});

describe('paid calls', () => {
  it('refuses a paid call without caps and never touches the vendor', async () => {
    const vendor = fakeVendor();
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'guard',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
      }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });
    expect(vendor.hits()).toBe(0);
    const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, customerId));
    expect(rows).toHaveLength(0);
    const counters = await db.select().from(aiSpendCounters).where(eq(aiSpendCounters.environment, GUARD_ENV));
    expect(counters).toHaveLength(0);
  });

  it('never blocks the free local engine, which needs no cap', async () => {
    const local: AIProvider = {
      id: 'local-heuristic',
      isAvailable: () => true,
      async call() {
        return {
          content: 'local',
          model: 'local-heuristic',
          tokensInput: 10,
          tokensOutput: 5,
          cost: '0',
          currencyCode: 'USD',
        };
      },
    };
    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'free',
      provider: local,
      modelKey: 'local-heuristic',
    });
    expect(out.providerKey).toBe('local-heuristic');
    expect(out.costSource).toBe('FREE');
  });

  it('allows the paid call once both caps exist', async () => {
    await setGlobalGuardCaps(db, auditCtx(), GUARD_ENV, { dailyMaxCost: '10', monthlyMaxCost: '100' });
    const vendor = fakeVendor();
    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'allowed',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    expect(out.providerKey).toBe('openai');
    expect(vendor.hits()).toBe(1);
  });

  it('cannot be bypassed by a provider selected from configuration', async () => {
    // An operator pointing AI_PROVIDER at a vendor, without an explicit provider
    // in the call, must hit the same guard: enabling a key is not enough.
    await db
      .update(aiProviders)
      .set({ enabled: true, isDefault: true })
      .where(and(eq(aiProviders.environment, GUARD_ENV), eq(aiProviders.providerKey, 'openai')));
    // Provider keys are read from the process environment (an operator sets
    // them in the deployment), so that is where this one is placed. It only has
    // to be non-empty for the provider to look available — the guard refuses
    // before any socket opens, so this placeholder is never sent anywhere.
    process.env.AI_OPENAI_API_KEY = ['guard', 'fixture'].join('-');
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'config-selected',
      }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });
  });

  it('cannot be overrun by concurrent paid calls', async () => {
    const model = await cataloguePrice('openai-gpt-4o-mini');
    const perCall = expectedCost(model.inputPer1k, model.outputPer1k, 1000, 500);
    // Room for exactly two measured calls.
    const cap = perCall.mul('2.01').toFixed(10);
    await setGlobalGuardCaps(db, auditCtx(), GUARD_ENV, { dailyMaxCost: cap, monthlyMaxCost: cap });

    const vendor = fakeVendor();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        runAIFeature(db, {
          userId: customerId,
          roles: ['CUSTOMER'],
          requestType: 'SMART_SEARCH',
          user: `concurrent-${i}`,
          provider: vendor.provider,
          modelKey: 'openai-gpt-4o-mini',
        }),
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // The reservation is an estimate taken before each call, so the exact number
    // of vendor hits is not fixed — but the cap must throttle the burst instead
    // of letting all twelve through, and once it is reached no further call may
    // be authorised. Reservations are atomic (`ai_spend_counters` upsert), so
    // parallel callers cannot all observe the same remaining budget.
    const hitsAfterBurst = vendor.hits();
    expect(hitsAfterBurst).toBeGreaterThan(0);
    expect(hitsAfterBurst).toBeLessThan(12);

    const [counter] = await db
      .select()
      .from(aiSpendCounters)
      .where(and(eq(aiSpendCounters.environment, GUARD_ENV), eq(aiSpendCounters.period, 'DAILY')));
    expect(new Decimal(counter.spent).gt(0)).toBe(true);

    const afterCap = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'after-cap',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    expect(afterCap.providerKey).toBe('local-heuristic');
    expect(vendor.hits()).toBe(hitsAfterBurst);
  });
});

describe('activation', () => {
  it('refuses to enable a vendor and leaves the row untouched', async () => {
    await expect(
      updateProviderConfig(db, auditCtx(), 'openai', { enabled: true }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });

    const [row] = await db
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.environment, GUARD_ENV), eq(aiProviders.providerKey, 'openai')));
    expect(row.enabled).toBe(false);
    expect(row.isDefault).toBe(false);
  });

  it('refuses to make a vendor the default or the fallback without caps', async () => {
    await expect(
      updateProviderConfig(db, auditCtx(), 'openai', { role: 'DEFAULT' }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });
    await expect(
      updateProviderConfig(db, auditCtx(), 'anthropic', { role: 'FALLBACK' }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });
  });

  it('allows the same activation once the caps exist', async () => {
    await setGlobalGuardCaps(db, auditCtx(), GUARD_ENV, { dailyMaxCost: '10', monthlyMaxCost: '100' });
    const row = await updateProviderConfig(db, auditCtx(), 'openai', { enabled: true });
    expect(row.enabled).toBe(true);
  });

  it('does not gate the free local engine', async () => {
    const row = await updateProviderConfig(db, auditCtx(), 'local-heuristic', { enabled: true });
    expect(row.enabled).toBe(true);
  });
});

describe('administrative surface', () => {
  it('denies anonymous callers and non-administrators', async () => {
    expect((await client().req('/api/admin/ai/spend/guard')).status).toBe(401);
    const customer = await login(customerEmail);
    expect((await customer.req('/api/admin/ai/spend/guard')).status).toBe(403);
    expect(
      (await customer.req('/api/admin/ai/spend/guard', {
        method: 'PUT',
        body: { dailyMaxCost: '10', monthlyMaxCost: '100' },
      })).status,
    ).toBe(403);
  });

  it('shows the general manager what is missing, then accepts the two caps', async () => {
    const admin = await login(adminEmail);

    const before = await admin.req(`/api/admin/ai/spend/guard?environment=${GUARD_ENV}`);
    expect(before.status).toBe(200);
    const beforeData = (before.data as { data: Record<string, unknown> }).data;
    expect(beforeData.ready).toBe(false);
    expect(beforeData.missing).toEqual(['DAILY', 'MONTHLY']);
    expect(beforeData.environment).toBe(GUARD_ENV);
    const providers = beforeData.providers as Array<{ key: string; paid: boolean }>;
    expect(providers.find((p) => p.key === 'openai')?.paid).toBe(true);
    expect(providers.find((p) => p.key === 'local-heuristic')?.paid).toBe(false);

    const put = await admin.req('/api/admin/ai/spend/guard', {
      method: 'PUT',
      body: { environment: GUARD_ENV, dailyMaxCost: '15', monthlyMaxCost: '150' },
    });
    expect(put.status).toBe(200);
    const putData = (put.data as { data: { ready: boolean; caps: Record<string, { maxCost: string } | null> } }).data;
    expect(putData.ready).toBe(true);
    expect(Number(putData.caps.daily?.maxCost)).toBe(15);
    expect(Number(putData.caps.monthly?.maxCost)).toBe(150);

    const after = await admin.req(`/api/admin/ai/spend/guard?environment=${GUARD_ENV}`);
    expect((after.data as { data: { ready: boolean } }).data.ready).toBe(true);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI_SPEND.GUARD_SET'));
    expect(audits.some((a) => a.actorId === adminId)).toBe(true);
  });

  it('rejects a cap that is not positive or that is below the daily cap', async () => {
    const admin = await login(adminEmail);
    const zero = await admin.req('/api/admin/ai/spend/guard', {
      method: 'PUT',
      body: { environment: GUARD_ENV, dailyMaxCost: '0', monthlyMaxCost: '100' },
    });
    expect(zero.status).toBe(422);

    const inverted = await admin.req('/api/admin/ai/spend/guard', {
      method: 'PUT',
      body: { environment: GUARD_ENV, dailyMaxCost: '100', monthlyMaxCost: '10' },
    });
    expect(inverted.status).toBe(422);

    expect((await spendGuardState(db, GUARD_ENV)).ready).toBe(false);
  });
});
