import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { countries } from '../src/db/schema/geo.js';
import { categories, products } from '../src/db/schema/products.js';
import { suppliers } from '../src/db/schema/trade.js';
import { orders } from '../src/db/schema/commerce.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-AGENT-MERGE-01 — the three developed agents, executed against real data.
 *
 * No mocks: each task goes through `createAgentTask` → approval (when gated) →
 * executor → PostgreSQL. The assertions check the numbers against independent
 * queries and check that the agent cannot do what it must never do.
 */

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdCountryIds: string[] = [];

const AUDIT = { actorId: 'it-agent-merge', ipAddress: null, userAgent: null };

async function insertStaff(roleName: 'ADMIN' | 'SUPER_ADMIN' = 'SUPER_ADMIN') {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `aim-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('AgentMergePass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

/** Runs a task through the real lifecycle; a *different* admin approves when gated. */
async function runTask(agentKey: string, input: Record<string, unknown>, requestedBy: string) {
  const created = await createAgentTask(db, ['SUPER_ADMIN'], requestedBy, { agentKey, requestedBy, input }, AUDIT);
  if (created.status !== 'awaiting_approval') return created;
  const approver = await insertStaff('SUPER_ADMIN');
  return decideAgentTask(db, created.id, approver.id, 'APPROVE', 'AI-AGENT-MERGE-01 test approval', AUDIT);
}

function parsedAdvice(task: { result: unknown }): Record<string, unknown> {
  const advice = (task.result as { advice?: string } | null)?.advice;
  expect(typeof advice).toBe('string');
  return JSON.parse(advice as string) as Record<string, unknown>;
}

async function tunisiaCountryId(): Promise<string> {
  const found = await db.select({ id: countries.id }).from(countries).where(eq(countries.code, 'TN')).limit(1);
  if (found[0]) return found[0].id;
  const id = randomUUID();
  createdCountryIds.push(id);
  await db.insert(countries).values({
    id,
    code: 'TN',
    name: 'Tunisia',
    phonePrefix: '+216',
    currencyCode: 'TND',
    defaultLanguage: 'ar',
    isActive: true,
  });
  return id;
}

afterAll(async () => {
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    productIds: createdProductIds,
    categoryIds: createdCategoryIds,
  });
  if (createdSupplierIds.length > 0) {
    await db.delete(suppliers).where(sql`${suppliers.id} in ${createdSupplierIds}`);
  }
  if (createdCountryIds.length > 0) {
    await db.delete(countries).where(sql`${countries.id} in ${createdCountryIds}`);
  }
  await closeDb();
});

describe('AI-AGENT-MERGE-01 — Global Growth & Acquisition Agent', () => {
  it('ranks the markets from real supply and catalogue data, and drafts without sending', async () => {
    const staff = await insertStaff();
    const countryId = await tunisiaCountryId();

    const categoryId = randomUUID();
    createdCategoryIds.push(categoryId);
    await db.insert(categories).values({
      id: categoryId,
      name: `Merge Cat ${Date.now()}`,
      slug: `merge-cat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });

    const productId = randomUUID();
    createdProductIds.push(productId);
    await db.insert(products).values({
      id: productId,
      sellerId: staff.id,
      sellerType: 'SUPPLIER',
      categoryId,
      name: 'Merge product',
      slug: `merge-product-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      sku: `MRG-${Date.now()}`,
      countryId,
      basePrice: '10.0000',
      status: 'ACTIVE',
      isPublished: true,
    });

    const supplierId = randomUUID();
    createdSupplierIds.push(supplierId);
    await db.insert(suppliers).values({
      id: supplierId,
      userId: staff.id,
      companyName: `Merge Supplier ${Date.now()}`,
      slug: `merge-supplier-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      countryId,
    });

    const task = await runTask('outreach-acquisition-agent', { maxMarkets: 12, segmentLimit: 8 }, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    expect(task.error).toBeNull();

    const advice = parsedAdvice(task);
    expect(advice.agentKey).toBe('outreach-acquisition-agent');
    expect(advice.action).toBe('discover_markets');
    expect(advice.readOnly).toBe(true);

    const markets = advice.markets as Array<{
      code: string;
      supply: { suppliers: number; sellers: number };
      catalogue: { publishedProducts: number };
      priority: string;
      rationale: string;
    }>;
    expect(Array.isArray(markets)).toBe(true);
    const tn = markets.find((m) => m.code === 'TN');
    expect(tn, 'the fixture country must appear in the ranking').toBeTruthy();
    expect(tn!.supply.suppliers).toBeGreaterThanOrEqual(1);
    expect(tn!.catalogue.publishedProducts).toBeGreaterThanOrEqual(1);
    expect(['EXPAND', 'SEED', 'MONITOR']).toContain(tn!.priority);
    expect(tn!.rationale.length).toBeGreaterThan(0);

    // Drafts are drafts: nothing is sent, and the external gate is closed.
    const drafts = advice.drafts as Array<{ delivery: string; status: string; language: string }>;
    for (const draft of drafts) {
      expect(draft.delivery).toBe('none');
      expect(draft.status).toBe('DRAFT_ONLY');
      expect(typeof draft.language).toBe('string');
    }
    expect(advice.externalActions).toMatchObject({ enabled: false });
    expect((advice.externalActions as { blocked: string[] }).blocked).toEqual(
      expect.arrayContaining(['outreach.send', 'growth.paid_campaign']),
    );
  });

  it('stays behind the approval gate: a task cannot run unapproved', async () => {
    const staff = await insertStaff();
    const created = await createAgentTask(
      db,
      ['SUPER_ADMIN'],
      staff.id,
      { agentKey: 'outreach-acquisition-agent', requestedBy: staff.id, input: {} },
      AUDIT,
    );
    expect(created.status).toBe('awaiting_approval');
    expect(created.requiresApproval).toBe(true);
  });
});

