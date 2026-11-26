import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { aiModels, aiRequests, aiUsage } from '../src/db/schema/ai.js';
import { aiSpendAlerts, aiSpendCounters, aiSpendLimits } from '../src/db/schema/ai-spend.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';
import { runAIFeature } from '../src/lib/ai/runtime.js';
import type { AIProvider } from '../src/lib/ai/types.js';
import { findRequestByKey } from '../src/lib/ai/cost-control.js';
import {
  listSpendLimits,
  reserveSpend,
  spendOverview,
  spendStatus,
  upsertSpendLimit,
} from '../src/lib/ai/spend-limits.js';
import { withAgentRunContext } from '../src/lib/ai/agent-run-context.js';
import { assertTableAccess, withAgentDataScope } from '../src/modules/ai/agent-scope.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';

/**
 * AI-05 — provider consumption accounting and spend control.
 *
 * Every case runs against the real database and the real runtime. The only
 * stand-in is the provider contract itself (an in-process object), which is the
 * seam the runtime is designed around; no ledger, budget, limit or route is
 * mocked.
 *
 * Limit tests run under the `staging` configuration environment so the caps they
 * create can never touch rows another suite records under `test`.
 */

const app = createApp();
const PREFIX = 'afc10';
const LIMIT_ENV = 'staging';
const createdUserIds: string[] = [];
const createdModelKeys: string[] = [];

let adminId = '';
let customerId = '';
let merchantId = '';

let savedEnvironment: typeof env.AI_CONFIG_ENVIRONMENT;

/**
 * AI-SPEND-GUARD-01: a vendor call needs an active GLOBAL daily+monthly cap.
 * These cases are about the caps *below* that guard, so a generous pair is a
 * fixture, not the subject. It is created idempotently and left in place: two
 * suites share the `test` environment and deleting it here would race them.
 * A case that needs an unguarded environment uses one of its own.
 */
const GUARD_FIXTURE_ENVS = ['test', LIMIT_ENV] as const;

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

beforeEach(async () => {
  savedEnvironment = env.AI_CONFIG_ENVIRONMENT;
  env.AI_CONFIG_ENVIRONMENT = 'test';
  await setAiExecutionEnabled(db, null);
  // Limits and counters are per environment; starting each case from an empty
  // `staging` set keeps one case's cap from leaking into the next.
  await db.delete(aiSpendAlerts).where(eq(aiSpendAlerts.environment, LIMIT_ENV));
  await db.delete(aiSpendCounters).where(eq(aiSpendCounters.environment, LIMIT_ENV));
  await db.delete(aiSpendLimits).where(eq(aiSpendLimits.environment, LIMIT_ENV));
  await ensureGuardFixture();
});

afterEach(async () => {
  env.AI_CONFIG_ENVIRONMENT = savedEnvironment;
  await setAiExecutionEnabled(db, null);
});

