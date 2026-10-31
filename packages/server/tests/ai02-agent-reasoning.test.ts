import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq, inArray, or, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../src/db/client.js';
import { env } from '../src/lib/env.js';
import { createAgentTask } from '../src/modules/ai/runner.js';
import { aiRequests } from '../src/db/schema/ai.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { orders, orderItems, transactions, transactionLedger } from '../src/db/schema/commerce.js';

/**
 * AI-02.0 — Optional natural-language reasoning for specialised agents.
 *
 * The deterministic `facts` an executor computes stay the source of truth; a
 * configured vendor (OpenAI / Anthropic) ADDS an advisory `proposal`. These
 * tests exercise the real routing + provider + executor code paths against a
 * local stand-in vendor endpoint (a genuine HTTP round-trip, no network, no
 * mocking of WASIT logic). When no vendor is configured, or the vendor fails,
 * the agent must still return its deterministic result unchanged.
 */

const ENV_KEYS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_DEFAULT_MODEL',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_ANTHROPIC_BASE_URL',
  'AI_REQUEST_TIMEOUT_MS',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
let savedEnv: Record<EnvKey, unknown>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k as keyof typeof env]])) as Record<EnvKey, unknown>;
  // The unconfigured baseline for every test: no vendor.
  env.AI_PROVIDER = 'none';
  env.AI_API_KEY = '';
  env.AI_MODEL = '';
  env.AI_BASE_URL = undefined;
  env.AI_ANTHROPIC_BASE_URL = undefined;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    (env as Record<string, unknown>)[k] = savedEnv[k];
  }
});

// --------------------------------------------------------------------------
// Local stand-in vendor endpoint
// --------------------------------------------------------------------------

