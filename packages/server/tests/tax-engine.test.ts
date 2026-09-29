import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { countries } from '../src/db/schema/geo.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { countryPolicyGaps } from '../src/db/schema/engine.js';
import { taxJurisdictions, orderTaxDecisions } from '../src/db/schema/tax.js';
import { resolveTax, computeTaxAmount, recordOrderTaxDecision } from '../src/lib/tax.js';
import { configureTaxRule, markTaxRuleDecisionRequired, listCountryTaxRules } from '../src/modules/tax/service.js';
import { toDecimal } from '../src/lib/money.js';

/**
 * P1 — Tax Engine.
 *
 * Proves the engine represents an *undecided* tax position honestly (no invented
 * rate, no zero-default), that a configured rule is applied exactly as supplied,
 * and that the decision is persisted per order without rewriting history.
 */

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createStaff(roleName: 'ADMIN' | 'MERCHANT') {
  const id = randomUUID();
  const email = `it-tax-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e5)}@wasit.tn`;
  const passwordHash = await argon2.hash('StaffPass123!');
  await db.insert(users).values({ id, email, passwordHash, firstName: roleName, isActive: true, emailVerified: true });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const c = makeClient();
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client: c, id, email };
}

async function countryId(code: string): Promise<string> {
  const [row] = await db.select({ id: countries.id }).from(countries).where(eq(countries.code, code)).limit(1);
  if (!row) throw new Error(`seed missing country ${code}`);
  return row.id;
}

/** Removes the rule this suite configures, so reruns start from a clean slate. */
async function clearRule(countryIdValue: string, taxType: string) {
  await db.delete(taxJurisdictions).where(eq(taxJurisdictions.countryId, countryIdValue));
  void taxType;
}

afterAll(async () => {
  await closeDb();
});

describe('P1 tax engine — undecided rules are represented, never invented', () => {
  it('reports DECISION_REQUIRED with a null rate and amount when no rule exists', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');

    const res = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'VAT',
      amount: '1000.0000',
      currencyCode: 'TND',
    });

    expect(res.status).toBe('DECISION_REQUIRED');
    expect(res.rate).toBeNull();
    // Critically NOT '0.0000': "undecided" is not "no tax".
    expect(res.amount).toBeNull();
    expect(res.countryCode).toBe('TN');
    expect(res.taxType).toBe('VAT');
  });

  it('records a DECISION_REQUIRED gap for the jurisdiction', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');

    const res = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'VAT',
      amount: '500.0000',
      currencyCode: 'TND',
    });

    expect(res.policyGapId).toBeTruthy();
    const [gap] = await db.select().from(countryPolicyGaps).where(eq(countryPolicyGaps.id, res.policyGapId!)).limit(1);
    expect(gap.scope).toBe('TAX');
    expect(gap.code).toBe('VAT');
    expect(gap.status).toBe('DECISION_REQUIRED');
    // The reason must be explicit that the platform refused to guess a rate.
    expect(gap.reason).toMatch(/will not assume a rate/i);
  });

  it('applies a configured rate exactly as supplied', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    await configureTaxRule(db, {
      countryId: cid,
      taxType: 'VAT',
      rate: '0.19',
      priceIncludesTax: false,
      appliesTo: 'BUYER',
      actorId: 'test-admin',
    });

    const res = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'VAT',
      amount: '1000.0000',
      currencyCode: 'TND',
    });

    expect(res.status).toBe('CONFIGURED');
    expect(res.rate).toBe('0.19');
    expect(res.amount).toBe('190.0000');
    expect(res.appliesTo).toBe('BUYER');
    expect(res.policyGapId).toBeNull();
  });

  it('extracts tax from an inclusive price instead of adding it', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    await configureTaxRule(db, {
      countryId: cid,
      taxType: 'VAT',
      rate: '0.2',
      priceIncludesTax: true,
      actorId: 'test-admin',
    });

    const res = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'VAT',
      amount: '1200.0000',
      currencyCode: 'TND',
    });

    // 1200 − 1200/1.2 = 200
    expect(res.amount).toBe('200.0000');
  });

  it('a configured rule resolves the open gap', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    const undecided = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'VAT',
      amount: '100.0000',
      currencyCode: 'TND',
    });
    expect(undecided.policyGapId).toBeTruthy();

    await configureTaxRule(db, { countryId: cid, taxType: 'VAT', rate: '0.07', actorId: 'test-admin' });

    const [gap] = await db.select().from(countryPolicyGaps).where(eq(countryPolicyGaps.id, undecided.policyGapId!)).limit(1);
    expect(gap.status).toBe('RESOLVED');
  });

  it('keeps different tax types independent within one country', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    await configureTaxRule(db, { countryId: cid, taxType: 'VAT', rate: '0.19', actorId: 'test-admin' });

    const vat = await resolveTax(db, { countryCode: 'TN', taxType: 'VAT', amount: '100.0000', currencyCode: 'TND' });
    const salesTax = await resolveTax(db, {
      countryCode: 'TN',
      taxType: 'SALES_TAX',
      amount: '100.0000',
      currencyCode: 'TND',
    });

    expect(vat.status).toBe('CONFIGURED');
    expect(salesTax.status).toBe('DECISION_REQUIRED');
    expect(salesTax.rate).toBeNull();
  });
});