async function insertUser(roleName: UserRole, tag: string) {
  const id = randomUUID();
  const email = `${PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  createdUserIds.push(id);
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Afc10Pass123!'),
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
  ({ id: customerId } = await insertUser('CUSTOMER', 'customer'));
  ({ id: merchantId } = await insertUser('MERCHANT', 'merchant'));
});

afterAll(async () => {
  const keys = createdModelKeys;
  await db.delete(aiSpendAlerts).where(eq(aiSpendAlerts.environment, LIMIT_ENV));
  await db.delete(aiSpendCounters).where(eq(aiSpendCounters.environment, LIMIT_ENV));
  await db.delete(aiSpendLimits).where(eq(aiSpendLimits.environment, LIMIT_ENV));
  await db.delete(auditLogs).where(sql`${auditLogs.entityType} = 'ai_spend_limit'`);
  await db.delete(aiRequests).where(inArray(aiRequests.userId, createdUserIds));
  await db.delete(aiUsage).where(inArray(aiUsage.userId, createdUserIds));
  if (keys.length > 0) await db.delete(aiModels).where(inArray(aiModels.key, keys));
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
      const text = await res.text();
      let data: unknown = null;
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
    body: { email, password: 'Afc10Pass123!', allowUnverifiedEmail: true },
  });
  expect(res.status, `login ${email}`).toBe(200);
  return c;
}

async function emailOf(id: string) {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
  return row.email;
}

/** A provider contract implementation with deterministic, measured tokens. */
function fakeProvider(
  id: string,
  options: { tokensInput?: number; tokensOutput?: number; fail?: boolean } = {},
) {
  const state = { hits: 0 };
  const provider: AIProvider = {
    id,
    isAvailable: () => true,
    async call(opts) {
      state.hits += 1;
      if (options.fail) throw ApiError.internal('vendor exploded');
      return {
        content: 'deterministic answer',
        model: opts.model ?? 'gpt-4o-mini',
        tokensInput: options.tokensInput ?? 1000,
        tokensOutput: options.tokensOutput ?? 500,
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
    .plus(new Decimal(outputPer1k).mul(tokensOut / 1000))
    .toFixed(10);
}

async function ledgerRowsFor(userId: string) {
  return db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
}

async function usageRowsFor(userId: string) {
  return db.select().from(aiUsage).where(eq(aiUsage.userId, userId));
}

async function limitFor(scope: 'GLOBAL' | 'PROVIDER' | 'AGENT', targetKey: string, period: 'DAILY' | 'MONTHLY') {
  const rows = await listSpendLimits(db, LIMIT_ENV);
  return rows.find((r) => r.scope === scope && r.targetKey === targetKey && r.period === period);
}

async function removeLimit(scope: 'GLOBAL' | 'PROVIDER' | 'AGENT', targetKey: string, period: 'DAILY' | 'MONTHLY') {
  await db
    .delete(aiSpendLimits)
    .where(
      and(
        eq(aiSpendLimits.environment, LIMIT_ENV),
        eq(aiSpendLimits.scope, scope),
        eq(aiSpendLimits.targetKey, targetKey),
        eq(aiSpendLimits.period, period),
      ),
    );
}

async function createLimit(
  scope: 'GLOBAL' | 'PROVIDER' | 'AGENT',
  targetKey: string,
  period: 'DAILY' | 'MONTHLY',
  maxCost: string | null,
  extra: { maxRequests?: number; warnRatio?: string } = {},
) {
  env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
  return upsertSpendLimit(
    db,
    {
      environment: LIMIT_ENV,
      scope,
      targetKey,
      period,
      maxCost,
      maxRequests: extra.maxRequests ?? null,
      warnRatio: extra.warnRatio ?? '0.8',
    },
    { actorId: adminId, actorType: 'USER' },
  );
}

describe('AI-05 usage accounting', () => {
  it('records the provider, vendor model, environment, agent, tokens and an exact estimated cost', async () => {
    env.AI_CONFIG_ENVIRONMENT = 'test';
    const model = await cataloguePrice('openai-gpt-4o-mini');
    const vendor = fakeProvider('openai', { tokensInput: 1200, tokensOutput: 800 });

    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'find a supplier',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });

    const expected = expectedCost(model.inputPer1k, model.outputPer1k, 1200, 800);
    expect(out.cost).toBe(expected);
    expect(out.costSource).toBe('ESTIMATED');
    expect(out.providerKey).toBe('openai');

    const [row] = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, out.requestId))
      .limit(1);
    expect(row.providerKey).toBe('openai');
    expect(row.vendorModel).toBe('gpt-4o-mini');
    expect(row.environment).toBe('test');
    expect(row.costSource).toBe('ESTIMATED');
    expect(row.tokensInput).toBe(1200);
    expect(row.tokensOutput).toBe(800);
    expect(row.cost).toBe(expected);
    expect(row.status).toBe('SUCCESS');
    expect(row.agentKey).toBeNull();

    const usage = await usageRowsFor(customerId);
    expect(usage.length).toBe(1);
    expect(usage[0].tokensInput).toBe(1200);
    expect(usage[0].cost).toBe(expected);
  });

  it('attributes the call to the running agent and its task without trusting caller input', async () => {
    const vendor = fakeProvider('openai');
    const runCtx = {
      taskId: 'afc10-task',
      ledgerTaskId: 'afc10-task',
      agentKey: 'analytics-agent',
      requestedBy: adminId,
      requesterRoles: ['ADMIN'],
      authorizedActions: [],
      allowedTools: [],
    } as unknown as Parameters<typeof withAgentRunContext>[0];

    const out = await withAgentRunContext(runCtx, () =>
      runAIFeature(db, {
        userId: adminId,
        roles: ['ADMIN'],
        requestType: 'AGENT_TASK',
        user: 'summarise',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
        metadata: { agentKey: 'forged-agent', taskId: 'forged-task' },
      }),
    );

    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, out.requestId)).limit(1);
    expect(row.agentKey).toBe('analytics-agent');
    // The trusted run context wins over anything the caller put in `metadata`.
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.agentKey).toBe('analytics-agent');
    expect(meta.taskId).toBe('afc10-task');
  });

  it('separates the free local engine from paid calls', async () => {
    // Start from an empty counter set so the assertion below is about this call.
    await db.delete(aiSpendCounters).where(eq(aiSpendCounters.environment, 'test'));
    const local: AIProvider = {
      id: 'local-heuristic',
      isAvailable: () => true,
      async call() {
        return { content: 'local', model: 'local-heuristic', tokensInput: 10, tokensOutput: 5, cost: '0', currencyCode: 'USD' };
      },
    };
    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'anything',
      provider: local,
      modelKey: 'openai-gpt-4o-mini',
    });
    expect(out.costSource).toBe('FREE');
    expect(out.cost).toBe('0.0000000000');
    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, out.requestId)).limit(1);
    expect(row.providerKey).toBe('local-heuristic');
    expect(row.costSource).toBe('FREE');
    expect(row.cost).toBe('0.0000000000');
    // No external spend counter was touched by a free call.
    const counters = await db
      .select()
      .from(aiSpendCounters)
      .where(eq(aiSpendCounters.environment, 'test'));
    expect(counters).toHaveLength(0);
  });

  it('records a failed call as unknown cost with no tokens and leaves no spend behind', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    await createLimit('PROVIDER', 'openai', 'MONTHLY', '100');
    const vendor = fakeProvider('openai', { fail: true });
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'boom',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
      }),
    ).rejects.toThrow(/vendor exploded/);

    const [row] = await db
      .select()
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, customerId), eq(aiRequests.status, 'FAILED')))
      .limit(1);
    expect(row.costSource).toBe('UNKNOWN');
    expect(row.cost).toBe('0.0000000000');
    expect(row.tokensInput).toBe(0);
    expect(row.providerKey).toBe('openai');
    expect(row.environment).toBe(LIMIT_ENV);

    const counters = await db
      .select()
      .from(aiSpendCounters)
      .where(and(eq(aiSpendCounters.environment, LIMIT_ENV), eq(aiSpendCounters.targetKey, 'openai')));
    expect(counters.every((c) => new Decimal(c.spent).isZero())).toBe(true);
    expect(counters.every((c) => c.requests === 0)).toBe(true);
  });

  it('never stores the prompt, a key or customer data in the usage ledger', async () => {
    const vendor = fakeProvider('openai');
    const secret = 'sk-afc10-fake-not-a-real-key-000000';
    const prompt = `contact me at customer.afc10@example.com — key ${secret}`;
    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: prompt,
      system: `You are an assistant. ${prompt}`,
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
      metadata: { note: 'no prompt here' },
    });
    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, out.requestId)).limit(1);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('customer.afc10@example.com');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('find a supplier');
  });

  it('counts one logical call once, even when the caller retries with the same key', async () => {
    const vendor = fakeProvider('openai');
    const requestKey = `afc10-dedupe-${randomUUID()}`;
    const first = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'once',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
      requestKey,
    });
    const before = (await usageRowsFor(customerId))[0];

    const second = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'once',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
      requestKey,
    });

    expect(second.duplicate).toBe(true);
    expect(second.requestId).toBe(first.requestId);
    expect(vendor.hits()).toBe(1);
    const rows = (await ledgerRowsFor(customerId)).filter((r) => r.requestKey === requestKey);
    expect(rows).toHaveLength(1);
    const after = (await usageRowsFor(customerId))[0];
    expect(after.requestCount).toBe(before.requestCount);
    expect(after.cost).toBe(before.cost);
    expect(await findRequestByKey(db, requestKey)).not.toBeNull();
  });
});

describe('AI-05 price integrity', () => {
  it('refuses a paid call whose model has no catalogue price instead of recording zero', async () => {
    const vendor = fakeProvider('openai');
    const before = await ledgerRowsFor(customerId);
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'unpriced',
        provider: vendor.provider,
        modelKey: 'afc10-unpriced-model',
      }),
    ).rejects.toThrow(/pricing is not configured/i);
    expect(vendor.hits()).toBe(0);
    expect((await ledgerRowsFor(customerId)).length).toBe(before.length);
  });

  it('labels a vendor-reported amount as VENDOR, not as an estimate', async () => {
    const vendor: AIProvider = {
      id: 'openai',
      isAvailable: () => true,
      async call(opts) {
        return {
          content: 'billed',
          model: opts.model ?? 'gpt-4o-mini',
          tokensInput: 10,
          tokensOutput: 5,
          cost: '0.0042',
          currencyCode: 'USD',
          costSource: 'VENDOR',
        };
      },
    };
    const out = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'billed',
      provider: vendor,
      modelKey: 'openai-gpt-4o-mini',
    });
    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, out.requestId)).limit(1);
    expect(row.costSource).toBe('VENDOR');
    expect(out.costSource).toBe('VENDOR');
  });
});

describe('AI-05 spend limits', () => {
  it('refuses a paid call in an environment with no spend guard, and calls no vendor', async () => {
    // AI-SPEND-GUARD-01: an environment without an active GLOBAL daily+monthly
    // cap must not spend. The refusal happens before the provider is touched.
    const environment = 'afc10-no-guard' as typeof env.AI_CONFIG_ENVIRONMENT & string;
    env.AI_CONFIG_ENVIRONMENT = environment;
    await db.delete(aiSpendLimits).where(eq(aiSpendLimits.environment, environment));

    const vendor = fakeProvider('openai');
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'no cap',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
      }),
    ).rejects.toMatchObject({ code: 'SPEND_GUARD_REQUIRED' });
    expect(vendor.hits()).toBe(0);
  });

  it('stops the second call once a provider daily cap is reached, and serves it locally', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    const vendor = fakeProvider('openai', { tokensInput: 1000, tokensOutput: 500 });
    const model = await cataloguePrice('openai-gpt-4o-mini');
    const perCall = new Decimal(expectedCost(model.inputPer1k, model.outputPer1k, 1000, 500));
    // Room for exactly one measured call: the cap is just above one call's cost.
    const cap = perCall.mul('1.01').toFixed(10);
    await createLimit('PROVIDER', 'openai', 'DAILY', cap);

    const first = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'first',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    expect(first.providerKey).toBe('openai');

    const second = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'second',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    // The vendor cap does not take the free engine offline.
    expect(second.providerKey).toBe('local-heuristic');
    expect(second.costSource).toBe('FREE');
    expect(second.cost).toBe('0.0000000000');
    expect(vendor.hits()).toBe(1);

    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, second.requestId)).limit(1);
    expect((row.metadata as Record<string, any>).spendLimitBlocked.scope).toBe('PROVIDER');
    expect(row.providerKey).toBe('local-heuristic');

    const [counter] = await db
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, LIMIT_ENV),
          eq(aiSpendCounters.scope, 'PROVIDER'),
          eq(aiSpendCounters.targetKey, 'openai'),
          eq(aiSpendCounters.period, 'DAILY'),
        ),
      );
    expect(new Decimal(counter.spent).lte(cap)).toBe(true);
  });

  it('can refuse outright instead of degrading, when the caller forbids local fallback', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    await createLimit('PROVIDER', 'openai', 'MONTHLY', '0.0000001');
    const vendor = fakeProvider('openai');
    await expect(
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user: 'strict',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
        allowLocalFallback: false,
      }),
    ).rejects.toThrow(/spend limit/i);
    expect(vendor.hits()).toBe(0);
  });

  it('applies a global cap to every vendor and an agent cap to one agent only', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    // A global cap below the smallest possible call cost: every vendor is refused.
    await createLimit('GLOBAL', '', 'MONTHLY', '0.0000001');
    const vendorA = fakeProvider('openai');
    const vendorB = fakeProvider('anthropic');

    const blockedA = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'global-a',
      provider: vendorA.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    expect(blockedA.providerKey).toBe('local-heuristic');
    expect(vendorA.hits()).toBe(0);

    const blockedB = await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'global-b',
      provider: vendorB.provider,
      modelKey: 'anthropic-claude-sonnet-4',
    });
    expect(blockedB.providerKey).toBe('local-heuristic');
    expect(vendorB.hits()).toBe(0);

    const decision = await reserveSpend(
      db,
      { environment: LIMIT_ENV, providerKey: 'openai', agentKey: null },
      new Decimal('0.001'),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.scope).toBe('GLOBAL');
  });

  it('enforces a daily and a monthly window independently', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    const vendor = fakeProvider('openai', { tokensInput: 1000, tokensOutput: 500 });
    const model = await cataloguePrice('openai-gpt-4o-mini');
    const perCall = new Decimal(expectedCost(model.inputPer1k, model.outputPer1k, 1000, 500));
    const cap = perCall.mul('1.01').toFixed(10);
    const call = (user: string) =>
      runAIFeature(db, {
        userId: customerId,
        roles: ['CUSTOMER'],
        requestType: 'SMART_SEARCH',
        user,
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
      });

    await createLimit('PROVIDER', 'openai', 'DAILY', cap);
    expect((await call('daily-1')).providerKey).toBe('openai');
    expect((await call('daily-2')).providerKey).toBe('local-heuristic');

    const daily = await db
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, LIMIT_ENV),
          eq(aiSpendCounters.scope, 'PROVIDER'),
          eq(aiSpendCounters.period, 'DAILY'),
        ),
      );
    expect(daily.length).toBe(1);
    expect(daily[0].requests).toBe(1);

    // The daily window is spent, but the monthly window is untouched: replacing
    // the cap with a monthly one lets the very next call through again.
    await removeLimit('PROVIDER', 'openai', 'DAILY');
    await createLimit('PROVIDER', 'openai', 'MONTHLY', cap);
    expect((await call('monthly-1')).providerKey).toBe('openai');
    const monthly = await db
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, LIMIT_ENV),
          eq(aiSpendCounters.scope, 'PROVIDER'),
          eq(aiSpendCounters.period, 'MONTHLY'),
        ),
      );
    expect(monthly.length).toBe(1);
    expect(monthly[0].requests).toBe(1);
  });

  it('cannot be overrun by concurrent reservations', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    // Room for exactly three reservations of 1.00 out of a 3.00 cap.
    await createLimit('PROVIDER', 'concurrency-vendor', 'MONTHLY', '3');
    const ctx = { environment: LIMIT_ENV, providerKey: 'concurrency-vendor', agentKey: null };
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => reserveSpend(db, ctx, new Decimal(1))),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);

    const [counter] = await db
      .select()
      .from(aiSpendCounters)
      .where(
        and(
          eq(aiSpendCounters.environment, LIMIT_ENV),
          eq(aiSpendCounters.targetKey, 'concurrency-vendor'),
        ),
      );
    expect(counter.spent).toBe('3.0000000000');
  });

  it('honours a request-count cap as well as a cost cap', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    await createLimit('PROVIDER', 'count-vendor', 'MONTHLY', null, { maxRequests: 1 });
    const ctx = { environment: LIMIT_ENV, providerKey: 'count-vendor', agentKey: null };
    expect((await reserveSpend(db, ctx, new Decimal(0.001))).allowed).toBe(true);
    expect((await reserveSpend(db, ctx, new Decimal(0.001))).allowed).toBe(false);
  });

  it('raises one warning alert per period when spend approaches the cap, and audits it', async () => {
    env.AI_CONFIG_ENVIRONMENT = LIMIT_ENV;
    const model = await cataloguePrice('openai-gpt-4o-mini');
    const perCall = new Decimal(expectedCost(model.inputPer1k, model.outputPer1k, 1000, 500));
    await createLimit('PROVIDER', 'openai', 'MONTHLY', perCall.mul('1.01').toFixed(10), { warnRatio: '0.5' });
    const vendor = fakeProvider('openai', { tokensInput: 1000, tokensOutput: 500 });
    await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'warn-1',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'warn-2',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });

    const alerts = await db
      .select()
      .from(aiSpendAlerts)
      .where(and(eq(aiSpendAlerts.environment, LIMIT_ENV), eq(aiSpendAlerts.level, 'WARNING')));
    expect(alerts.length).toBe(1);
    expect(alerts[0].scope).toBe('PROVIDER');
    expect(alerts[0].targetKey).toBe('openai');

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI_SPEND.LIMIT_WARNING'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AI-05 admin desk', () => {
  it('refuses anonymous callers and non-administrators', async () => {
    const anon = client();
    expect((await anon.req('/api/admin/ai/spend')).status).toBe(401);
    expect((await anon.req('/api/admin/ai/spend/limits')).status).toBe(401);
    for (const id of [customerId, merchantId]) {
      const c = await login(await emailOf(id));
      expect((await c.req('/api/admin/ai/spend')).status).toBe(403);
      expect((await c.req('/api/admin/ai/spend/limits')).status).toBe(403);
      expect(
        (
          await c.req('/api/admin/ai/spend/limits', {
            method: 'PUT',
            body: { scope: 'GLOBAL', period: 'MONTHLY', maxCost: '5' },
          })
        ).status,
      ).toBe(403);
    }
  });

  it('shows totals broken down by agent and by provider/model for the chosen environment', async () => {
    env.AI_CONFIG_ENVIRONMENT = 'test';
    const vendor = fakeProvider('openai');
    await runAIFeature(db, {
      userId: customerId,
      roles: ['CUSTOMER'],
      requestType: 'SMART_SEARCH',
      user: 'desk',
      provider: vendor.provider,
      modelKey: 'openai-gpt-4o-mini',
    });
    // A demo-environment row must never appear in the test environment's view.
    await db.insert(aiRequests).values({
      id: randomUUID(),
      userId: customerId,
      requestType: 'SMART_SEARCH',
      model: 'openai-gpt-4o-mini',
      tokensInput: 1,
      tokensOutput: 1,
      cost: '0.5',
      currencyCode: 'USD',
      status: 'SUCCESS',
      environment: 'demo',
      providerKey: 'openai',
      vendorModel: 'gpt-4o-mini',
      costSource: 'ESTIMATED',
    });

    const admin = await login(await emailOf(adminId));
    const res = await admin.req('/api/admin/ai/spend?days=1&environment=test');
    expect(res.status).toBe(200);
    const data = res.data.data;
    expect(data.environment).toBe('test');
    expect(data.totals.requests).toBeGreaterThanOrEqual(1);
    expect(data.byAgent.some((r: any) => r.providerKey === 'openai')).toBe(true);
    expect(data.byProviderModel.some((r: any) => r.vendorModel === 'gpt-4o-mini')).toBe(true);
    expect(new Decimal(data.totals.estimatedCost).lt(0.5)).toBe(true);

    const demo = await admin.req('/api/admin/ai/spend?days=1&environment=demo');
    expect(demo.status).toBe(200);
    expect(new Decimal(demo.data.data.totals.estimatedCost).gte(0.5)).toBe(true);
    await db.delete(aiRequests).where(and(eq(aiRequests.userId, customerId), eq(aiRequests.environment, 'demo')));
  });

  it('lets an administrator manage limits and audits every change', async () => {
    const admin = await login(await emailOf(adminId));
    const created = await admin.req('/api/admin/ai/spend/limits', {
      method: 'PUT',
      body: { environment: LIMIT_ENV, scope: 'AGENT', targetKey: 'afc10-agent', period: 'DAILY', maxCost: '2.5', warnRatio: '0.9' },
    });
    expect(created.status).toBe(200);
    expect(created.data.data.maxCost).toBe('2.5000000000');

    const listed = await admin.req(`/api/admin/ai/spend/limits?environment=${LIMIT_ENV}`);
    expect(listed.status).toBe(200);
    expect(listed.data.data.limits.some((l: any) => l.targetKey === 'afc10-agent')).toBe(true);

    const invalid = await admin.req('/api/admin/ai/spend/limits', {
      method: 'PUT',
      body: { environment: LIMIT_ENV, scope: 'AGENT', targetKey: '', period: 'DAILY', maxCost: '1' },
    });
    expect(invalid.status).toBe(422);

    const noCeiling = await admin.req('/api/admin/ai/spend/limits', {
      method: 'PUT',
      body: { environment: LIMIT_ENV, scope: 'GLOBAL', period: 'DAILY' },
    });
    expect(noCeiling.status).toBe(422);

    const deleted = await admin.req(`/api/admin/ai/spend/limits/${created.data.data.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, 'ai_spend_limit'));
    expect(audits.some((a) => a.action === 'AI_SPEND.LIMIT_UPDATED')).toBe(true);
    expect(audits.some((a) => a.action === 'AI_SPEND.LIMIT_DELETED')).toBe(true);
  });

  it('scopes the overview to the requested environment and window', async () => {
    const overview = await spendOverview(db, {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
      environment: 'test',
    });
    expect(overview.environment).toBe('test');
    expect(overview.totals.requests).toBeGreaterThanOrEqual(0);
    expect(overview.byAgent.every((r) => r.requests > 0)).toBe(true);
  });
});

