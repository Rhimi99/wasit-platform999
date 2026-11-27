import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { commissionPolicies } from '../src/db/schema/engine.js';
import { notifications } from '../src/db/schema/messaging.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  orderItems,
  orders,
  sellerOrders,
  sellerSettlements,
  transactionLedger,
  transactions,
} from '../src/db/schema/commerce.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { inventoryItems } from '../src/db/schema/commerce_extras.js';
import { products } from '../src/db/schema/products.js';
import { rfqEvents, rfqQuotes, rfqRecipients, rfqs } from '../src/db/schema/rfq.js';
import { RFQ_PARTICIPATION_CONSENT } from '../src/lib/consent-types.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * B2B-01 phase 4 — accepting one offer and turning it into a real order.
 *
 * Real HTTP against the real app, real Postgres, no mocks. The suite spends most
 * of its effort on the ways this could go wrong: two tabs accepting different
 * offers at the same time, a retried request, an old revision, a seller that was
 * deactivated between quoting and awarding, a catalogue that cannot fulfil the
 * agreed quantity, and a failure *after* the order rows were written (forced
 * with a trigger) which must leave no trace of either side of the trade.
 */

const app = createApp();

let ipCounter = 20;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function makeClient(ip = nextIp()) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, status: res.status, data: data as any, text };
    },
  };
}

type Client = ReturnType<typeof makeClient>;
type Role = 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY';

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Actor {
  client: Client;
  userId: string;
  email: string;
}

async function register(role: Role): Promise<Actor> {
  const client = makeClient();
  const email = `${unique('award')}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Award', lastName: role, role },
  });
  expect(reg.status, JSON.stringify(reg.data)).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await client.req('/api/auth/me');
  expect(me.status).toBe(200);
  return { client, userId: (me.data.data as { id: string }).id, email };
}

async function createEntity(actor: Actor, kind: 'suppliers' | 'merchants' | 'companies', name: string) {
  const body =
    kind === 'suppliers' ? { companyName: name } : kind === 'merchants' ? { storeName: name } : { legalName: name };
  const res = await actor.client.req(`/api/${kind}`, { method: 'POST', body });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.data.id as string;
}

async function grantConsent(actor: Actor): Promise<void> {
  const res = await actor.client.req('/api/privacy/consents', {
    method: 'PUT',
    body: { consentType: RFQ_PARTICIPATION_CONSENT, granted: true },
  });
  expect(res.status).toBe(200);
}

async function createProduct(
  seller: Actor,
  sellerId: string,
  opts: { price?: string; currency?: string; stock?: number; moq?: number; sellerType?: 'MERCHANT' | 'SUPPLIER' } = {},
): Promise<string> {
  const cats = await seller.client.req('/api/categories');
  expect(cats.status).toBe(200);
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const sku = unique('AW');
  const res = await seller.client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: opts.sellerType ?? 'MERCHANT',
      categoryId,
      name: `Award Item ${sku}`,
      sku,
      basePrice: opts.price ?? '10.0000',
      currencyCode: opts.currency ?? 'TND',
      moq: opts.moq ?? 1,
      initialQuantity: opts.stock ?? 100,
      lowStockThreshold: 2,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const productId = res.data.data.id as string;
  const publish = await seller.client.req(`/api/products/${productId}/status`, {
    method: 'PATCH',
    body: { status: 'ACTIVE' },
  });
  expect(publish.status).toBe(200);
  return productId;
}

async function createRfq(
  buyer: Client,
  items: Array<{ productId: string; quantity: string }>,
  overrides: Record<string, unknown> = {},
) {
  return buyer.req('/api/rfqs', {
    method: 'POST',
    body: {
      title: 'Award request',
      currencyCode: 'TND',
      items: items.map((item) => ({ ...item, unit: 'unit' })),
      ...overrides,
    },
  });
}

async function sendRfq(buyer: Client, rfqId: string, sellerIds: string[]) {
  return buyer.req(`/api/rfqs/${rfqId}/send`, {
    method: 'POST',
    body: { sellerIds, acknowledgeDisclosure: true },
  });
}

async function rfqItems(client: Client, rfqId: string): Promise<Array<{ id: string; quantity: string; productId: string }>> {
  const res = await client.req(`/api/rfqs/${rfqId}`);
  expect(res.status).toBe(200);
  return res.data.data.items as Array<{ id: string; quantity: string; productId: string }>;
}

async function submitQuote(client: Client, rfqId: string, unitPrices: string[]) {
  const items = await rfqItems(client, rfqId);
  const res = await client.req(`/api/rfqs/${rfqId}/quotes`, {
    method: 'POST',
    body: {
      currencyCode: 'TND',
      lines: items.map((item, index) => ({
        rfqItemId: item.id,
        unitPrice: unitPrices[index] ?? '1.0000',
        quantity: item.quantity,
      })),
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const data = res.data.data as { quoteId: string; revision: number; itemsTotal: string };
  return { id: data.quoteId, revision: data.revision, itemsTotal: data.itemsTotal };
}

/**
 * The endpoint takes no input, so it is called with the empty object the other
 * RFQ POSTs use; anything else is refused by the strict schema.
 */
function accept(client: Client, rfqId: string, quoteId: string, body: unknown = {}) {
  return client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/accept`, { method: 'POST', body });
}