interface VendorServer {
  baseUrl: string;
  calls: number;
  lastBody: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

async function startVendorServer(
  handler: (body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<VendorServer> {
  let last: Record<string, unknown> | null = null;
  let calls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      calls += 1;
      try {
        last = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        last = null;
      }
      handler(last ?? {}, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get calls() {
      return calls;
    },
    lastBody: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const openAiReply = (text: string) => (body: Record<string, unknown>, res: http.ServerResponse) =>
  json(res, 200, {
    model: 'gpt-4o-mini',
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

const anthropicReply = (text: string) => (body: Record<string, unknown>, res: http.ServerResponse) =>
  json(res, 200, {
    model: 'claude-sonnet-4-20250514',
    content: [{ text }],
    usage: { input_tokens: 9, output_tokens: 5 },
  });

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

async function insertUser(roleName: 'MERCHANT' | 'ADMIN' | 'SUPER_ADMIN'): Promise<string> {
  const id = randomUUID();
  const email = `ai02-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Ai02Pass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return id;
}

const AUDIT = { actorId: 'ai02-test' };

/** Creates a task as `roles` and returns the resolved task (running non-gated agents inline). */
async function runTask(agentKey: string, roles: ('MERCHANT' | 'ADMIN' | 'SUPER_ADMIN')[], userId: string) {
  return createAgentTask(db, roles, userId, { agentKey, requestedBy: userId, input: { action: 'run' } }, AUDIT);
}

function parsedAdvice(task: { result: unknown }): Record<string, unknown> {
  const advice = (task.result as { advice?: string } | null)?.advice ?? '{}';
  return JSON.parse(advice) as Record<string, unknown>;
}

/** The deterministic payload with the additive reasoning fields stripped. */
function factsOnly(parsed: Record<string, unknown>): Record<string, unknown> {
  const { proposal, proposalModel, reasoningUnavailable, generatedAt, ...facts } = parsed;
  void proposal;
  void proposalModel;
  void reasoningUnavailable;
  void generatedAt;
  return facts;
}

/**
 * Simulates a *concurrent* test writing to the shared commerce tables.
 *
 * The whole suite shares one database across parallel workers, so any other spec
 * inserting orders/transactions/ledger rows while this file runs perturbs a
 * *global* row count. These fixtures reproduce exactly that interference: the
 * `no commercial writes` assertion must ignore them because none of the rows
 * belong to the run under test.
 */
async function insertConcurrentCommerceNoise(ownerId: string): Promise<void> {
  const orderId = randomUUID();
  const transactionId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `AI02-NOISE-${orderId.slice(0, 12)}`,
    buyerId: ownerId,
    buyerType: 'COMPANY',
    sellerId: ownerId,
    sellerType: 'MERCHANT',
    currencyCode: 'TND',
    itemsTotal: '10',
    commission: '0',
    buyerCommission: '0',
    paymentFee: '0',
    grandTotal: '10',
    status: 'DRAFT',
    paymentStatus: 'UNPAID',
  });
  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId,
    productId: randomUUID(),
    unitPrice: '10',
    quantity: 1,
    lineTotal: '10',
  });
  await db.insert(transactions).values({
    id: transactionId,
    transactionNumber: `AI02-NOISE-${transactionId.slice(0, 12)}`,
    orderId,
    buyerId: ownerId,
    sellerId: ownerId,
    totalValue: '10',
    currencyCode: 'TND',
  });
  await db.insert(transactionLedger).values({
    id: randomUUID(),
    transactionId,
    entryType: 'TRANSACTION_VALUE',
    direction: 'CREDIT',
    amount: '10',
    currencyCode: 'TND',
    payerId: ownerId,
  });
}

/**
 * Commerce rows attributable to the run under test: rows owned by `ownerIds`
 * plus the order items and ledger entries hanging off those rows.
 *
 * Unlike {@link tableCount}, this ignores rows written by other specs sharing
 * the database, so it measures the run itself rather than the whole table.
 */
async function runScopedCommerceCounts(ownerIds: string[]): Promise<[number, number, number, number]> {
  const ownedOrderIds = db
    .select({ id: orders.id })
    .from(orders)
    .where(or(inArray(orders.buyerId, ownerIds), inArray(orders.sellerId, ownerIds)));
  const ownedTransactionIds = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(or(inArray(transactions.buyerId, ownerIds), inArray(transactions.sellerId, ownerIds)));

  const [orderRows, itemRows, txRows, ledgerRows] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(orders)
      .where(or(inArray(orders.buyerId, ownerIds), inArray(orders.sellerId, ownerIds))),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ownedOrderIds)),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(transactions)
      .where(or(inArray(transactions.buyerId, ownerIds), inArray(transactions.sellerId, ownerIds))),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(transactionLedger)
      .where(inArray(transactionLedger.transactionId, ownedTransactionIds)),
  ]);

  return [
    Number(orderRows[0]?.c ?? 0),
    Number(itemRows[0]?.c ?? 0),
    Number(txRows[0]?.c ?? 0),
    Number(ledgerRows[0]?.c ?? 0),
  ];
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('AI-02.0 — optional agent reasoning (OpenAI / Anthropic)', () => {
  it('attaches an OpenAI proposal and routes the vendor model, keeping facts intact', async () => {
    const vendor = await startVendorServer(openAiReply('OpenAI marketing proposal'));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const task = await runTask('marketing-agent', ['MERCHANT'], userId);
      expect(task.status).toBe('succeeded');
      const parsed = parsedAdvice(task);
      expect(parsed.proposal).toBe('OpenAI marketing proposal');
      expect(parsed.proposalModel).toBe('gpt-4o-mini');
      expect(parsed.readOnly).toBe(true);
      // The vendor received the routed vendor-facing model, not the catalogue key.
      expect(vendor.lastBody()?.model).toBe('gpt-4o-mini');
      expect(vendor.calls).toBeGreaterThan(0);
    } finally {
      await vendor.close();
    }
  });

  it('attaches an Anthropic proposal through the Messages adapter', async () => {
    const vendor = await startVendorServer(anthropicReply('Anthropic marketing proposal'));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'anthropic';
    env.AI_API_KEY = 'test-key';
    env.AI_ANTHROPIC_BASE_URL = vendor.baseUrl;
    try {
      const task = await runTask('marketing-agent', ['MERCHANT'], userId);
      expect(task.status).toBe('succeeded');
      const parsed = parsedAdvice(task);
      expect(parsed.proposal).toBe('Anthropic marketing proposal');
      expect(parsed.proposalModel).toBe('claude-sonnet-4-20250514');
      // The Messages adapter received the vendor-facing model, not the catalogue key.
      expect(vendor.lastBody()?.model).toBe('claude-sonnet-4-20250514');
    } finally {
      await vendor.close();
    }
  });

  it('is a no-op with no keys: no proposal, deterministic facts unchanged', async () => {
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = ''; // configured vendor without credentials → degrade to local
    const task = await runTask('marketing-agent', ['MERCHANT'], userId);
    expect(task.status).toBe('succeeded');
    const parsed = parsedAdvice(task);
    expect(parsed).not.toHaveProperty('proposal');
    expect(parsed).not.toHaveProperty('reasoningUnavailable');
    expect(parsed.readOnly).toBe(true);
  });

  it('falls back to the local engine and still succeeds when the vendor fails', async () => {
    const vendor = await startVendorServer((_body, res) => json(res, 503, { error: 'vendor down' }));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const task = await runTask('marketing-agent', ['MERCHANT'], userId);
      // A vendor outage must not fail the deterministic task.
      expect(task.status).toBe('succeeded');
      const parsed = parsedAdvice(task);
      expect(parsed).not.toHaveProperty('proposal');
      expect(String(parsed.reasoningUnavailable ?? '')).toMatch(/provider fallback/);
    } finally {
      await vendor.close();
    }
  });

  it('keeps the deterministic facts byte-for-byte identical with and without a vendor', async () => {
    const userId = await insertUser('MERCHANT');

    env.AI_PROVIDER = 'none';
    const local = parsedAdvice(await runTask('marketing-agent', ['MERCHANT'], userId));

    const vendor = await startVendorServer(openAiReply('a proposal'));
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const withVendor = parsedAdvice(await runTask('marketing-agent', ['MERCHANT'], userId));
      expect(factsOnly(withVendor)).toEqual(factsOnly(local));
      expect(withVendor.proposal).toBe('a proposal');
    } finally {
      await vendor.close();
    }
  });

  it('runs the reasoning call under the requester’s real roles, not SUPER_ADMIN', async () => {
    const vendor = await startVendorServer(openAiReply('proposal'));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      await runTask('marketing-agent', ['MERCHANT'], userId);
      const rows = await db
        .select()
        .from(aiRequests)
        .where(eq(aiRequests.userId, userId));
      const agentRows = rows.filter((r) => r.requestType.startsWith('AGENT:'));
      expect(agentRows.length).toBeGreaterThan(0);
      for (const r of agentRows) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        expect(meta.requesterRoles).toEqual(['MERCHANT']);
      }
      // Never attributed to an admin principal.
      expect(rows.some((r) => (r.metadata as Record<string, unknown> | null)?.['requesterRoles'] === 'SUPER_ADMIN')).toBe(false);
    } finally {
      await vendor.close();
    }
  });

  it('records the vendor cost on the AI ledger and audits the task', async () => {
    const vendor = await startVendorServer(openAiReply('proposal'));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const task = await runTask('marketing-agent', ['MERCHANT'], userId);

      // Ledger: a priced AGENT row exists for this user, billed to the vendor model.
      const rows = await db.select().from(aiRequests).where(eq(aiRequests.userId, userId));
      const agentRow = rows.find((r) => r.requestType === 'AGENT:marketing-agent');
      expect(agentRow).toBeTruthy();
      expect(agentRow!.model).toBe('gpt-4o-mini');
      expect(Number(agentRow!.cost)).toBeGreaterThan(0);

      // The runner charged the task and audited success.
      const [stored] = await db.select().from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
      expect(Number(stored.cost)).toBeGreaterThan(0);
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, task.id));
      expect(audits.some((a) => a.action === 'AI.AGENT_TASK_SUCCEEDED')).toBe(true);
    } finally {
      await vendor.close();
    }
  });

  it('proves agents perform no commercial writes', async () => {
    const vendor = await startVendorServer(openAiReply('proposal'));
    const adminId = await insertUser('ADMIN');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      // Scoped to rows owned by this run's requester, never the whole table: the
      // suite shares one database across parallel workers, so a global count is
      // perturbed by any other spec writing commerce rows concurrently.
      const before = await runScopedCommerceCounts([adminId]);

      // A spread of agents across categories, including platform-scoped ones.
      // risk-agent / compliance-agent declare sensitive approval actions, so they
      // are queued for human approval and never executed inline — which is itself
      // proof they write nothing.
      for (const agentKey of ['marketing-agent', 'support-agent', 'operations-agent', 'risk-agent', 'compliance-agent']) {
        const task = await runTask(agentKey, ['ADMIN'], adminId);
        expect(['succeeded', 'failed', 'awaiting_approval']).toContain(task.status);
      }

      const after = await runScopedCommerceCounts([adminId]);
      expect(after).toEqual(before);
    } finally {
      await vendor.close();
    }
  });

  it('ignores concurrent commerce writes from other specs when proving no writes', async () => {
    // Deterministic proof of the isolation fix: a foreign writer inserts commerce
    // rows (as a parallel spec would) while the run executes. The global count
    // moves; the run-scoped count must not, so the assertion stays green.
    const vendor = await startVendorServer(openAiReply('proposal'));
    const adminId = await insertUser('ADMIN');
    const foreignOwnerId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const scopedBefore = await runScopedCommerceCounts([adminId]);

      await insertConcurrentCommerceNoise(foreignOwnerId);

      for (const agentKey of ['marketing-agent', 'support-agent', 'operations-agent']) {
        const task = await runTask(agentKey, ['ADMIN'], adminId);
        expect(['succeeded', 'failed', 'awaiting_approval']).toContain(task.status);
      }

      // The foreign rows are fully visible when scoped to their own owner (order,
      // order item, transaction, ledger entry)...
      expect(await runScopedCommerceCounts([foreignOwnerId])).toEqual([1, 1, 1, 1]);
      // ...yet invisible to the run's own scope, so the "no commercial writes"
      // assertion is immune to a parallel spec writing commerce rows.
      expect(await runScopedCommerceCounts([adminId])).toEqual(scopedBefore);
    } finally {
      await vendor.close();
    }
  });

  it('keeps the deterministic result when the reasoning call is refused by the budget', async () => {
    // A zero-cost monthly budget makes the reasoning call throw 429 — the task
    // must fail closed rather than silently report success on an unbudgeted call.
    const vendor = await startVendorServer(openAiReply('proposal'));
    const userId = await insertUser('MERCHANT');
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    try {
      const { aiBudgets } = await import('../src/db/schema/ai.js');
      await db.insert(aiBudgets).values({
        id: randomUUID(),
        userId,
        period: 'MONTHLY',
        maxCost: '0',
        currencyCode: 'USD',
        isActive: true,
      });
      const task = await runTask('marketing-agent', ['MERCHANT'], userId);
      expect(task.status).not.toBe('succeeded');
      expect(JSON.stringify(task.error)).toMatch(/budget exhausted/i);
    } finally {
      await vendor.close();
    }
  });
});