describe('AI-05 agent isolation', () => {
  it('denies every agent the usage ledger and the spend controls', async () => {
    const scoped = withAgentDataScope(db);
    const runCtx = {
      taskId: 'afc10-deny-task',
      ledgerTaskId: 'afc10-deny-task',
      agentKey: 'analytics-agent',
      requestedBy: adminId,
      requesterRoles: ['ADMIN'],
      authorizedActions: [],
      allowedTools: [],
    } as unknown as Parameters<typeof withAgentRunContext>[0];
    await withAgentRunContext(runCtx, async () => {
      for (const table of ['ai_requests', 'ai_usage', 'ai_budgets', 'ai_spend_limits', 'ai_spend_counters', 'ai_spend_alerts']) {
        // Even a contract that lists the table cannot open it.
        expect(() => assertTableAccess({ agentKey: 'analytics-agent', allowedTables: [table] } as any, table, 'read')).toThrow(
          /prohibited/i,
        );
      }
      expect(() => scoped.select().from(aiRequests)).toThrow(/prohibited/i);
      expect(() => scoped.select().from(aiSpendLimits)).toThrow(/prohibited/i);
      expect(() => scoped.select().from(aiSpendCounters)).toThrow(/prohibited/i);
      // The catalogue stays readable: it carries no one else's activity.
      expect(() => scoped.select().from(aiModels)).not.toThrow();
    });
  });

  it('still records platform usage while an agent runs, without exposing it to the agent', async () => {
    const vendor = fakeProvider('openai');
    const scoped = withAgentDataScope(db);
    const runCtx = {
      taskId: 'afc10-scope-task',
      ledgerTaskId: 'afc10-scope-task',
      agentKey: 'analytics-agent',
      requestedBy: adminId,
      requesterRoles: ['ADMIN'],
      authorizedActions: [],
      allowedTools: [],
    } as unknown as Parameters<typeof withAgentRunContext>[0];

    const out = await withAgentRunContext(runCtx, () =>
      runAIFeature(scoped, {
        userId: adminId,
        roles: ['ADMIN'],
        requestType: 'AGENT_TASK',
        user: 'scoped run',
        provider: vendor.provider,
        modelKey: 'openai-gpt-4o-mini',
      }),
    );
    expect(out.providerKey).toBe('openai');
    // The agent's own handle still refuses the ledger it just fed.
    await withAgentRunContext(runCtx, async () => {
      expect(() => scoped.select().from(aiRequests)).toThrow(/prohibited/i);
    });
    const [row] = await db.select().from(aiRequests).where(eq(aiRequests.id, out.requestId)).limit(1);
    expect(row.agentKey).toBe('analytics-agent');
  });
});
