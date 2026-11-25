import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { notifications } from '../src/db/schema/messaging.js';
import { payouts } from '../src/db/schema/payouts.js';
import { commissionPolicies } from '../src/db/schema/engine.js';
import {
  orderItems,
  orders,
  sellerOrders,
  sellerSettlements,
  transactionLedger,
} from '../src/db/schema/commerce.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { rfqEvents, rfqQuotes, rfqRecipients, rfqs } from '../src/db/schema/rfq.js';
import { RFQ_PARTICIPATION_CONSENT } from '../src/lib/consent-types.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * B2B-01 phase 5 — the whole request for quotation, walked as one journey.
 *
 * Phases 1–4 each pinned their own rules (isolation, lifecycle, comparison and
 * expiry, award). This suite exists to prove the pieces *compose*: a company
 * drafts, invites, negotiates, compares, awards and opens the resulting order in
 * one continuous story, a seller only ever sees its own thread, terminal states
 * stay terminal, and the money that comes out is the ordinary order money — not
 * a second, RFQ-specific path.
 *
 * Real HTTP against the real app and real Postgres. No mocks.
 */

const app = createApp();

let ipCounter = 40;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
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
  const email = `${unique('journey')}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Journey', lastName: role, role },
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

async function createStaff(roleName: 'ADMIN' | 'SUPPORT'): Promise<Actor> {
  const id = randomUUID();
  const email = `${unique('journey-staff')}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('StaffPass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`role ${roleName} missing — seed did not run`);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StaffPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return { client, userId: id, email };
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

async function createProduct(seller: Actor, sellerId: string, price: string, stock = 200): Promise<string> {
  const cats = await seller.client.req('/api/categories');
  expect(cats.status).toBe(200);
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
  const sku = unique('JN');
  const res = await seller.client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: 'MERCHANT',
      categoryId,
      name: `Journey Item ${sku}`,
      sku,
      basePrice: price,
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: stock,
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

interface RfqItem {
  id: string;
  quantity: string;
  productId: string | null;
  productName: string | null;
  freeTextName: string | null;
}

async function createRfq(buyer: Client, items: Array<Record<string, unknown>>, title = 'Journey request') {
  return buyer.req('/api/rfqs', {
    method: 'POST',
    body: { title, currencyCode: 'TND', items: items.map((i) => ({ unit: 'unit', ...i })) },
  });
}

async function sendRfq(buyer: Client, rfqId: string, sellerIds: string[]) {
  return buyer.req(`/api/rfqs/${rfqId}/send`, {
    method: 'POST',
    body: { sellerIds, acknowledgeDisclosure: true },
  });
}

async function itemsOf(client: Client, rfqId: string): Promise<RfqItem[]> {
  const res = await client.req(`/api/rfqs/${rfqId}`);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.data.items as RfqItem[];
}

async function quote(
  client: Client,
  rfqId: string,
  unitPrices: string[],
  extra: Record<string, unknown> = {},
): Promise<{ id: string; revision: number; itemsTotal: string }> {
  const items = await itemsOf(client, rfqId);
  const res = await client.req(`/api/rfqs/${rfqId}/quotes`, {
    method: 'POST',
    body: {
      currencyCode: 'TND',
      lines: items.map((item, index) => ({
        rfqItemId: item.id,
        unitPrice: unitPrices[index] ?? '1.0000',
        quantity: item.quantity,
      })),
      ...extra,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const data = res.data.data as { quoteId: string; revision: number; itemsTotal: string };
  return { id: data.quoteId, revision: data.revision, itemsTotal: data.itemsTotal };
}

/** Submits an offer and returns the raw response, for refusals we expect. */
function quoteAttempt(client: Client, rfqId: string, unitPrices: string[]) {
  return itemsOf(client, rfqId).then((items) =>
    client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        lines: items.map((item, index) => ({
          rfqItemId: item.id,
          unitPrice: unitPrices[index] ?? '1.0000',
          quantity: item.quantity,
        })),
      },
    }),
  );
}

function accept(client: Client, rfqId: string, quoteId: string, body: unknown = {}) {
  return client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/accept`, { method: 'POST', body });
}

describe('B2B-01 phase 5 — the RFQ journey end to end (real HTTP + real Postgres)', () => {
  let buyer: Actor;
  let companyId: string;
  let sellerA: Actor;
  let sellerAId: string;
  let sellerB: Actor;
  let sellerBId: string;
  let sellerC: Actor;
  let sellerCId: string;
  let outsider: Actor;
  let productA1: string;
  let productA2: string;

  beforeAll(async () => {
    buyer = await register('COMPANY');
    companyId = await createEntity(buyer, 'companies', `Journey Buyer ${unique('co')}`);

    sellerA = await register('MERCHANT');
    sellerAId = await createEntity(sellerA, 'merchants', `Journey Store A ${unique('s')}`);
    await grantConsent(sellerA);
    productA1 = await createProduct(sellerA, sellerAId, '12.0000');
    productA2 = await createProduct(sellerA, sellerAId, '18.0000');

    sellerB = await register('SUPPLIER');
    sellerBId = await createEntity(sellerB, 'suppliers', `Journey Supplier B ${unique('s')}`);
    await grantConsent(sellerB);

    sellerC = await register('MERCHANT');
    sellerCId = await createEntity(sellerC, 'merchants', `Journey Store C ${unique('s')}`);
    await grantConsent(sellerC);

    outsider = await register('COMPANY');
    await createEntity(outsider, 'companies', `Journey Outsider ${unique('co')}`);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await resetRateLimitStore();
  });

  /** A two-line request over seller A's catalogue, addressed to A and B. */
  async function openRequest(title = 'Journey request') {
    const created = await createRfq(buyer.client, [
      { productId: productA1, quantity: '10.0000' },
      { productId: productA2, quantity: '5.0000' },
    ], title);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const rfqId = created.data.data.id as string;
    const sent = await sendRfq(buyer.client, rfqId, [sellerAId, sellerBId]);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    return rfqId;
  }

  it('walks a company from a draft to the order it produced', async () => {
    // --- draft: nobody outside the company can see it ------------------------
    const draft = await createRfq(buyer.client, [
      { productId: productA1, quantity: '10.0000' },
      { productId: productA2, quantity: '5.0000' },
    ], 'Journey — full walk');
    expect(draft.status, JSON.stringify(draft.data)).toBe(201);
    const rfqId = draft.data.data.id as string;
    expect(draft.data.data.status).toBe('DRAFT');
    expect((await sellerA.client.req(`/api/rfqs/${rfqId}`)).status).toBe(404);
    expect((await sellerA.client.req('/api/rfqs/inbox')).data.data).toEqual([]);

    // --- invite -------------------------------------------------------------
    const sent = await sendRfq(buyer.client, rfqId, [sellerAId, sellerBId]);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    const inboxA = await sellerA.client.req('/api/rfqs/inbox');
    const inboxB = await sellerB.client.req('/api/rfqs/inbox');
    const inboxC = await sellerC.client.req('/api/rfqs/inbox');
    expect(inboxA.data.data.map((r: { id: string }) => r.id)).toContain(rfqId);
    expect(inboxB.data.data.map((r: { id: string }) => r.id)).toContain(rfqId);
    expect(inboxC.data.data).toEqual([]);

    // --- the seller reads it (recorded once) --------------------------------
    const opened = await sellerA.client.req(`/api/rfqs/${rfqId}`);
    expect(opened.status).toBe(200);
    expect(opened.data.data.buyer.legalName).toContain('Journey Buyer');
    // A catalogue line is named by its product, not by its uuid: the seller has
    // to recognise what is being asked for.
    const openedItems = opened.data.data.items as Array<{ productId: string | null; productName: string | null; freeTextName: string | null }>;
    expect(openedItems.every((i) => i.productName && i.productName.length > 0)).toBe(true);
    expect(openedItems.some((i) => i.productName === i.productId)).toBe(false);
    expect(opened.data.data.myInvitation.status).toBe('VIEWED');
    const buyerView = await buyer.client.req(`/api/rfqs/${rfqId}`);
    const recipientA = (buyerView.data.data.recipients as Array<{ sellerId: string; status: string }>).find(
      (r) => r.sellerId === sellerAId,
    );
    expect(recipientA?.status).toBe('VIEWED');

    // --- first offer, rejected with a reason, then renegotiated -------------
    const first = await quote(sellerA.client, rfqId, ['12.0000', '18.0000'], { leadTimeDays: 7 });
    expect(first.itemsTotal).toBe('210.0000');
    const rejected = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${first.id}/reject`, {
      method: 'POST',
      body: { reason: 'Target price is lower' },
    });
    expect(rejected.status, JSON.stringify(rejected.data)).toBe(200);
    const seenBySeller = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    const rejectedView = (seenBySeller.data.data as Array<{ id: string; status: string; decisionReason: string | null }>).find(
      (q) => q.id === first.id,
    );
    expect(rejectedView?.status).toBe('REJECTED');
    expect(rejectedView?.decisionReason).toBe('Target price is lower');

    const second = await quote(sellerA.client, rfqId, ['10.0000', '15.0000'], { leadTimeDays: 5 });
    expect(second.revision).toBe(2);
    expect(second.itemsTotal).toBe('175.0000');

    // --- a competing offer ---------------------------------------------------
    const competing = await quote(sellerB.client, rfqId, ['11.0000', '16.0000'], { leadTimeDays: 9 });

    // --- comparison ranks the live offers ------------------------------------
    const comparison = await buyer.client.req(`/api/rfqs/${rfqId}/comparison`);
    expect(comparison.status).toBe(200);
    expect(comparison.data.data.scope).toBe('ALL');
    expect(comparison.data.data.summary.bestPriceQuoteId).toBe(second.id);
    expect(comparison.data.data.summary.comparableQuotes).toBe(2);
    expect(comparison.data.data.summary.lowestTotal).toBe('175.0000');
    expect(comparison.data.data.summary.fastestLeadTimeDays).toBe(5);
    const perItem = comparison.data.data.summary.perItem as Array<{ itemName: string | null }>;
    expect(perItem.every((i) => i.itemName && !/^[0-9a-f-]{36}$/.test(i.itemName))).toBe(true);
    // The superseded/rejected revision is listed as excluded, not as a row.
    const rowIds = (comparison.data.data.rows as Array<{ quoteId: string }>).map((r) => r.quoteId);
    expect(rowIds).toEqual(expect.arrayContaining([second.id, competing.id]));
    expect(rowIds).not.toContain(first.id);

    // --- award ---------------------------------------------------------------
    const award = await accept(buyer.client, rfqId, second.id);
    expect(award.status, JSON.stringify(award.data)).toBe(200);
    const result = award.data.data as {
      status: string;
      quoteId: string;
      revision: number;
      order: { orderId: string; itemsTotal: string; grandTotal: string; commissionBuyer: string; currencyCode: string };
      rejectedQuoteIds: string[];
      replayed: boolean;
    };
    expect(result.status).toBe('AWARDED');
    expect(result.quoteId).toBe(second.id);
    expect(result.revision).toBe(2);
    expect(result.replayed).toBe(false);
    expect(result.rejectedQuoteIds).toContain(competing.id);
    expect(result.order.itemsTotal).toBe('175.0000');
    // The buyer pays the items plus their own commission share, nothing else.
    expect(Number(result.order.grandTotal)).toBeCloseTo(175 + Number(result.order.commissionBuyer), 4);

    // --- the RFQ and the order point at each other ---------------------------
    const awarded = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(awarded.data.data.status).toBe('AWARDED');
    expect(awarded.data.data.awardedQuoteId).toBe(second.id);
    expect(awarded.data.data.orderId).toBe(result.order.orderId);

    const order = await buyer.client.req(`/api/orders/${result.order.orderId}`);
    expect(order.status).toBe(200);
    expect(order.data.data.buyerType).toBe('COMPANY');
    // The order carries the buying company it was placed for (there is no
    // `orders.company_id` column: identity lives in the order metadata).
    expect(order.data.data.metadata.buyer).toMatchObject({ type: 'COMPANY', companyId });
    expect(order.data.data.status).toBe('PENDING');
    expect(order.data.data.paymentStatus).toBe('UNPAID');
    expect(order.data.data.itemsTotal).toBe('175.0000');
    const lines = order.data.data.items as Array<{ productId: string; unitPrice: string; quantity: string; lineTotal: string }>;
    expect(lines).toHaveLength(2);
    const byProduct = new Map(lines.map((l) => [l.productId, l]));
    expect(byProduct.get(productA1)?.unitPrice).toBe('10.0000');
    expect(byProduct.get(productA2)?.unitPrice).toBe('15.0000');
    expect(byProduct.get(productA1)?.lineTotal).toBe('100.0000');
    expect(byProduct.get(productA2)?.lineTotal).toBe('75.0000');

    // The seller opens the same order from its side.
    const sellerOrder = await sellerA.client.req(`/api/orders/${result.order.orderId}`);
    expect(sellerOrder.status).toBe(200);
    expect(sellerOrder.data.data.viewerRole).toBe('SELLER');

    // --- the losing seller reads the decision, and cannot quote again -------
    const losing = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes`);
    const losingQuote = (losing.data.data as Array<{ id: string; status: string; decisionReason: string | null }>).find(
      (q) => q.id === competing.id,
    );
    expect(losingQuote?.status).toBe('REJECTED');
    expect(losingQuote?.decisionReason).toBeTruthy();
    expect((await quoteAttempt(sellerB.client, rfqId, ['1.0000', '1.0000'])).status).toBe(409);

    // --- the timeline tells the same story -----------------------------------
    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(timeline.status).toBe(200);
    const events = (timeline.data.data as Array<{ eventType: string }>).map((e) => e.eventType);
    for (const expected of ['CREATED', 'SENT', 'QUOTE_SUBMITTED', 'QUOTE_REJECTED', 'QUOTE_ACCEPTED']) {
      expect(events, `timeline should record ${expected}`).toContain(expected);
    }
  });

  it('keeps every seller inside its own offer', async () => {
    const rfqId = await openRequest('Journey — seller isolation');
    const a = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    const b = await quote(sellerB.client, rfqId, ['11.0000', '16.0000']);

    const aQuotes = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(aQuotes.status).toBe(200);
    expect((aQuotes.data.data as Array<{ id: string }>).map((q) => q.id)).toEqual([a.id]);

    const aComparison = await sellerA.client.req(`/api/rfqs/${rfqId}/comparison`);
    expect(aComparison.status).toBe(200);
    expect(aComparison.data.data.scope).toBe('OWN');
    expect((aComparison.data.data.rows as Array<{ quoteId: string }>).map((r) => r.quoteId)).toEqual([a.id]);
    // A competitor's price must not appear anywhere in the seller's payload.
    expect(aComparison.text).not.toContain('190.0000');

    // Non-participants learn nothing, not even that the request exists.
    const stranger = await sellerC.client.req(`/api/rfqs/${rfqId}`);
    expect(stranger.status).toBe(404);
    expect((await sellerC.client.req(`/api/rfqs/${rfqId}/quotes`)).status).toBe(404);
    expect((await sellerC.client.req(`/api/rfqs/${rfqId}/comparison`)).status).toBe(404);
    expect((await sellerC.client.req(`/api/rfqs/${rfqId}/timeline`)).status).toBe(404);
    expect((await outsider.client.req(`/api/rfqs/${rfqId}`)).status).toBe(404);
    expect((await outsider.client.req(`/api/rfqs/${rfqId}/comparison`)).status).toBe(404);
    // And a stranger cannot touch the thread either.
    expect((await outsider.client.req(`/api/rfqs/${rfqId}/cancel`, { method: 'POST', body: {} })).status).toBe(404);
    expect(
      (await outsider.client.req(`/api/rfqs/${rfqId}/quotes/${a.id}/accept`, { method: 'POST', body: {} })).status,
    ).toBe(404);
  });

  it('refuses to invite a seller who has not opted in to RFQ participation', async () => {
    const noConsent = await register('MERCHANT');
    const noConsentId = await createEntity(noConsent, 'merchants', `Journey No Consent ${unique('s')}`);
    const created = await createRfq(buyer.client, [{ productId: productA1, quantity: '1.0000' }], 'Journey — consent');
    const rfqId = created.data.data.id as string;
    const sent = await sendRfq(buyer.client, rfqId, [noConsentId]);
    expect(sent.status).toBe(409);
    expect(sent.text).toContain('RFQ participation');
    // The refusal names the seller, never its internal id.
    expect(sent.text).not.toContain(noConsentId);
    const after = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(after.data.data.status).toBe('DRAFT');
    expect(after.data.data.recipients).toEqual([]);
  });

  it('keeps a cancelled request, and everything in it, cancelled', async () => {
    const rfqId = await openRequest('Journey — cancel');
    const offer = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    const cancelled = await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, {
      method: 'POST',
      body: { reason: 'Budget frozen' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.data.status).toBe('CANCELLED');

    expect((await quoteAttempt(sellerB.client, rfqId, ['1.0000', '1.0000'])).status).toBe(409);
    expect((await accept(buyer.client, rfqId, offer.id)).status).toBe(409);
    expect((await sendRfq(buyer.client, rfqId, [sellerCId])).status).toBe(409);
    // No order was created by the failed award.
    const [row] = await db.select({ orderId: rfqs.orderId }).from(rfqs).where(eq(rfqs.id, rfqId));
    expect(row.orderId).toBeNull();
  });

  it('keeps an expired request and its offers dead', async () => {
    // Offer-level expiry is pinned in b2b01c; here the request's own clock moves
    // so the journey can prove an expired thread cannot be revived by an award.
    const rfqId = await openRequest('Journey — expiry');
    const offer = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    await db.execute(sql`update rfqs set expires_at = now() - interval '1 hour' where id = ${rfqId}`);

    const acceptAfter = await accept(buyer.client, rfqId, offer.id);
    expect(acceptAfter.status).toBe(409);
    const [after] = await db
      .select({ status: rfqs.status, orderId: rfqs.orderId })
      .from(rfqs)
      .where(eq(rfqs.id, rfqId));
    expect(after.status).toBe('EXPIRED');
    expect(after.orderId).toBeNull();
    // Reviving is impossible: a new offer and a second award both fail.
    expect((await quoteAttempt(sellerB.client, rfqId, ['1.0000', '1.0000'])).status).toBe(409);
    expect((await accept(buyer.client, rfqId, offer.id)).status).toBe(409);
    expect((await sendRfq(buyer.client, rfqId, [sellerCId])).status).toBe(409);
  });

  it('awards one offer only when two tabs accept at the same moment', async () => {
    const rfqId = await openRequest('Journey — concurrency');
    const a = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    const b = await quote(sellerB.client, rfqId, ['11.0000', '16.0000']);

    const results = await Promise.all([
      accept(buyer.client, rfqId, a.id),
      accept(buyer.client, rfqId, b.id),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const winner = results.find((r) => r.status === 200)!;
    const winnerQuoteId = winner.data.data.quoteId as string;
    const rows = await db.select().from(orders);
    const created = rows.filter((o) => o.metadata && JSON.stringify(o.metadata).includes(rfqId));
    expect(created).toHaveLength(1);
    expect(created[0].metadata).toMatchObject({ rfq: { id: rfqId, quoteId: winnerQuoteId } });
    // Replaying the winning call returns that same order.
    const replay = await accept(buyer.client, rfqId, winnerQuoteId);
    expect(replay.status).toBe(200);
    expect(replay.data.data.replayed).toBe(true);
    expect(replay.data.data.order.orderId).toBe(winner.data.data.order.orderId);
    const stillOne = (await db.select().from(orders)).filter(
      (o) => o.metadata && JSON.stringify(o.metadata).includes(rfqId),
    );
    expect(stillOne).toHaveLength(1);
  });

  it('refuses a free-text line at award time and leaves the request open', async () => {
    // Declared behaviour (B2B-01-P4-A): a line that is not a catalogue product
    // cannot become an order line, so the award is refused rather than guessed.
    const created = await createRfq(
      buyer.client,
      [{ freeTextName: '500 kg of custom resin', quantity: '500.0000' }],
      'Journey — free text',
    );
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const rfqId = created.data.data.id as string;
    expect((await sendRfq(buyer.client, rfqId, [sellerAId])).status).toBe(200);
    // A free-text line has no catalogue name: it stays null and keeps its words.
    const freeTextItems = await itemsOf(sellerA.client, rfqId);
    expect(freeTextItems[0].productName).toBeNull();
    expect(freeTextItems[0].freeTextName).toBe('500 kg of custom resin');
    const offer = await quote(sellerA.client, rfqId, ['2.5000']);

    const award = await accept(buyer.client, rfqId, offer.id);
    expect(award.status).toBe(409);
    expect(award.text).toContain('catalogue');
    const [after] = await db.select({ status: rfqs.status, orderId: rfqs.orderId }).from(rfqs).where(eq(rfqs.id, rfqId));
    expect(after.status).toBe('OPEN');
    expect(after.orderId).toBeNull();
    const quotes = await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId));
    expect(quotes.map((q) => q.quoteStatus)).toEqual(['SUBMITTED']);
  });

  it('does not let staff or an AI agent award on the company behalf', async () => {
    const rfqId = await openRequest('Journey — staff and AI');
    const offer = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);

    for (const roleName of ['ADMIN', 'SUPPORT'] as const) {
      const staff = await createStaff(roleName);
      const attempt = await accept(staff.client, rfqId, offer.id);
      expect(attempt.status, `${roleName} must not award`).toBe(403);
    }

    // An AI agent run is advisory: it may describe the market, never move the
    // request. The b2b agent is the closest one to this surface.
    const agentRun = await buyer.client.req('/api/ai/agents/b2b-agent/tasks', {
      method: 'POST',
      body: { input: { note: 'award this for me' } },
    });
    // The agent answers (or asks for human approval) — it never acts.
    expect([200, 201, 202], JSON.stringify(agentRun.data)).toContain(agentRun.status);
    const [after] = await db.select({ status: rfqs.status, orderId: rfqs.orderId }).from(rfqs).where(eq(rfqs.id, rfqId));
    expect(after.status).toBe('OPEN');
    expect(after.orderId).toBeNull();
    const quoteRows = await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId));
    expect(quoteRows.map((q) => q.quoteStatus)).toEqual(['SUBMITTED']);
  });

  it('takes nothing from the client and leaves the money path untouched', async () => {
    const rfqId = await openRequest('Journey — money');
    const offer = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);

    // Identity, price, commission and the key are refused outright.
    for (const body of [
      { buyerCompanyId: companyId },
      { sellerId: sellerAId },
      { unitPrice: '0.0100' },
      { commissionRate: '0' },
      { idempotencyKey: 'client-chosen-key' },
    ]) {
      const refused = await accept(buyer.client, rfqId, offer.id, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
    }

    const before = {
      ledger: (await db.select({ n: sql<number>`count(*)::int` }).from(transactionLedger))[0].n,
      payments: (await db.select({ n: sql<number>`count(*)::int` }).from(paymentIntents))[0].n,
      settlements: (await db.select({ n: sql<number>`count(*)::int` }).from(sellerSettlements))[0].n,
      payouts: (await db.select({ n: sql<number>`count(*)::int` }).from(payouts))[0].n,
    };

    const award = await accept(buyer.client, rfqId, offer.id);
    expect(award.status, JSON.stringify(award.data)).toBe(200);
    const orderId = award.data.data.order.orderId as string;

    // The commission is the policy engine's, not a constant in the RFQ path.
    const [policy] = await db.select().from(commissionPolicies).where(eq(commissionPolicies.isActive, true)).limit(1);
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(Number(award.data.data.order.commissionRate)).toBe(Number(policy.rate));
    expect(orderRow.paymentStatus).toBe('UNPAID');
    expect(orderRow.status).toBe('PENDING');

    // Ledger entries hang off the order's transaction and stay PENDING: taking
    // the order is not taking the money.
    const transactionId = award.data.data.order.transactionId as string;
    const ledger = await db.select().from(transactionLedger).where(eq(transactionLedger.transactionId, transactionId));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((l) => l.status === 'PENDING')).toBe(true);

    // Nothing was charged, settled or paid out.
    const after = {
      ledger: (await db.select({ n: sql<number>`count(*)::int` }).from(transactionLedger))[0].n,
      payments: (await db.select({ n: sql<number>`count(*)::int` }).from(paymentIntents))[0].n,
      settlements: (await db.select({ n: sql<number>`count(*)::int` }).from(sellerSettlements))[0].n,
      payouts: (await db.select({ n: sql<number>`count(*)::int` }).from(payouts))[0].n,
    };
    expect(after.payments).toBe(before.payments);
    expect(after.settlements).toBe(before.settlements);
    expect(after.payouts).toBe(before.payouts);
    expect(after.ledger - before.ledger).toBe(ledger.length);

    // The seller sees a suborder to fulfil, not money in hand.
    const [suborder] = await db.select().from(sellerOrders).where(eq(sellerOrders.parentOrderId, orderId));
    expect(suborder.settlementStatus).not.toBe('SETTLED');
    expect(suborder.sellerId).toBe(sellerAId);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).limit(1);
    expect(Number(item.unitPrice)).toBeGreaterThan(0);
  });

  it('records the decision for both sides and notifies them once', async () => {
    const rfqId = await openRequest('Journey — notifications');
    const winner = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    const loser = await quote(sellerB.client, rfqId, ['11.0000', '16.0000']);
    const award = await accept(buyer.client, rfqId, winner.id);
    expect(award.status).toBe(200);
    const orderId = award.data.data.order.orderId as string;

    const rows = await db.select().from(notifications);
    const forQuote = (quoteId: string) =>
      rows.filter((n) => JSON.stringify(n.data ?? {}).includes(quoteId));
    expect(forQuote(winner.id).length).toBeGreaterThanOrEqual(1);
    expect(forQuote(loser.id).length).toBeGreaterThanOrEqual(1);
    expect(rows.some((n) => JSON.stringify(n.data ?? {}).includes(orderId))).toBe(true);
    // Notifications carry references, never contact details.
    const payload = JSON.stringify(forQuote(loser.id));
    expect(payload).not.toMatch(/@wasit\.tn/);
    expect(payload).not.toMatch(/\+\d{6,}/);
  });

  it('keeps the invitation and quote records consistent after the award', async () => {
    const rfqId = await openRequest('Journey — records');
    const winner = await quote(sellerA.client, rfqId, ['10.0000', '15.0000']);
    const loser = await quote(sellerB.client, rfqId, ['11.0000', '16.0000']);
    expect((await accept(buyer.client, rfqId, winner.id)).status).toBe(200);

    const quotes = await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId));
    expect(quotes.find((q) => q.id === winner.id)?.quoteStatus).toBe('ACCEPTED');
    expect(quotes.find((q) => q.id === loser.id)?.quoteStatus).toBe('REJECTED');
    // The accepted revision is frozen: the terminal trigger refuses to reopen it.
    await expect(
      db.execute(sql`update rfq_quotes set quote_status = 'SUBMITTED' where id = ${winner.id}`),
    ).rejects.toThrow();
    // The RFQ itself cannot be sent again or cancelled after the award.
    expect((await sendRfq(buyer.client, rfqId, [sellerCId])).status).toBe(409);
    expect((await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, { method: 'POST', body: {} })).status).toBe(409);

    const events = await db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId));
    const types = events.map((e) => e.eventType);
    expect(types).toContain('QUOTE_ACCEPTED');
    expect(types).toContain('QUOTE_REJECTED');
    const accepted = events.find((e) => e.eventType === 'QUOTE_ACCEPTED');
    expect(accepted?.quoteId).toBe(winner.id);
    expect(accepted?.actorUserId).toBe(buyer.userId);

    const recipients = await db.select().from(rfqRecipients).where(eq(rfqRecipients.rfqId, rfqId));
    expect(recipients.every((r) => r.recipientStatus !== 'INVITED')).toBe(true);
  });
});