describe('AI-AGENT-MERGE-01 — Finance & Cost Accounting Agent', () => {
  it('reports revenue from the same figures the database holds, with a source per line', async () => {
    const staff = await insertStaff();
    const windowDays = 30;
    const task = await runTask('finance-agent', { windowDays }, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    expect(task.error).toBeNull();

    const advice = parsedAdvice(task);
    expect(advice.action).toBe('report_pnl');
    expect(advice.readOnly).toBe(true);

    // Independent aggregate over the same window (a few seconds of tolerance).
    const since = new Date(Date.now() - windowDays * 86_400_000 - 5_000);
    const truth = await db
      .select({
        currencyCode: orders.currencyCode,
        commission: sql<string>`coalesce(sum(${orders.commission}) filter (where ${orders.status}::text <> 'CANCELLED'), 0)::text`,
        count: sql<number>`count(*) filter (where ${orders.status}::text <> 'CANCELLED')::int`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, since)))
      .groupBy(orders.currencyCode);

    const revenue = advice.revenue as Array<{ currencyCode: string; commission: string; orders: number; source: string }>;
    for (const row of revenue) {
      const expected = truth.find((t) => t.currencyCode === row.currencyCode);
      if (!expected) continue;
      expect(Number(row.commission)).toBeCloseTo(Number(expected.commission), 2);
      expect(row.orders).toBeGreaterThanOrEqual(Number(expected.count) - 1);
      expect(row.source).toContain('orders');
    }

    const dataQuality = advice.dataQuality as { crossCurrencyTotals: boolean; ledgerAccess: string };
    expect(dataQuality.crossCurrencyTotals).toBe(false);
    expect(dataQuality.ledgerAccess).toBe('denied-to-agents-by-design');

    // A contribution is either a real number or null with a reason — never invented.
    for (const c of advice.contribution as Array<{ value: string | null; reason?: string }>) {
      if (c.value === null) expect(typeof c.reason).toBe('string');
      else expect(Number.isFinite(Number(c.value))).toBe(true);
    }
  });

  it('never reads the ledger or the commission policy table', async () => {
    const staff = await insertStaff();
    const task = await runTask('finance-agent', { windowDays: 7 }, staff.id);
    expect(['succeeded', 'approved']).toContain(task.status);
    const sources = (parsedAdvice(task).sources as Array<{ table: string }>).map((s) => s.table);
    expect(sources).not.toContain('transaction_ledger');
    expect(sources).not.toContain('commission_policies');
    expect(sources).toEqual(expect.arrayContaining(['orders', 'ai_requests', 'campaigns']));
  });
});

describe('AI-AGENT-MERGE-01 — Platform Maintenance & Repair Agent', () => {
  it('diagnoses the agent layer from real task/run state, without approval and without changes', async () => {
    const staff = await insertStaff();

    // Seed a failure the diagnosis must see.
    const failingId = randomUUID();
    await db.insert(agentTasks).values({
      id: failingId,
      agentKey: 'sales-agent',
      requestedBy: staff.id,
      input: {},
      status: 'failed',
      error: { code: 'TEST_FAILURE', message: 'seeded by AI-AGENT-MERGE-01' },
    });

    const task = await runTask('development-agent', { windowDays: 7 }, staff.id);
    // Diagnosis is read-only, so it is not gated behind an approval.
    expect(task.status).toBe('succeeded');
    expect(task.error).toBeNull();

    const advice = parsedAdvice(task);
    expect(advice.action).toBe('diagnose_platform');
    expect(advice.readOnly).toBe(true);

    const health = advice.health as { taskTotal: number; failedTasks: number; failureRate: number };
    expect(health.taskTotal).toBeGreaterThanOrEqual(1);
    expect(health.failedTasks).toBeGreaterThanOrEqual(1);
    expect(health.failureRate).toBeGreaterThan(0);

    const findings = advice.findings as Array<{ code: string; severity: string; evidence: unknown; suggestedRepair: unknown }>;
    expect(findings.map((f) => f.code)).toContain('agent_task_failures');
    for (const finding of findings) {
      expect(['HIGH', 'MEDIUM', 'LOW', 'INFO']).toContain(finding.severity);
      expect(finding.evidence).toBeTruthy();
      expect(finding.suggestedRepair).toBeTruthy();
    }

    // The protocol is explicit: the agent proposes, it never applies.
    const protocol = advice.repairProtocol as { appliesChanges: boolean; requiresGmApproval: boolean; forbidden: string[] };
    expect(protocol.appliesChanges).toBe(false);
    expect(protocol.requiresGmApproval).toBe(true);
    expect(protocol.forbidden).toEqual(expect.arrayContaining(['financial_change', 'merge_without_approval']));

    await db.delete(agentTasks).where(eq(agentTasks.id, failingId));
  });
});