describe('P1 tax computation — pure, no invented rounding rules', () => {
  it('computes exclusive tax at the supplied rate', () => {
    expect(computeTaxAmount(toDecimal('250.0000'), { rate: '0.19', priceIncludesTax: false })).toBe('47.5000');
  });

  it('extracts inclusive tax at the supplied rate', () => {
    expect(computeTaxAmount(toDecimal('119.0000'), { rate: '0.19', priceIncludesTax: true })).toBe('19.0000');
  });

  it('rejects a negative rate rather than treating it as zero', () => {
    expect(() => computeTaxAmount(toDecimal('100'), { rate: '-0.1', priceIncludesTax: false })).toThrow();
  });

  it('a zero rate is a real, explicitly-configured answer', () => {
    // 0 is only ever returned when an operator configured 0 — never as a default.
    expect(computeTaxAmount(toDecimal('100.0000'), { rate: '0', priceIncludesTax: false })).toBe('0.0000');
  });
});

describe('P1 tax persistence — historical decisions are stable', () => {
  it('records the decision per order and does not rewrite it when the rule changes', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    await configureTaxRule(db, { countryId: cid, taxType: 'VAT', rate: '0.19', actorId: 'test-admin' });

    const orderId = `ord-tax-${randomUUID().slice(0, 8)}`;
    const first = await resolveTax(db, { countryCode: 'TN', taxType: 'VAT', amount: '100.0000', currencyCode: 'TND' });
    await recordOrderTaxDecision(db, { orderId, resolution: first });

    const [stored] = await db.select().from(orderTaxDecisions).where(eq(orderTaxDecisions.orderId, orderId)).limit(1);
    expect(stored.rate).toBe('0.19');
    expect(stored.amount).toBe('19.0000');
    expect(stored.status).toBe('CONFIGURED');

    // Change the jurisdiction's rule, then re-read the historical record.
    await configureTaxRule(db, { countryId: cid, taxType: 'VAT', rate: '0.21', actorId: 'test-admin' });
    const [after] = await db.select().from(orderTaxDecisions).where(eq(orderTaxDecisions.orderId, orderId)).limit(1);
    expect(after.rate).toBe('0.19');
    expect(after.amount).toBe('19.0000');
  });

  it('preserves the DECISION_REQUIRED marker on an order processed while undecided', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    const orderId = `ord-tax-${randomUUID().slice(0, 8)}`;
    const undecided = await resolveTax(db, { countryCode: 'TN', taxType: 'VAT', amount: '100.0000', currencyCode: 'TND' });
    await recordOrderTaxDecision(db, { orderId, resolution: undecided });

    // Later, a rule is configured — the historical order must NOT acquire it.
    await configureTaxRule(db, { countryId: cid, taxType: 'VAT', rate: '0.19', actorId: 'test-admin' });

    const [stored] = await db.select().from(orderTaxDecisions).where(eq(orderTaxDecisions.orderId, orderId)).limit(1);
    expect(stored.status).toBe('DECISION_REQUIRED');
    expect(stored.rate).toBeNull();
    expect(stored.amount).toBeNull();
  });
});

