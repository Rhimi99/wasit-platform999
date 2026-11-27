import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { UserRole } from '@wasit/shared';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentMetrics } from '../src/db/schema/agents.js';
import { orders } from '../src/db/schema/commerce.js';
import { products, categories } from '../src/db/schema/products.js';
import { suppliers, merchants, companies } from '../src/db/schema/trade.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import { AGENT_CATALOGUE } from '../src/modules/ai/catalogue.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-FIRST-COMPLETION-03 — row-level data scope for the agents that stay
 * available to tenants.
 *
 * `ownerScoped: true` in the A2 contract bounds *tables*, not rows. These tests
 * prove the executors filter rows by real ownership: a customer, merchant or
 * company sees its own orders and listings and never another tenant's, while
 * platform metrics stay with ADMIN/SUPER_ADMIN.
 */

const AUDIT = { actorId: 'it-data-scope', ipAddress: null, userAgent: null };
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdOrderIds: string[] = [];

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser(roleName: UserRole): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `ds-${roleName.toLowerCase()}-${uniq()}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'DS',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

async function createMerchant(userId: string, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(merchants).values({ id, userId, storeName: `${label} Store ${id.slice(0, 6)}`, slug: `ds-merchant-${id.slice(0, 8)}` });
  createdMerchantIds.push(id);
  return id;
}

async function createCompany(userId: string, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(companies).values({ id, userId, legalName: `${label} Company ${id.slice(0, 6)}`, slug: `ds-company-${id.slice(0, 8)}` });
  createdCompanyIds.push(id);
  return id;
}

async function createSupplier(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(suppliers).values({ id, userId, companyName: `DS Supplier ${id.slice(0, 6)}`, slug: `ds-supplier-${id.slice(0, 8)}` });
  createdSupplierIds.push(id);
  return id;
}

async function createProduct(
  sellerId: string,
  sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY',
  name: string,
  brand: string,
): Promise<string> {
  const categoryId = randomUUID();
  await db.insert(categories).values({ id: categoryId, name: `DS Cat ${categoryId.slice(0, 6)}`, slug: `ds-cat-${categoryId.slice(0, 8)}` });
  createdCategoryIds.push(categoryId);
  const id = randomUUID();
  await db.insert(products).values({
    id,
    sellerId,
    sellerType,
    categoryId,
    name,
    slug: `ds-product-${id.slice(0, 8)}`,
    sku: `DS-${id.slice(0, 8)}`,
    basePrice: '100.0000',
    currencyCode: 'TND',
    brand,
    isPublished: true,
    status: 'ACTIVE',
  });
  createdProductIds.push(id);
  return id;
}

async function createOrder(opts: { buyerId: string; sellerId: string; sellerType: 'SUPPLIER' | 'MERCHANT' | 'COMPANY'; total: string }) {
  const id = randomUUID();
  await db.insert(orders).values({
    id,
    orderNumber: `DS-${id.slice(0, 8)}`,
    buyerId: opts.buyerId,
    buyerType: 'CUSTOMER',
    sellerId: opts.sellerId,
    sellerType: opts.sellerType,
    itemsTotal: opts.total,
    grandTotal: opts.total,
    status: 'CONFIRMED',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdOrderIds.push(id);
  return id;
}

async function runAgent(role: UserRole, requesterId: string, agentKey: string, input: Record<string, unknown> = {}) {
  const task = await createAgentTask(db, [role], requesterId, { agentKey, requestedBy: requesterId, input }, { ...AUDIT, actorId: requesterId });
  createdTaskIds.push(task.id);
  // Gated agents (sales, b2b, outreach) need a separate approver to run.
  // ADMIN, not SUPER_ADMIN: the bootstrap suite asserts a single platform owner.
  if (task.status === 'awaiting_approval') {
    const approver = await createUser('ADMIN');
    await decideAgentTask(db, task.id, approver, 'APPROVE', 'it data-scope approval', AUDIT);
  }
  const fresh = await db.select().from(agentTasks).where(eq(agentTasks.id, task.id)).limit(1);
  const row = fresh[0]!;
  const advice = row.result && typeof (row.result as { advice?: string }).advice === 'string'
    ? JSON.parse((row.result as { advice: string }).advice)
    : null;
  return { task, row, advice };
}

afterAll(async () => {
  if (createdOrderIds.length > 0) await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    taskIds: createdTaskIds,
    productIds: createdProductIds,
    categoryIds: createdCategoryIds,
  });
  if (createdSupplierIds.length > 0) await db.delete(suppliers).where(inArray(suppliers.id, createdSupplierIds));
  if (createdMerchantIds.length > 0) await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  if (createdCompanyIds.length > 0) await db.delete(companies).where(inArray(companies.id, createdCompanyIds));
  await closeDb();
});

describe('AI — row-level data scope (AI-FIRST-COMPLETION-03)', () => {
  it('a customer sees only the orders it placed, never another customer’s', async () => {
    const merchantUser = await createUser('MERCHANT');
    const merchantId = await createMerchant(merchantUser, 'ScopeSeller');
    const customerA = await createUser('CUSTOMER');
    const customerB = await createUser('CUSTOMER');
    const orderA = await createOrder({ buyerId: customerA, sellerId: merchantId, sellerType: 'MERCHANT', total: '111.0000' });
    const orderB = await createOrder({ buyerId: customerB, sellerId: merchantId, sellerType: 'MERCHANT', total: '999.0000' });

    const { advice } = await runAgent('CUSTOMER', customerA, 'sales-agent', { periodDays: 3650 });

    expect(advice.dataScope).toBe('own');
    expect(advice.kpi.orders).toBe(1);
    expect(advice.kpi.gmv).toBe('111.0000');
    expect(advice.recentOrders.map((o: { id: string }) => o.id)).toEqual([orderA]);
    expect(advice.recentOrders.map((o: { id: string }) => o.id)).not.toContain(orderB);
    // Platform metrics are not disclosed to a tenant.
    expect(advice.kpi.suppliers).toBeNull();
    expect(advice.kpi.merchants).toBeNull();
    expect(advice.kpi.companies).toBeNull();
    expect(advice.leadsPotential).toBeNull();
  });

  it('a merchant sees only orders sold by its own entity, never another merchant’s', async () => {
    const merchantAUser = await createUser('MERCHANT');
    const merchantBUser = await createUser('MERCHANT');
    const merchantA = await createMerchant(merchantAUser, 'Alpha');
    const merchantB = await createMerchant(merchantBUser, 'Beta');
    const buyer = await createUser('CUSTOMER');
    const ownOrder = await createOrder({ buyerId: buyer, sellerId: merchantA, sellerType: 'MERCHANT', total: '50.0000' });
    const otherOrder = await createOrder({ buyerId: buyer, sellerId: merchantB, sellerType: 'MERCHANT', total: '700.0000' });

    const { advice } = await runAgent('MERCHANT', merchantAUser, 'sales-agent', { periodDays: 3650 });

    expect(advice.dataScope).toBe('own');
    expect(advice.kpi.gmv).toBe('50.0000');
    expect(advice.recentOrders.map((o: { id: string }) => o.id)).toEqual([ownOrder]);
    expect(advice.recentOrders.map((o: { id: string }) => o.id)).not.toContain(otherOrder);
  });

  it('a merchant’s marketing snapshot counts only its own published listings', async () => {
    const merchantAUser = await createUser('MERCHANT');
    const merchantBUser = await createUser('MERCHANT');
    const merchantA = await createMerchant(merchantAUser, 'Alpha');
    const merchantB = await createMerchant(merchantBUser, 'Beta');
    await createProduct(merchantA, 'MERCHANT', 'Alpha Olive Oil', 'AlphaBrand');
    await createProduct(merchantB, 'MERCHANT', 'Beta Ceramics', 'BetaBrand');

    const { advice } = await runAgent('MERCHANT', merchantAUser, 'marketing-agent', { limit: 10 });

    expect(advice.dataScope).toBe('own');
    expect(advice.snapshot.published).toBe(1);
    expect(advice.snapshot.topBrands.map((b: { name: string }) => b.name)).toEqual(['AlphaBrand']);
    expect(JSON.stringify(advice)).not.toContain('BetaBrand');
    expect(JSON.stringify(advice)).not.toContain('Beta Ceramics');
  });

  it('a company’s marketing snapshot counts only its own listings', async () => {
    const companyAUser = await createUser('COMPANY');
    const companyBUser = await createUser('COMPANY');
    const companyA = await createCompany(companyAUser, 'Alpha');
    const companyB = await createCompany(companyBUser, 'Beta');
    await createProduct(companyA, 'COMPANY', 'Alpha Machinery', 'AlphaCorp');
    await createProduct(companyB, 'COMPANY', 'Beta Machinery', 'BetaCorp');

    const { advice } = await runAgent('COMPANY', companyAUser, 'marketing-agent', { limit: 10 });

    expect(advice.dataScope).toBe('own');
    expect(advice.snapshot.published).toBe(1);
    expect(JSON.stringify(advice)).not.toContain('BetaCorp');
  });

  it('the product agent refuses another company’s product without revealing it', async () => {
    const companyAUser = await createUser('COMPANY');
    const companyBUser = await createUser('COMPANY');
    const companyA = await createCompany(companyAUser, 'Alpha');
    const companyB = await createCompany(companyBUser, 'Beta');
    const ownProduct = await createProduct(companyA, 'COMPANY', 'Alpha Machinery', 'AlphaCorp');
    const foreignProduct = await createProduct(companyB, 'COMPANY', 'Secret Beta Machine', 'BetaCorp');

    const foreign = await runAgent('COMPANY', companyAUser, 'product-agent', { productId: foreignProduct });
    expect(foreign.advice.refused).toBe(true);
    expect(foreign.advice.code).toBe('PRODUCT_NOT_AVAILABLE');
    expect(foreign.advice.product).toBeUndefined();
    // No existence oracle and no content: the id is the only thing echoed back.
    expect(JSON.stringify(foreign.advice)).not.toContain('Secret Beta Machine');
    expect(JSON.stringify(foreign.advice)).not.toContain('BetaCorp');

    const own = await runAgent('COMPANY', companyAUser, 'product-agent', { productId: ownProduct });
    expect(own.advice.refused).toBeUndefined();
    expect(own.advice.dataScope).toBe('own');
    expect(own.advice.product).toMatchObject({ id: ownProduct, name: 'Alpha Machinery' });
  });

  it('the product agent without a productId picks only from the caller’s own catalogue', async () => {
    const supplierUser = await createUser('SUPPLIER');
    const supplierId = await createSupplier(supplierUser);
    await createProduct(supplierId, 'SUPPLIER', 'Own Product Only', 'OwnBrand');

    const { advice } = await runAgent('SUPPLIER', supplierUser, 'product-agent', {});
    expect(advice.product.name).toBe('Own Product Only');
  });

  it('the B2B agent is platform-scope: a merchant is refused before any task row', async () => {
    const merchantUser = await createUser('MERCHANT');
    await createMerchant(merchantUser, 'Alpha');
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, merchantUser));

    await expect(
      createAgentTask(
        db,
        ['MERCHANT'],
        merchantUser,
        { agentKey: 'compliance-agent', requestedBy: merchantUser, input: {} },
        { ...AUDIT, actorId: merchantUser },
      ),
    ).rejects.toThrow(/platform-wide/);

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentTasks)
      .where(eq(agentTasks.requestedBy, merchantUser));
    expect(after[0]!.n).toBe(before[0]!.n);

    const audits = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'AI.AGENT_RUN_REFUSED'), eq(auditLogs.entityId, 'compliance-agent')))
      .orderBy(sql`${auditLogs.createdAt} desc`)
      .limit(3);
    const metadata = audits[0]?.metadata as Record<string, unknown> | null;
    expect(metadata?.code).toBe('PLATFORM_SCOPE_REQUIRED');
    // The audit records the refusal, never the data that was protected.
    expect(metadata).not.toHaveProperty('result');
    expect(JSON.stringify(metadata)).not.toContain('Alpha Store');

    // The refusal is counted as blocked for this agent and this requester only.
    const metrics = await db
      .select()
      .from(agentMetrics)
      .where(and(eq(agentMetrics.agentKey, 'compliance-agent'), eq(agentMetrics.scopeOwner, merchantUser)));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ outcome: 'blocked', errorCode: 'PLATFORM_SCOPE_REQUIRED', taskId: null });
  });

  it.each(['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'SUPPORT'] as UserRole[])(
    'refuses %s on the platform-metric agents (finance, outreach) before writing a task',
    async (role) => {
      for (const agentKey of ['finance-agent', 'outreach-acquisition-agent']) {
        const userId = await createUser(role);
        const before = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentTasks)
          .where(eq(agentTasks.requestedBy, userId));
        await expect(
          createAgentTask(db, [role], userId, { agentKey, requestedBy: userId, input: {} }, { ...AUDIT, actorId: userId }),
        ).rejects.toThrow(/platform-wide/);
        const after = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agentTasks)
          .where(eq(agentTasks.requestedBy, userId));
        expect(after[0]!.n, `${role} → ${agentKey}`).toBe(before[0]!.n);
      }
    },
  );

  it.each(['ADMIN', 'SUPER_ADMIN'] as UserRole[])('keeps the platform view for %s', async (role) => {
    const adminUser = await createUser(role);
    const sales = await runAgent(role, adminUser, 'sales-agent', { periodDays: 3650 });
    expect(sales.advice.dataScope).toBe('platform');
    expect(typeof sales.advice.kpi.suppliers).toBe('number');
    expect(typeof sales.advice.kpi.merchants).toBe('number');
    expect(sales.advice.leadsPotential).not.toBeNull();

    const finance = await runAgent(role, adminUser, 'finance-agent', { windowDays: 30 });
    expect(finance.advice).not.toBeNull();
    expect(finance.advice.refused).toBeUndefined();
  });

  it('declares platform scope for the six agents whose data is platform-wide', () => {
    const platform = AGENT_CATALOGUE.filter((a) => a.requiresPlatformScope).map((a) => a.key);
    expect(platform).toEqual(
      expect.arrayContaining([
        'compliance-agent',
        'finance-agent',
        'outreach-acquisition-agent',
        'development-agent',
        'risk-agent',
        'analytics-agent',
      ]),
    );
    // The row-filtered agents must stay available to tenants. `b2b-agent` is
    // row-filtered by consent since AFC-04 (only opted-in tenants are visible).
    for (const key of ['sales-agent', 'marketing-agent', 'product-agent', 'b2b-agent']) {
      expect(AGENT_CATALOGUE.find((a) => a.key === key)?.requiresPlatformScope ?? false).toBe(false);
    }
  });
});
