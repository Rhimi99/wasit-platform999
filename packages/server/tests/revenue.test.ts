import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { transactions, transactionLedger } from '../src/db/schema/commerce.js';
import { invoices } from '../src/db/schema/subscriptions.js';
import { aiUsage } from '../src/db/schema/ai.js';
import { revenueAccounts, scenarioReports } from '../src/db/schema/revenue.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { newId } from '../src/lib/ids.js';
import { coreMiddleware } from '../src/middleware/core.js';
import { errorBody } from '../src/middleware/errors.js';
import { revenueRoutes } from '../src/modules/revenue/routes.js';
import { calculateScenario, getRevenueProfitability } from '../src/modules/revenue/service.js';
import type { UserRole } from '@wasit/shared';

const app = createApp();

/** Cookie-managed test client bound to a specific Hono app. */
function makeClient(base: Hono, initialCookie = '') {
  let cookie = initialCookie;
  return {
    cookie(): string {
      return cookie;
    },
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await base.request(path, {
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
      return { data: data as any, status: res.status };
    },
  };
}

/**
 * Register a normal user via the real auth API (always created as CUSTOMER,
 * because the auth service downgrades any requested SUPER_ADMIN), then grant
 * the desired role by inserting a real user_roles row. Updated roles are
 * picked up on every request because requireAuth loads roles from the DB per
 * request (see src/middleware/auth.ts).
 */
async function createUserWithRole(role: UserRole, tag: string): Promise<{ id: string; cookie: string }> {
  const c = makeClient(app);
  const email = `revenue-${tag}-${role}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  const reg = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: tag, role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);

  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const id = (login.data.data as { id: string }).id;
  expect(id).toBeTruthy();

  if (role === 'CUSTOMER') {
    return { id, cookie: c.cookie() };
  }
  const roleRow = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  expect(roleRow.length).toBe(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow[0].id });

  return { id, cookie: c.cookie() };
}

/** Mount-only revenue app: coreMiddleware + revenueRoutes + errorBody onError. */
function makeRevenueApp(): Hono {
  const r = new Hono();
  r.use('*', coreMiddleware);
  r.route('/api/revenue', revenueRoutes);
  r.onError((err, c) => errorBody(err, c));
  return r;
}

const seededTxIds: string[] = [];
const seededInvoiceIds: string[] = [];
const seededAiUsageIds: string[] = [];

beforeAll(async () => {
  await db.delete(revenueAccounts);
  await db.delete(scenarioReports);
});

afterAll(async () => {
  await db.delete(revenueAccounts);
  await db.delete(scenarioReports);
  for (const tid of seededTxIds) {
    await db.delete(transactionLedger).where(eq(transactionLedger.transactionId, tid));
    await db.delete(transactions).where(eq(transactions.id, tid));
  }
  for (const iid of seededInvoiceIds) {
    await db.delete(invoices).where(eq(invoices.id, iid));
  }
  for (const aid of seededAiUsageIds) {
    await db.delete(aiUsage).where(eq(aiUsage.id, aid));
  }
  await closeDb();
});

describe('calculateScenario — pure computation', () => {
  it('computes gross revenue, total costs, net and contribution margin', () => {
    const r = calculateScenario({
      transactionVolume: '1000',
      commissionRate: '3',
      paymentFeeRate: '1',
      refundRate: '0.5',
      expectedOrders: '0',
      avgOrderValue: '0',
      subscriptionRevenue: '0',
      advertisingRevenue: '0',
      aiCosts: '0',
      operationalExpenses: '0',
      currencyCode: 'TND',
    });
    // commission = 3% of 1000 = 30; fees = 1% = 10; refunds = 0.5% = 5
    expect(r.grossRevenue).toBe('30.0000');
    expect(r.totalCosts).toBe('15.0000');
    expect(r.netRevenue).toBe('15.0000');
    expect(r.contributionMargin).toBe('50.0000');
    expect(r.outputId).toBeTruthy();
    expect(r.comment).toMatch(/does not modify any live data/);
  });

  it('handles zero volume (contribution margin 0) without division error', () => {
    const r = calculateScenario({
      transactionVolume: '0',
      commissionRate: '3',
      paymentFeeRate: '1',
      refundRate: '0',
      expectedOrders: '0',
      avgOrderValue: '0',
      subscriptionRevenue: '0',
      advertisingRevenue: '0',
      aiCosts: '0',
      operationalExpenses: '0',
      currencyCode: 'TND',
    });
    expect(r.grossRevenue).toBe('0.0000');
    expect(r.totalCosts).toBe('0.0000');
    expect(r.netRevenue).toBe('0.0000');
    expect(r.contributionMargin).toBe('0.0000');
    expect(r.comment).toContain('TND');
  });

  it('rounds values beyond 4 decimal places (ROUND_HALF_UP)', () => {
    const r = calculateScenario({
      transactionVolume: '1000.00005',
      commissionRate: '3',
      paymentFeeRate: '1',
      refundRate: '0.5',
      expectedOrders: '0',
      avgOrderValue: '0',
      subscriptionRevenue: '0',
      advertisingRevenue: '0',
      aiCosts: '0',
      operationalExpenses: '0',
      currencyCode: 'TND',
    });
    // volume rounds to 1000.0000 for transport; then 30 / 15 / 15 / 50
    expect(r.grossRevenue).toBe('30.0000');
    expect(r.totalCosts).toBe('15.0000');
    expect(r.netRevenue).toBe('15.0000');
    expect(r.contributionMargin).toBe('50.0000');
  });
});

describe('revenue routes — validation and RBAC', () => {
  const rev = makeRevenueApp();
  const rv = (cookie: string) => makeClient(rev, cookie);

  it('rejects invalid scenario payload (422) with field-level details', async () => {
    const u = await createUserWithRole('SUPER_ADMIN', 'SimVal');
    const r = await rv(u.cookie).req('/api/revenue/scenario', {
      method: 'POST',
      body: {
        transactionVolume: '100',
        commissionRate: '3',
        paymentFeeRate: '1',
        refundRate: '0',
        currencyCode: 'TNDD',
      },
    });
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(r.data.error.fieldErrors)).toBe(true);
  });

  it('rejects unauthenticated access to report (401)', async () => {
    const c = makeClient(rev);
    const r = await c.req('/api/revenue/report');
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects CUSTOMER (403) — REVENUE_* is granted only to SUPER_ADMIN', async () => {
    const u = await createUserWithRole('CUSTOMER', 'RbacCust');
    const r = await rv(u.cookie).req('/api/revenue/report');
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('FORBIDDEN');
  });

  it('lets SUPER_ADMIN read the report (200) and writes audit', async () => {
    const u = await createUserWithRole('SUPER_ADMIN', 'RbacSuper');
    const r = await rv(u.cookie).req('/api/revenue/report');
    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    const report = r.data.data;
    expect(report.currencyCode).toBe('TND');
    expect(typeof report.grossRevenue).toBe('string');
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, 'REVENUE.REPORT_READ')).limit(1);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});

describe('getRevenueProfitability — aggregated from real tables', () => {
  /**
   * These aggregate over whole tables (transaction_ledger, invoices, ai_usage,
   * revenue_accounts) that every spec shares. Real TND orders/payments from other
   * specs are committed concurrently, so absolute TND totals were order-dependent
   * and flaky. Each test seeds under its own private currency code, so the
   * currency-scoped aggregate provably contains only the rows it created.
   */
  it('computes commission/paymentFees/refunds from transaction_ledger (CREDIT − DEBIT)', async () => {
    const u = await createUserWithRole('SUPER_ADMIN', 'Ledger');
    const cur = 'ZLC';
    const txId = newId();
    seededTxIds.push(txId);
    await db.insert(transactions).values({
      id: txId,
      transactionNumber: `T-REV-${Date.now()}`,
      buyerId: 'revenue-test',
      sellerId: u.id,
      totalValue: '1000.0000',
      currencyCode: cur,
      commission: '30.0000',
      paymentFee: '10.0000',
      status: 'PAID',
    });
    await db.insert(transactionLedger).values([
      { id: newId(), transactionId: txId, entryType: 'COMMISSION', direction: 'CREDIT', amount: '30.0000', currencyCode: cur },
      { id: newId(), transactionId: txId, entryType: 'COMMISSION', direction: 'DEBIT', amount: '5.0000', currencyCode: cur },
      { id: newId(), transactionId: txId, entryType: 'PAYMENT_FEE', direction: 'CREDIT', amount: '10.0000', currencyCode: cur },
      { id: newId(), transactionId: txId, entryType: 'REFUND', direction: 'CREDIT', amount: '7.0000', currencyCode: cur },
      { id: newId(), transactionId: txId, entryType: 'TRANSACTION_VALUE', direction: 'CREDIT', amount: '1000.0000', currencyCode: cur },
    ]);
    const report = await getRevenueProfitability(db, cur);
    // COMMISSION net = 30 − 5 = 25 ; PAYMENT_FEE = 10 ; REFUND = 7
    expect(report.commission).toBe('25.0000');
    expect(report.paymentFees).toBe('10.0000');
    expect(report.refunds).toBe('7.0000');
    expect(report.advertisingRevenue).toBe('0.0000');
  });

  it('counts only PAID invoices as subscription revenue', async () => {
    const cur = 'ZIN';
    const subId = newId();
    const paidId = newId();
    const pendId = newId();
    seededInvoiceIds.push(paidId, pendId);
    await db.insert(invoices).values([
      { id: paidId, subscriptionId: subId, invoiceNumber: `INV-PAID-${Date.now()}`, amount: '50.0000', currencyCode: cur, status: 'PAID' },
      { id: pendId, subscriptionId: subId, invoiceNumber: `INV-PEND-${Date.now()}`, amount: '900.0000', currencyCode: cur, status: 'PENDING' },
    ]);
    const report = await getRevenueProfitability(db, cur);
    expect(report.subscriptionRevenue).toBe('50.0000');
  });

  it('counts ai_usage.cost scoped to currency and never mixes currencies', async () => {
    const tndCur = 'ZAT';
    const usdCur = 'ZAU';
    const tndId = newId();
    const usdId = newId();
    seededAiUsageIds.push(tndId, usdId);
    await db.insert(aiUsage).values([
      { id: tndId, userId: 'revenue-test', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01'), requestCount: 1, tokensInput: 10, tokensOutput: 5, cost: '1.5000', currencyCode: tndCur },
      { id: usdId, userId: 'revenue-test', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01'), requestCount: 1, tokensInput: 10, tokensOutput: 5, cost: '9.0000', currencyCode: usdCur },
    ]);
    const tnd = await getRevenueProfitability(db, tndCur);
    const usd = await getRevenueProfitability(db, usdCur);
    expect(tnd.aiModelCosts).toBe('1.5000');
    expect(usd.aiModelCosts).toBe('9.0000');
  });

  it('sums operational revenue/cost from revenue_accounts by currency', async () => {
    const revCur = 'ZOR';
    const costCur = 'ZOC';
    await db.insert(revenueAccounts).values([
      { id: newId(), lineType: 'REVENUE', category: 'OTHER', name: 'Op Rev', amount: '40.0000', currencyCode: revCur },
      { id: newId(), lineType: 'COST', category: 'INFRASTRUCTURE', name: 'Op Cost', amount: '15.0000', currencyCode: costCur },
    ]);
    const rev = await getRevenueProfitability(db, revCur);
    expect(rev.otherRevenue).toBe('40.0000');
    const cost = await getRevenueProfitability(db, costCur);
    expect(cost.operationalExpenses).toBe('15.0000');
  });

  it('gross/net cross-check from components; basedOn documents real sources', async () => {
    const report = await getRevenueProfitability(db, 'TND');
    const gross = Number(report.grossRevenue);
    const costs = Number(report.totalCosts);
    expect(gross).toBeCloseTo(
      Number(report.commission) +
        Number(report.subscriptionRevenue) +
        Number(report.advertisingRevenue) +
        Number(report.otherRevenue),
      5,
    );
    expect(costs).toBeCloseTo(
      Number(report.paymentFees) +
        Number(report.refunds) +
        Number(report.aiModelCosts) +
        Number(report.operationalExpenses) +
        Number(report.otherCosts),
      5,
    );
    expect(Number(report.netRevenue)).toBeCloseTo(gross - costs, 5);
    expect(report.basedOn).toContain('transaction_ledger COMMISSION (currency=TND)');
    expect(report.basedOn.join(' ')).toMatch(/advertisingRevenue=0/);
  });
});

describe('scenario reports — listing and owner isolation', () => {
  const rev = makeRevenueApp();
  const rv = (cookie: string) => makeClient(rev, cookie);

  it('lists own scenario reports (owner-scoped, 200)', async () => {
    const u = await createUserWithRole('SUPER_ADMIN', 'ScenOwner');
    await db.insert(scenarioReports).values({
      id: newId(),
      name: 'Test Scenario',
      status: 'PLANNING',
      inputs: { foo: 1 },
      outputs: { net: '0' },
      currencyCode: 'TND',
      createdById: u.id,
    });
    const r = await rv(u.cookie).req(`/api/revenue/scenarios?createdById=${u.id}`);
    expect(r.status).toBe(200);
    expect(r.data.data.items).toEqual([expect.objectContaining({ name: 'Test Scenario' })]);
  });

  it('blocks reading another user\'s scenarios (403 after ApiError.forbidden fix)', async () => {
    const a = await createUserWithRole('SUPER_ADMIN', 'ScenA');
    const b = await createUserWithRole('SUPER_ADMIN', 'ScenB');
    await db.insert(scenarioReports).values({
      id: newId(),
      name: 'B Scenario',
      status: 'PLANNING',
      inputs: { foo: 2 },
      outputs: { net: '1' },
      currencyCode: 'TND',
      createdById: b.id,
    });
    const r = await rv(a.cookie).req(`/api/revenue/scenarios?createdById=${b.id}`);
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('FORBIDDEN');
    expect(r.data.error.message).toMatch(/E_FORBIDDEN/);
  });
});

describe('no wallet / no user funds held', () => {
  it('revenue tables only capture WASIT P&L lines and scenario snapshots', async () => {
    // Safe raw query in the project's style (db.execute with sql template literal).
    const result = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('revenue_accounts', 'scenario_reports')
    `)) as unknown as { rows: Array<{ column_name: string }> };
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).not.toContain('balance');
    expect(cols).not.toContain('wallet');
    expect(cols).not.toContain('hold');
  });
});