describe('P1 tax routes — RBAC and validation', () => {
  let admin: Awaited<ReturnType<typeof createStaff>>;
  let merchant: Awaited<ReturnType<typeof createStaff>>;

  beforeAll(async () => {
    admin = await createStaff('ADMIN');
    merchant = await createStaff('MERCHANT');
  });

  it('rejects an unauthenticated caller', async () => {
    const anon = makeClient();
    const res = await anon.req('/api/admin/tax/jurisdictions');
    expect(res.status).toBe(401);
  });

  it('rejects a MERCHANT (no admin:reports permission)', async () => {
    const res = await merchant.client.req('/api/admin/tax/jurisdictions');
    expect(res.status).toBe(403);
  });

  it('rejects a MERCHANT attempting to configure a tax rule', async () => {
    const cid = await countryId('TN');
    const res = await merchant.client.req('/api/admin/tax/jurisdictions', {
      method: 'PUT',
      body: { countryId: cid, taxType: 'VAT', rate: '0.19', reason: 'attempt by non-admin' },
    });
    expect(res.status).toBe(403);
  });

  it('lets an ADMIN list jurisdictions', async () => {
    const res = await admin.client.req('/api/admin/tax/jurisdictions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data.items)).toBe(true);
  });

  it('lets an ADMIN configure a rule and audits it', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'VAT');
    const res = await admin.client.req('/api/admin/tax/jurisdictions', {
      method: 'PUT',
      body: { countryId: cid, taxType: 'VAT', rate: '0.19', appliesTo: 'BUYER', reason: 'Configure TN VAT' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.data.data.id).toBeTruthy();

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'TAX.RULE_CONFIGURED'));
    expect(logs.length).toBeGreaterThan(0);
  });

  it('rejects a rate of 1 or more (that is not a fraction)', async () => {
    const cid = await countryId('TN');
    const res = await admin.client.req('/api/admin/tax/jurisdictions', {
      method: 'PUT',
      body: { countryId: cid, taxType: 'VAT', rate: '19', reason: 'percent instead of fraction' },
    });
    expect(res.status).toBe(422);
  });

  it('rejects a malformed rate', async () => {
    const cid = await countryId('TN');
    const res = await admin.client.req('/api/admin/tax/jurisdictions', {
      method: 'PUT',
      body: { countryId: cid, taxType: 'VAT', rate: 'abc', reason: 'not a number at all' },
    });
    expect(res.status).toBe(422);
  });

  it('resolves via the API and reports DECISION_REQUIRED for an unconfigured type', async () => {
    const cid = await countryId('TN');
    await clearRule(cid, 'GST');
    const res = await admin.client.req('/api/admin/tax/resolve', {
      method: 'POST',
      body: { countryCode: 'TN', taxType: 'GST', amount: '100.0000', currencyCode: 'TND' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('DECISION_REQUIRED');
    expect(res.data.data.amount).toBeNull();
  });

  it('can record a jurisdiction as deliberately undecided', async () => {
    const cid = await countryId('TN');
    const res = await admin.client.req('/api/admin/tax/jurisdictions/decision-required', {
      method: 'POST',
      body: { countryId: cid, taxType: 'SALES_TAX', reason: 'Pending legal review for this market' },
    });
    expect(res.status).toBe(200);
    const rules = await listCountryTaxRules(db, cid);
    const row = rules.find((r) => r.taxType === 'SALES_TAX');
    expect(row?.status).toBe('DECISION_REQUIRED');
    expect(row?.rate).toBeNull();
  });

  it('does not leak a rate for a country that has no rule at all', async () => {
    const cid = await countryId('FR');
    await clearRule(cid, 'VAT');
    const res = await admin.client.req('/api/admin/tax/resolve', {
      method: 'POST',
      body: { countryCode: 'FR', taxType: 'VAT', amount: '100.0000', currencyCode: 'EUR' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('DECISION_REQUIRED');
    expect(res.data.data.rate).toBeNull();
  });
});

describe('P1 tax — country changes behaviour (no global default)', () => {
  it('the same amount yields different decisions per country', async () => {
    const tn = await countryId('TN');
    const fr = await countryId('FR');
    await clearRule(tn, 'VAT');
    await clearRule(fr, 'VAT');

    await configureTaxRule(db, { countryId: tn, taxType: 'VAT', rate: '0.19', actorId: 'test-admin' });
    await markTaxRuleDecisionRequired(db, { countryId: fr, taxType: 'VAT', actorId: 'test-admin' });

    const inTn = await resolveTax(db, { countryCode: 'TN', taxType: 'VAT', amount: '100.0000', currencyCode: 'TND' });
    const inFr = await resolveTax(db, { countryCode: 'FR', taxType: 'VAT', amount: '100.0000', currencyCode: 'EUR' });

    expect(inTn.status).toBe('CONFIGURED');
    expect(inTn.amount).toBe('19.0000');
    expect(inFr.status).toBe('DECISION_REQUIRED');
    expect(inFr.amount).toBeNull();
  });
});