async function financialSnapshot() {
  const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(orders);
  const [l] = await db.select({ n: sql<number>`count(*)::int` }).from(transactionLedger);
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(paymentIntents);
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(sellerSettlements);
  return { orders: o.n, ledger: l.n, payments: p.n, settlements: s.n };
}

interface Fixture {
  rfqId: string;
  quoteA: { id: string; revision: number; itemsTotal: string };
  quoteB: { id: string; revision: number; itemsTotal: string };
  productA: string;
  productB: string;
}

describe('B2B-01 phase 4 — accept an offer and create the order (real HTTP + real Postgres)', () => {
  let buyer: Actor;
  let companyId: string;
  let otherBuyer: Actor;
  let sellerA: Actor;
  let sellerAId: string;
  let sellerB: Actor;
  let sellerBId: string;

  beforeAll(async () => {
    buyer = await register('COMPANY');
    companyId = await createEntity(buyer, 'companies', `Awards Buyer ${unique('co')}`);
    otherBuyer = await register('COMPANY');
    await createEntity(otherBuyer, 'companies', `Other Buyer ${unique('co')}`);

    sellerA = await register('MERCHANT');
    sellerAId = await createEntity(sellerA, 'merchants', `Award Store A ${unique('s')}`);
    await grantConsent(sellerA);

    sellerB = await register('MERCHANT');
    sellerBId = await createEntity(sellerB, 'merchants', `Award Store B ${unique('s')}`);
    await grantConsent(sellerB);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await resetRateLimitStore();
  });

  /**
   * A two-line RFQ over one seller's catalogue, quoted by two sellers.
   *
   * Both requested lines reference products owned by `sellerA`, because an RFQ
   * line is a catalogue reference: only the owner of that product can be turned
   * into the order (a competing seller's cheaper offer is a valid *offer*, but
   * it has no product to bill — see the dedicated test below).
   */
  async function fixture(opts: { quantityA?: string; quantityB?: string } = {}): Promise<Fixture> {
    const productA = await createProduct(sellerA, sellerAId, { price: '10.0000', stock: 100 });
    const productB = await createProduct(sellerA, sellerAId, { price: '20.0000', stock: 100 });
    const created = await createRfq(buyer.client, [
      { productId: productA, quantity: opts.quantityA ?? '5.0000' },
      { productId: productB, quantity: opts.quantityB ?? '2.0000' },
    ]);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const rfqId = created.data.data.id as string;
    const sent = await sendRfq(buyer.client, rfqId, [sellerAId, sellerBId]);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    const quoteA = await submitQuote(sellerA.client, rfqId, ['8.0000', '15.0000']);
    const quoteB = await submitQuote(sellerB.client, rfqId, ['9.0000', '18.0000']);
    return { rfqId, quoteA, quoteB, productA, productB };
  }

  it('awards the chosen quote and creates one COMPANY order at the agreed price', async () => {
    const { rfqId, quoteA, productA, productB } = await fixture();
    const before = await financialSnapshot();

    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const data = res.data.data;
    expect(data.status).toBe('AWARDED');
    expect(data.replayed).toBe(false);
    expect(data.revision).toBe(1);
    expect(data.order.currencyCode).toBe('TND');

    const [order] = await db.select().from(orders).where(eq(orders.id, data.order.orderId));
    expect(order.buyerId).toBe(buyer.userId);
    expect(order.buyerType).toBe('COMPANY');
    expect(order.status).toBe('PENDING');
    // The order starts where a new order always starts: unpaid, never PAID.
    expect(order.paymentStatus).toBe('UNPAID');
    expect((order.metadata as any).buyer.companyId).toBe(companyId);
    expect((order.metadata as any).rfq).toEqual({
      id: rfqId,
      quoteId: quoteA.id,
      revision: 1,
      sellerId: sellerAId,
    });

    // Agreed prices (8 and 15), not the catalogue prices (10 and 20).
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, data.order.orderId));
    const byProduct = new Map(lines.map((l) => [l.productId, l]));
    expect(byProduct.get(productA)!.unitPrice).toBe('8.0000');
    expect(byProduct.get(productA)!.lineTotal).toBe('40.0000');
    expect(byProduct.get(productB)!.unitPrice).toBe('15.0000');
    expect(byProduct.get(productB)!.lineTotal).toBe('30.0000');
    expect(order.itemsTotal).toBe('70.0000');
    // Buyer pays items + their own commission share only.
    expect(Number(order.grandTotal)).toBeCloseTo(70 + Number(order.buyerCommission), 4);

    const after = await financialSnapshot();
    expect(after.orders).toBe(before.orders + 1);
    expect(after.payments).toBe(before.payments);
    expect(after.settlements).toBe(before.settlements);

    // Ledger rows exist but nothing is settled or held: WASIT is a broker.
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, data.order.transactionId));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((row) => row.status === 'PENDING')).toBe(true);
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, data.order.transactionId));
    expect(tx.status).toBe('PENDING');
    const [sub] = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, data.order.orderId));
    expect(sub.settlementStatus).toBe('PENDING');
  });

  it('closes the winning quote, rejects the others with a reason, and awards the RFQ', async () => {
    const { rfqId, quoteA, quoteB } = await fixture();
    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status).toBe(200);

    const [winner] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteA.id));
    expect(winner.quoteStatus).toBe('ACCEPTED');
    expect(winner.decidedByUserId).toBe(buyer.userId);
    expect(winner.decidedAt).not.toBeNull();

    const [loser] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteB.id));
    expect(loser.quoteStatus).toBe('REJECTED');
    expect(loser.decisionReason).toMatch(/another offer was accepted/i);
    expect(res.data.data.rejectedQuoteIds).toEqual([quoteB.id]);

    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('AWARDED');
    expect(rfq.awardedQuoteId).toBe(quoteA.id);
    expect(rfq.orderId).toBe(res.data.data.order.orderId);
    expect(rfq.awardedAt).not.toBeNull();

    const events = await db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId));
    const accepted = events.find((e) => e.eventType === 'QUOTE_ACCEPTED');
    expect(accepted).toBeTruthy();
    expect(accepted!.quoteId).toBe(quoteA.id);
    expect((accepted!.payload as any).orderId).toBe(res.data.data.order.orderId);
    const rejected = events.find((e) => e.eventType === 'QUOTE_REJECTED' && e.quoteId === quoteB.id);
    expect((rejected!.payload as any).reason).toBe('AWARDED_ELSEWHERE');

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'RFQ.QUOTE_ACCEPTED'), eq(auditLogs.entityId, rfqId)));
    expect(audit).toHaveLength(1);
    expect((audit[0].after as any).orderId).toBe(res.data.data.order.orderId);

    const notices = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.userId} in (${buyer.userId}, ${sellerA.userId}, ${sellerB.userId})`);
    const types = notices.map((n) => n.type);
    expect(types).toContain('RFQ_QUOTE_ACCEPTED');
    expect(types).toContain('RFQ_QUOTE_REJECTED');
    expect(types).toContain('RFQ_AWARDED');
  });

  it('takes the commission from the policy engine, not from code', async () => {
    const [policy] = await db.select().from(commissionPolicies).where(eq(commissionPolicies.isActive, true)).limit(1);
    expect(policy).toBeTruthy();
    const originalRate = policy.rate;

    const { rfqId, quoteA } = await fixture();
    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status).toBe(200);
    expect(res.data.data.order.policyId).toBeTruthy();
    // The rate is the policy's fraction, unchanged by any constant in the code.
    expect(res.data.data.order.commissionRate).toBe(String(Number(originalRate)));

    // Move the policy and award a second request: the new rate must apply.
    await db
      .update(commissionPolicies)
      .set({ rate: '0.100000', sellerRate: '0.050000', buyerRate: '0.050000' })
      .where(eq(commissionPolicies.id, policy.id));
    try {
      const second = await fixture();
      const res2 = await accept(buyer.client, second.rfqId, second.quoteA.id);
      expect(res2.status, JSON.stringify(res2.data)).toBe(200);
      expect(res2.data.data.order.commissionRate).toBe('0.1');
      expect(res2.data.data.order.commissionBuyer).toBe('3.5000'); // 10% of 70.00 / 2
    } finally {
      await db
        .update(commissionPolicies)
        .set({ rate: originalRate, sellerRate: policy.sellerRate, buyerRate: policy.buyerRate })
        .where(eq(commissionPolicies.id, policy.id));
    }
  });

  it('replays the same award instead of creating a second order', async () => {
    const { rfqId, quoteA } = await fixture();
    const first = await accept(buyer.client, rfqId, quoteA.id);
    expect(first.status).toBe(200);
    const before = await financialSnapshot();

    const second = await accept(buyer.client, rfqId, quoteA.id);
    expect(second.status, JSON.stringify(second.data)).toBe(200);
    expect(second.data.data.replayed).toBe(true);
    expect(second.data.data.order.orderId).toBe(first.data.data.order.orderId);
    expect(second.data.data.order.grandTotal).toBe(first.data.data.order.grandTotal);
    expect((await financialSnapshot()).orders).toBe(before.orders);
  });

  it('refuses a second, different quote once the request is awarded', async () => {
    const { rfqId, quoteA, quoteB } = await fixture();
    expect((await accept(buyer.client, rfqId, quoteA.id)).status).toBe(200);
    const before = await financialSnapshot();

    const late = await accept(buyer.client, rfqId, quoteB.id);
    expect(late.status).toBe(409);
    expect((await financialSnapshot()).orders).toBe(before.orders);
    const [loser] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteB.id));
    expect(loser.quoteStatus).toBe('REJECTED');
  });

  it('lets exactly one of two simultaneous acceptances win', async () => {
    const { rfqId, quoteA, quoteB } = await fixture();
    const before = await financialSnapshot();

    const [left, right] = await Promise.all([
      accept(buyer.client, rfqId, quoteA.id),
      accept(buyer.client, rfqId, quoteB.id),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((await financialSnapshot()).orders).toBe(before.orders + 1);

    const acceptedRows = await db
      .select({ id: rfqQuotes.id })
      .from(rfqQuotes)
      .where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.quoteStatus, 'ACCEPTED')));
    expect(acceptedRows).toHaveLength(1);
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('AWARDED');
    const acceptedEvents = await db
      .select()
      .from(rfqEvents)
      .where(and(eq(rfqEvents.rfqId, rfqId), eq(rfqEvents.eventType, 'QUOTE_ACCEPTED')));
    expect(acceptedEvents).toHaveLength(1);
  });

  it('survives five simultaneous acceptances of the same quote with one order', async () => {
    const { rfqId, quoteA } = await fixture();
    const before = await financialSnapshot();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accept(buyer.client, rfqId, quoteA.id)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.data.data.order.orderId)).size).toBe(1);
    expect((await financialSnapshot()).orders).toBe(before.orders + 1);
  });

  it('refuses an older revision once the seller has replaced it', async () => {
    const { rfqId, quoteA } = await fixture();
    const rev2 = await submitQuote(sellerA.client, rfqId, ['7.0000', '14.0000']);
    expect(rev2.revision).toBe(2);

    const stale = await accept(buyer.client, rfqId, quoteA.id);
    expect(stale.status).toBe(409);
    // Revision 1 was superseded the moment revision 2 arrived.
    expect(stale.data.error.message).toMatch(/superseded|revision 2/i);

    const current = await accept(buyer.client, rfqId, rev2.id);
    expect(current.status, JSON.stringify(current.data)).toBe(200);
    expect(current.data.data.revision).toBe(2);
  });

  it('refuses a withdrawn quote and a rejected quote', async () => {
    const { rfqId, quoteA, quoteB } = await fixture();
    const withdrawn = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${quoteA.id}/withdraw`, {
      method: 'POST',
      body: { reason: 'Stock reallocated' },
    });
    expect(withdrawn.status).toBe(200);
    expect((await accept(buyer.client, rfqId, quoteA.id)).status).toBe(409);

    const rejected = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteB.id}/reject`, {
      method: 'POST',
      body: { reason: 'Too expensive for us' },
    });
    expect(rejected.status).toBe(200);
    expect((await accept(buyer.client, rfqId, quoteB.id)).status).toBe(409);
  });

  it('refuses a quote whose validity has lapsed', async () => {
    const { rfqId, quoteA } = await fixture();
    // `valid_until` is frozen after submission, so the clock is moved the way
    // the phase-2 suite moves it: disable the guard for the one statement.
    await db.execute(sql`alter table rfq_quotes disable trigger rfq_quotes_frozen_terms`);
    try {
      await db
        .update(rfqQuotes)
        .set({ validUntil: new Date(Date.now() - 60_000) })
        .where(eq(rfqQuotes.id, quoteA.id));
    } finally {
      await db.execute(sql`alter table rfq_quotes enable trigger rfq_quotes_frozen_terms`);
    }
    const before = await financialSnapshot();
    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status).toBe(409);
    expect((await financialSnapshot()).orders).toBe(before.orders);
  });

  it('refuses to award a lapsed or cancelled request', async () => {
    const lapsed = await fixture();
    await db.update(rfqs).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(rfqs.id, lapsed.rfqId));
    const before = await financialSnapshot();
    expect((await accept(buyer.client, lapsed.rfqId, lapsed.quoteA.id)).status).toBe(409);
    expect((await financialSnapshot()).orders).toBe(before.orders);

    const cancelled = await fixture();
    expect((await buyer.client.req(`/api/rfqs/${cancelled.rfqId}/cancel`, { method: 'POST', body: {} })).status).toBe(200);
    expect((await accept(buyer.client, cancelled.rfqId, cancelled.quoteA.id)).status).toBe(409);
    expect((await financialSnapshot()).orders).toBe(before.orders);
  });

  it('hides the request from other companies and refuses sellers', async () => {
    const { rfqId, quoteA } = await fixture();
    const outsider = await accept(otherBuyer.client, rfqId, quoteA.id);
    expect(outsider.status).toBe(404);
    const seller = await accept(sellerA.client, rfqId, quoteA.id);
    expect(seller.status).toBe(403);
    const anonymous = await app.request(`/api/rfqs/${rfqId}/quotes/${quoteA.id}/accept`, { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('OPEN');
    expect(rfq.orderId).toBeNull();
  });

  it('refuses a body that tries to supply identity, price, commission or a key', async () => {
    const { rfqId, quoteA } = await fixture();
    const before = await financialSnapshot();
    for (const body of [
      { buyerCompanyId: 'forged-company' },
      { supplierId: sellerBId },
      { unitPrice: '0.0100' },
      { commissionRate: '0' },
      { idempotencyKey: 'chosen-by-client' },
      { buyerType: 'CUSTOMER' },
    ]) {
      const res = await accept(buyer.client, rfqId, quoteA.id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect((await financialSnapshot()).orders).toBe(before.orders);
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('OPEN');
  });

  it('refuses a request line that is not linked to a catalogue product', async () => {
    // A free-text line is legitimate in a request, but it cannot become an order.
    const textRfq = await createRfq(buyer.client, [], {
      items: [{ freeTextName: 'Custom packaging', quantity: '10.0000', unit: 'box' }],
    });
    const textId = textRfq.data.data.id as string;
    expect((await sendRfq(buyer.client, textId, [sellerAId])).status).toBe(200);
    const quote = await submitQuote(sellerA.client, textId, ['3.0000']);
    const before = await financialSnapshot();
    const res = await accept(buyer.client, textId, quote.id);
    expect(res.status).toBe(409);
    expect(res.data.error.message).toMatch(/catalogue product/i);
    expect((await financialSnapshot()).orders).toBe(before.orders);
  });

  it('refuses a supplier that was deactivated after quoting', async () => {
    const { rfqId, quoteA } = await fixture();
    await db.execute(sql`update merchants set is_active = false where id = ${sellerAId}`);
    try {
      const before = await financialSnapshot();
      const res = await accept(buyer.client, rfqId, quoteA.id);
      expect(res.status).toBe(409);
      expect(res.data.error.message).toMatch(/supplier is no longer active/i);
      expect((await financialSnapshot()).orders).toBe(before.orders);
    } finally {
      await db.execute(sql`update merchants set is_active = true where id = ${sellerAId}`);
    }
  });

  it('leaves no trace when the catalogue cannot fulfil the agreed quantity', async () => {
    // The request asks for 10 units while the product only holds 3.
    const { rfqId, quoteA } = await fixture({ quantityA: '10.0000' });
    const [product] = await db.select().from(products).where(eq(products.id, (await rfqItems(buyer.client, rfqId))[0].productId));
    await db.update(inventoryItems).set({ quantity: 3, reservedQuantity: 0 }).where(eq(inventoryItems.productId, product.id));

    const before = await financialSnapshot();
    const eventsBefore = await db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId));
    const noticesBefore = await db.select().from(notifications).where(eq(notifications.userId, sellerA.userId));

    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect([409, 422, 500]).toContain(res.status);
    expect((await financialSnapshot()).orders).toBe(before.orders);

    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('OPEN');
    expect(rfq.awardedQuoteId).toBeNull();
    const [quote] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteA.id));
    expect(quote.quoteStatus).toBe('SUBMITTED');
    expect(await db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId))).toHaveLength(eventsBefore.length);
    expect(await db.select().from(notifications).where(eq(notifications.userId, sellerA.userId))).toHaveLength(
      noticesBefore.length,
    );
  });

  it('rolls the order back when the award cannot be recorded', async () => {
    const { rfqId, quoteA } = await fixture();
    // Force a failure *after* the order rows are written, so the only thing that
    // can save the database from a paid-for order with no award is the shared
    // transaction boundary.
    await db.execute(sql`
      create or replace function tmp_award_boom() returns trigger as $$
      begin raise exception 'award blocked by test'; end;
      $$ language plpgsql
    `);
    await db.execute(sql`
      create trigger tmp_award_boom before update of status on rfqs
      for each row when (new.status = 'AWARDED') execute function tmp_award_boom()
    `);
    try {
      const before = await financialSnapshot();
      const res = await accept(buyer.client, rfqId, quoteA.id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await financialSnapshot()).orders).toBe(before.orders);

      const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
      expect(rfq.status).toBe('OPEN');
      expect(rfq.orderId).toBeNull();
      const [quote] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteA.id));
      expect(quote.quoteStatus).toBe('SUBMITTED');
      const acceptedEvents = await db
        .select()
        .from(rfqEvents)
        .where(and(eq(rfqEvents.rfqId, rfqId), eq(rfqEvents.eventType, 'QUOTE_ACCEPTED')));
      expect(acceptedEvents).toHaveLength(0);
      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'RFQ.QUOTE_ACCEPTED'), eq(auditLogs.entityId, rfqId)));
      expect(audits).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger if exists tmp_award_boom on rfqs`);
      await db.execute(sql`drop function if exists tmp_award_boom()`);
    }

    // With the trigger gone the same award succeeds — the request was not poisoned.
    const retry = await accept(buyer.client, rfqId, quoteA.id);
    expect(retry.status, JSON.stringify(retry.data)).toBe(200);
  });

  it('refuses a request line that points at a product the seller does not own', async () => {
    const { rfqId, quoteA } = await fixture();
    const foreign = await createProduct(sellerB, sellerBId, { price: '3.0000', stock: 50 });
    const items = await rfqItems(buyer.client, rfqId);
    await db.execute(sql`update rfq_items set product_id = ${foreign} where id = ${items[0].id}`);
    const before = await financialSnapshot();
    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status).toBe(409);
    expect(res.data.error.message).toMatch(/another seller/i);
    expect((await financialSnapshot()).orders).toBe(before.orders);
  });

  it('will not award a competing seller whose catalogue backs no requested line', async () => {
    const { rfqId, quoteB } = await fixture();
    const before = await financialSnapshot();
    // A cheaper offer is a valid offer, but the request lines reference the other
    // seller's products, so there is nothing to bill for this seller.
    const res = await accept(buyer.client, rfqId, quoteB.id);
    expect(res.status).toBe(409);
    expect(res.data.error.message).toMatch(/another seller/i);
    expect((await financialSnapshot()).orders).toBe(before.orders);
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfq.status).toBe('OPEN');
  });

  it('cannot be handed negotiated prices through the plain orders endpoint', async () => {
    const product = await createProduct(sellerA, sellerAId, { price: '10.0000', stock: 20 });
    // `negotiated` is internal to the RFQ path; the order schema strips it, so a
    // buyer cannot price their own order. Proven against the real endpoint.
    const res = await buyer.client.req('/api/orders', {
      method: 'POST',
      body: {
        buyerId: buyer.userId,
        buyerType: 'COMPANY',
        companyId,
        items: [{ productId: product, quantity: 1 }],
        negotiated: {
          rfqId: 'x',
          quoteId: 'y',
          revision: 1,
          sellerId: sellerAId,
          unitPrices: { [product]: '0.0100' },
        },
      },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, res.data.data.orderId));
    expect(line.unitPrice).toBe('10.0000');
  });

  it('keeps the RFQ and the order linked both ways', async () => {
    const { rfqId, quoteA } = await fixture();
    const res = await accept(buyer.client, rfqId, quoteA.id);
    expect(res.status).toBe(200);
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    const [order] = await db.select().from(orders).where(eq(orders.id, rfq.orderId!));
    expect(order.id).toBe(res.data.data.order.orderId);
    expect((order.metadata as any).rfq.id).toBe(rfqId);
    expect((order.metadata as any).rfq.quoteId).toBe(quoteA.id);

    // The comparison endpoint now reports the closed negotiation, not a live one.
    const cmp = await buyer.client.req(`/api/rfqs/${rfqId}/comparison`);
    expect(cmp.status).toBe(200);
    expect(cmp.data.data.rfq.status).toBe('AWARDED');
    expect(cmp.data.data.rows).toHaveLength(0);
  });
});