describe('integration — revenue via real createApp()', () => {
  const integrationApp = createApp();

  function makeClient() {
    let cookie = '';
    return {
      async req(path: string, options: { method?: string; body?: unknown } = {}) {
        const headers: Record<string, string> = {};
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (cookie) headers.Cookie = cookie;
        const res = await integrationApp.request(path, {
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
        return { data: data as any, status: res.status };
      },
    };
  }

  it('POST /api/revenue/scenario works through the real app with a SUPER_ADMIN session', async () => {
    const id = randomUUID();
    const email = `rev-it-super-${Date.now()}@wasit.tn`;
    const passwordHash = await argon2.hash('SuperPass123!');
    await db.insert(users).values({
      id,
      email,
      passwordHash,
      firstName: 'Integration Super',
      isActive: true,
      emailVerified: true,
    });
    const role = await db.select().from(roles).where(eq(roles.name, 'SUPER_ADMIN')).limit(1);
    expect(role.length).toBe(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });

    const c = makeClient();
    const login = await c.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'SuperPass123!', allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const scenario = await c.req('/api/revenue/scenario', {
      method: 'POST',
      body: {
        transactionVolume: '1000',
        commissionRate: '3',
        paymentFeeRate: '1',
        refundRate: '0.5',
        currencyCode: 'TND',
      },
    });
    expect(scenario.status).toBe(200);
    expect(scenario.data.success).toBe(true);
    const result = scenario.data.data;
    expect(result.grossRevenue).toBe('30.0000');
    expect(result.totalCosts).toBe('15.0000');
    expect(result.netRevenue).toBe('15.0000');
    expect(result.contributionMargin).toBe('50.0000');
    expect(result.outputId).toBeTruthy();
    expect(result.comment).toMatch(/does not modify any live data/);
  });
});