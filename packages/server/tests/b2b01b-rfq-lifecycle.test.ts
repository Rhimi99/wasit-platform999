import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { policies } from '../src/db/schema/engine.js';
import { notifications } from '../src/db/schema/messaging.js';
import { orders, transactionLedger } from '../src/db/schema/commerce.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { rfqEvents, rfqQuoteLines, rfqQuotes, rfqRecipients, rfqs } from '../src/db/schema/rfq.js';
import { RFQ_PARTICIPATION_CONSENT } from '../src/lib/consent-types.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * B2B-01 phase 2 — RFQ / recipient / quote lifecycles over real HTTP and a real
 * Postgres, with no mocks and no route interception.
 *
 * The suite is deliberately adversarial: it walks the transitions *and* tries to
 * break them — a seller reaching for another seller's quote, a stale revision
 * being rewritten, a lapsed window being extended, a declined invitation being
 * reopened, a company id forged in the body, a cancelled RFQ still accepting
 * offers. Each of those attempts must be refused by the server, not by the UI.
 */

const app = createApp();

let ipCounter = 150;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
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

/** Entity names carry no digits, so a "no phone-like data" assertion stays meaningful. */
let nameCounter = 0;
function displayName(prefix: string): string {
  nameCounter += 1;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  let n = nameCounter * 7 + Math.floor(Math.random() * 1000);
  for (let i = 0; i < 5; i += 1) {
    suffix += letters[n % 26];
    n = Math.floor(n / 26) + 3;
  }
  return `${prefix} ${suffix}`;
}

interface Actor {
  client: Client;
  userId: string;
  email: string;
}

async function register(role: Role): Promise<Actor> {
  const client = makeClient();
  const email = `${unique('rfq2')}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'RFQ', lastName: role, role },
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

async function setConsent(actor: Actor, consentType: string, granted: boolean): Promise<void> {
  const res = await actor.client.req('/api/privacy/consents', {
    method: 'PUT',
    body: { consentType, granted },
  });
  expect(res.status).toBe(200);
}

async function createRfq(client: Client, overrides: Record<string, unknown> = {}) {
  return client.req('/api/rfqs', {
    method: 'POST',
    body: {
      title: 'Lifecycle request',
      currencyCode: 'TND',
      items: [
        { freeTextName: 'Pallet of bottles', quantity: '100.0000', unit: 'unit', targetPrice: '2.0000' },
        { freeTextName: 'Shrink wrap', quantity: '10.0000', unit: 'roll' },
      ],
      ...overrides,
    },
  });
}

async function send(client: Client, rfqId: string, sellerIds: string[], acknowledgeDisclosure = true) {
  return client.req(`/api/rfqs/${rfqId}/send`, {
    method: 'POST',
    body: { sellerIds, acknowledgeDisclosure },
  });
}

async function itemsOf(client: Client, rfqId: string): Promise<Array<{ id: string; quantity: string }>> {
  const res = await client.req(`/api/rfqs/${rfqId}`);
  expect(res.status).toBe(200);
  return res.data.data.items as Array<{ id: string; quantity: string }>;
}

function quoteBody(items: Array<{ id: string; quantity: string }>, unitPrices: string[], currencyCode = 'TND') {
  return {
    currencyCode,
    lines: items.map((item, index) => ({
      rfqItemId: item.id,
      unitPrice: unitPrices[index] ?? '1.0000',
      quantity: item.quantity,
    })),
  };
}

async function quote(client: Client, rfqId: string, unitPrices: string[], currencyCode = 'TND') {
  const items = await itemsOf(client, rfqId);
  return client.req(`/api/rfqs/${rfqId}/quotes`, {
    method: 'POST',
    body: quoteBody(items, unitPrices, currencyCode),
  });
}

async function notificationsFor(userIds: string[]) {
  if (userIds.length === 0) return [];
  return db
    .select()
    .from(notifications)
    .where(inArray(notifications.userId, userIds))
    .orderBy(notifications.createdAt);
}

/**
 * Money rows this buyer owns. The database is shared with the other suites, so a
 * global count would move whenever another file creates an order mid-test; this
 * answers the same question — "did the RFQ write money?" — without that race.
 */
async function financialCounts(buyerId: string) {
  const [o] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.buyerId, buyerId));
  const [l] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactionLedger)
    .where(sql`${transactionLedger.payerId} = ${buyerId} or ${transactionLedger.beneficiaryId} = ${buyerId}`);
  const [p] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(sql`${paymentIntents.orderId} in (select id from orders where buyer_id = ${buyerId})`);
  return { orders: o.n, ledger: l.n, payments: p.n };
}

const POLICY_RULES = {
  quoteValidityDays: 14,
  maxRounds: 5,
  maxRecipientsPerRfq: 20,
  maxItemsPerRfq: 50,
  responseWindowDays: 30,
};

async function setPolicyRules(rules: Record<string, number>): Promise<void> {
  await db
    .update(policies)
    .set({ rules })
    .where(and(eq(policies.code, 'RFQ_TERMS'), eq(policies.scope, 'B2B')));
}

async function expireRfqDirectly(rfqId: string): Promise<void> {
  await db
    .update(rfqs)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(rfqs.id, rfqId));
}

describe('B2B-01 phase 2 — RFQ and quote lifecycles (real HTTP + real Postgres)', () => {
  let buyer: Actor;
  let buyerCompanyId: string;
  let otherBuyer: Actor;
  let sellerA: Actor;
  let sellerAId: string;
  let sellerB: Actor;
  let sellerBId: string;
  let outsider: Actor;
  let outsiderId: string;

  beforeAll(async () => {
    buyer = await register('COMPANY');
    buyerCompanyId = await createEntity(buyer, 'companies', displayName('Lifecycle Buyer'));

    otherBuyer = await register('COMPANY');
    await createEntity(otherBuyer, 'companies', displayName('Other Buyer'));

    sellerA = await register('SUPPLIER');
    sellerAId = await createEntity(sellerA, 'suppliers', displayName('Supplier A'));
    await setConsent(sellerA, RFQ_PARTICIPATION_CONSENT, true);

    sellerB = await register('MERCHANT');
    sellerBId = await createEntity(sellerB, 'merchants', displayName('Merchant B'));
    await setConsent(sellerB, RFQ_PARTICIPATION_CONSENT, true);

    outsider = await register('MERCHANT');
    outsiderId = await createEntity(outsider, 'merchants', displayName('Outsider'));
    await setConsent(outsider, RFQ_PARTICIPATION_CONSENT, true);
  });

  // The RFQ routes are rate-limited per user (20 creations/minute). A single
  // spec issues more than that in one process, so the in-memory counter is reset
  // between cases; the limits themselves are unchanged (proven in phase 1).
  beforeEach(async () => {
    await resetRateLimitStore();
  });

  afterAll(async () => {
    await setPolicyRules(POLICY_RULES);
    await closeDb();
  });

  /** Creates an OPEN RFQ for the given sellers and returns its id. */
  async function openRfq(sellerIds: string[], overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await createRfq(buyer.client, overrides);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const id = created.data.data.id as string;
    const sent = await send(buyer.client, id, sellerIds);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* Recipient lifecycle                                              */
  /* ---------------------------------------------------------------- */

  it('moves INVITED → VIEWED on the first read, exactly once', async () => {
    const rfqId = await openRfq([sellerAId]);

    const before = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect((before.data.data.recipients as Array<{ status: string }>)[0].status).toBe('INVITED');

    const first = await sellerA.client.req(`/api/rfqs/${rfqId}`);
    expect(first.status).toBe(200);
    expect(first.data.data.myInvitation.status).toBe('VIEWED');
    expect(first.data.data.myInvitation.viewedAt).toBeTruthy();

    // Re-reading is silent: a second VIEWED entry would mean a duplicate event.
    await sellerA.client.req(`/api/rfqs/${rfqId}`);
    await sellerA.client.req(`/api/rfqs/${rfqId}`);

    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    const viewed = (timeline.data.data as Array<{ eventType: string }>).filter((e) => e.eventType === 'VIEWED');
    expect(viewed).toHaveLength(1);

    const buyerView = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect((buyerView.data.data.recipients as Array<{ status: string }>)[0].status).toBe('VIEWED');
  });

  it('lets a seller decline an unanswered invitation, with a reason', async () => {
    const rfqId = await openRfq([sellerAId]);

    const res = await sellerA.client.req(`/api/rfqs/${rfqId}/decline`, {
      method: 'POST',
      body: { reason: 'Out of stock this quarter' },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.data.status).toBe('DECLINED');

    const buyerView = await buyer.client.req(`/api/rfqs/${rfqId}`);
    const recipient = (buyerView.data.data.recipients as Array<Record<string, unknown>>)[0];
    expect(recipient.status).toBe('DECLINED');
    expect(recipient.declineReason).toBe('Out of stock this quarter');
    expect(recipient.declinedAt).toBeTruthy();

    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect((timeline.data.data as Array<{ eventType: string }>).map((e) => e.eventType)).toContain(
      'RECIPIENT_DECLINED',
    );

    // A declined invitation stays declined: no quote can reopen it.
    const late = await quote(sellerA.client, rfqId, ['1.0000', '2.0000']);
    expect(late.status).toBe(409);
    const again = await sellerA.client.req(`/api/rfqs/${rfqId}/decline`, { method: 'POST', body: {} });
    expect(again.status).toBe(409);
  });

  it('refuses to decline once a live quote exists (withdraw first)', async () => {
    const rfqId = await openRfq([sellerAId]);
    expect((await quote(sellerA.client, rfqId, ['1.0000', '2.0000'])).status).toBe(201);

    const res = await sellerA.client.req(`/api/rfqs/${rfqId}/decline`, { method: 'POST', body: {} });
    expect(res.status).toBe(409);
    expect(res.data.error.message).toMatch(/withdraw/i);
  });

  it('withdraws an offer, notifies the buyer, and lets the seller quote again', async () => {
    const rfqId = await openRfq([sellerBId]);
    const first = await quote(sellerB.client, rfqId, ['3.0000', '4.0000']);
    expect(first.status).toBe(201);
    const quoteId = first.data.data.quoteId as string;

    const withdrawn = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/withdraw`, {
      method: 'POST',
      body: { reason: 'Pricing error' },
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.data)).toBe(200);
    expect(withdrawn.data.data.status).toBe('WITHDRAWN');

    const sellerView = await sellerB.client.req(`/api/rfqs/${rfqId}`);
    expect(sellerView.data.data.myInvitation.status).toBe('WITHDRAWN');

    const sellerQuotes = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect((sellerQuotes.data.data as Array<{ status: string }>)[0].status).toBe('WITHDRAWN');

    const buyerTimeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    const events = buyerTimeline.data.data as Array<{ eventType: string; quoteId: string | null }>;
    expect(events.some((e) => e.eventType === 'QUOTE_WITHDRAWN' && e.quoteId === quoteId)).toBe(true);

    // Re-entering is a new revision, not an edit of the withdrawn one.
    const again = await quote(sellerB.client, rfqId, ['2.9000', '3.9000']);
    expect(again.status, JSON.stringify(again.data)).toBe(201);
    expect(again.data.data.revision).toBe(2);
  });

  /* ---------------------------------------------------------------- */
  /* Quote lifecycle: revisions and immutability                       */
  /* ---------------------------------------------------------------- */

  it('keeps every superseded revision byte-for-byte and exposes the chain read-only', async () => {
    const rfqId = await openRfq([sellerAId]);
    const rev1 = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    expect(rev1.status).toBe(201);
    const rev1Id = rev1.data.data.quoteId as string;

    const snapshot = (await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, rev1Id)))[0];
    const linesSnapshot = await db.select().from(rfqQuoteLines).where(eq(rfqQuoteLines.quoteId, rev1Id));
    expect(snapshot.itemsTotal).toBe('1200.0000'); // 100*10 + 10*20

    const rev2 = await quote(sellerA.client, rfqId, ['9.0000', '19.0000']);
    expect(rev2.status).toBe(201);
    expect(rev2.data.data.revision).toBe(2);

    const after = (await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, rev1Id)))[0];
    expect(after.quoteStatus).toBe('SUPERSEDED');
    expect(after.itemsTotal).toBe(snapshot.itemsTotal);
    expect(after.submittedAt.getTime()).toBe(snapshot.submittedAt.getTime());
    expect(after.currencyCode).toBe(snapshot.currencyCode);
    const linesAfter = await db.select().from(rfqQuoteLines).where(eq(rfqQuoteLines.quoteId, rev1Id));
    expect(linesAfter.map((l) => [l.rfqItemId, l.unitPrice, l.lineTotal]).sort()).toEqual(
      linesSnapshot.map((l) => [l.rfqItemId, l.unitPrice, l.lineTotal]).sort(),
    );

    // The buyer reads the whole chain, oldest first, with the original numbers.
    const chain = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${rev2.data.data.quoteId}/revisions`);
    expect(chain.status).toBe(200);
    const revisions = chain.data.data as Array<{ revision: number; status: string; itemsTotal: string }>;
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions[0].status).toBe('SUPERSEDED');
    expect(revisions[0].itemsTotal).toBe('1200.0000');
    expect(revisions[1].status).toBe('SUBMITTED');

    // The owning seller may read its own chain; no one else can.
    expect((await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/revisions`)).status).toBe(200);
    expect((await sellerB.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/revisions`)).status).toBe(404);
    expect((await outsider.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/revisions`)).status).toBe(404);
    expect((await otherBuyer.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/revisions`)).status).toBe(404);
  });

  it('refuses to touch a superseded revision (withdraw, reject, or any write route)', async () => {
    const rfqId = await openRfq([sellerAId]);
    const rev1 = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const rev1Id = rev1.data.data.quoteId as string;
    const rev2 = await quote(sellerA.client, rfqId, ['9.5000', '19.5000']);
    const rev2Id = rev2.data.data.quoteId as string;

    const withdrawOld = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/withdraw`, {
      method: 'POST',
      body: {},
    });
    expect(withdrawOld.status).toBe(409);

    const rejectOld = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${rev1Id}/reject`, {
      method: 'POST',
      body: { reason: 'too late to reject an old revision' },
    });
    expect(rejectOld.status).toBe(409);

    // There is no route that edits or deletes a quote at all.
    for (const [method, path] of [
      ['PATCH', `/api/rfqs/${rfqId}/quotes/${rev2Id}`],
      ['PUT', `/api/rfqs/${rfqId}/quotes/${rev2Id}`],
      ['DELETE', `/api/rfqs/${rfqId}/quotes/${rev2Id}`],
      ['PATCH', `/api/rfqs/${rfqId}/quotes`],
      ['DELETE', `/api/rfqs/${rfqId}/quotes`],
      ['PATCH', `/api/rfqs/${rfqId}/timeline`],
      ['DELETE', `/api/rfqs/${rfqId}/timeline`],
    ] as const) {
      const res = await buyer.client.req(path, { method, body: method === 'DELETE' ? undefined : {} });
      expect([404, 405], `${method} ${path} -> ${res.status}`).toContain(res.status);
    }

    // The database itself refuses to rewrite the record, even if a future code
    // path tried to: this is the guarantee the routes rely on.
    await expect(db.execute(sql`update rfq_quote_lines set unit_price = '0.0001' where quote_id = ${rev1Id}`)).rejects.toThrow(
      /append-only/i,
    );
    await expect(db.execute(sql`update rfq_quotes set items_total = '1.0000' where id = ${rev1Id}`)).rejects.toThrow(
      /immutable/i,
    );
    await expect(db.execute(sql`update rfq_quotes set quote_status = 'SUBMITTED' where id = ${rev1Id}`)).rejects.toThrow(
      /terminal/i,
    );
    await expect(db.execute(sql`delete from rfq_quotes where id = ${rev1Id}`)).rejects.toThrow(/cannot be deleted/i);
    await expect(db.execute(sql`delete from rfq_events where rfq_id = ${rfqId}`)).rejects.toThrow(/append-only/i);

    // Nothing above changed the row.
    const [still] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, rev1Id));
    expect(still.quoteStatus).toBe('SUPERSEDED');
    expect(still.itemsTotal).toBe('1200.0000');
  });

  it('refuses to let one seller act on another seller\'s quote', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    const aQuote = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    expect(aQuote.status).toBe(201);
    const aQuoteId = aQuote.data.data.quoteId as string;

    const withdrawOther = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes/${aQuoteId}/withdraw`, {
      method: 'POST',
      body: {},
    });
    expect(withdrawOther.status).toBe(404);

    const revisionsOther = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes/${aQuoteId}/revisions`);
    expect(revisionsOther.status).toBe(404);

    // The buyer cannot withdraw a seller's offer on the seller's behalf either.
    const buyerWithdraw = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${aQuoteId}/withdraw`, {
      method: 'POST',
      body: {},
    });
    expect([403, 404]).toContain(buyerWithdraw.status);

    // And the offer is untouched.
    const sellerView = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect((sellerView.data.data as Array<{ status: string }>)[0].status).toBe('SUBMITTED');
  });

  it('rejects a quote with a mandatory reason and records who decided', async () => {
    const rfqId = await openRfq([sellerAId]);
    const submitted = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const quoteId = submitted.data.data.quoteId as string;

    const missing = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
      method: 'POST',
      body: {},
    });
    expect(missing.status).toBe(422);

    const tooShort = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'no' },
    });
    expect(tooShort.status).toBe(422);

    const rejected = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'Price above our target' },
    });
    expect(rejected.status, JSON.stringify(rejected.data)).toBe(200);
    expect(rejected.data.data.status).toBe('REJECTED');

    const [row] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteId));
    expect(row.quoteStatus).toBe('REJECTED');
    expect(row.decisionReason).toBe('Price above our target');
    expect(row.decidedByUserId).toBe(buyer.userId);
    expect(row.decidedAt).toBeTruthy();

    // The seller sees the decision and its reason, and only its own quote.
    const sellerQuotes = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    const own = (sellerQuotes.data.data as Array<{ status: string; decisionReason: string | null }>)[0];
    expect(own.status).toBe('REJECTED');
    expect(own.decisionReason).toBe('Price above our target');

    // A rejection is not an award: the seller may re-offer while the RFQ is open.
    const again = await quote(sellerA.client, rfqId, ['9.0000', '19.0000']);
    expect(again.status).toBe(201);
    expect(again.data.data.revision).toBe(2);
  });

  it('refuses a rejection from a seller (route permission) and from another buyer (404)', async () => {
    const rfqId = await openRfq([sellerAId]);
    const submitted = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const quoteId = submitted.data.data.quoteId as string;

    const bySeller = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'I reject myself' },
    });
    expect(bySeller.status).toBe(403);

    const byOtherBuyer = await otherBuyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'not mine to decide' },
    });
    expect(byOtherBuyer.status).toBe(404);
  });

  /* ---------------------------------------------------------------- */
  /* Policy-driven limits                                             */
  /* ---------------------------------------------------------------- */

  it('enforces maxRounds from the policy and refuses a currency mismatch', async () => {
    await setPolicyRules({ ...POLICY_RULES, maxRounds: 2 });
    try {
      const rfqId = await openRfq([sellerBId]);

      const mismatch = await quote(sellerB.client, rfqId, ['1.0000', '2.0000'], 'EUR');
      expect(mismatch.status).toBe(409);
      expect(mismatch.data.error.message).toContain('TND');

      expect((await quote(sellerB.client, rfqId, ['3.0000', '4.0000'])).status).toBe(201);
      expect((await quote(sellerB.client, rfqId, ['2.9000', '3.9000'])).status).toBe(201);
      const third = await quote(sellerB.client, rfqId, ['2.8000', '3.8000']);
      expect(third.status).toBe(409);
      expect(third.data.error.message).toMatch(/2 rounds/);
    } finally {
      await setPolicyRules(POLICY_RULES);
    }
  });

  it('derives the quote validity window from the policy snapshot', async () => {
    await setPolicyRules({ ...POLICY_RULES, quoteValidityDays: 3 });
    try {
      const rfqId = await openRfq([sellerBId]);
      const submitted = await quote(sellerB.client, rfqId, ['3.0000', '4.0000']);
      expect(submitted.status).toBe(201);

      const [row] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, submitted.data.data.quoteId));
      const hours = (row.validUntil.getTime() - row.submittedAt.getTime()) / 3_600_000;
      expect(Math.round(hours)).toBe(72);
    } finally {
      await setPolicyRules(POLICY_RULES);
    }
  });

  it('closes the negotiation once a quote\'s own validity lapsed', async () => {
    const rfqId = await openRfq([sellerBId]);
    const submitted = await quote(sellerB.client, rfqId, ['3.0000', '4.0000']);
    const quoteId = submitted.data.data.quoteId as string;

    // Simulate the clock passing. `valid_until` is immutable by trigger, so the
    // guard is lifted for this one synthetic write and restored immediately.
    await db.execute(sql`alter table rfq_quotes disable trigger rfq_quotes_frozen_terms`);
    try {
      await db
        .update(rfqQuotes)
        .set({ validUntil: new Date(Date.now() - 60_000) })
        .where(eq(rfqQuotes.id, quoteId));
    } finally {
      await db.execute(sql`alter table rfq_quotes enable trigger rfq_quotes_frozen_terms`);
    }

    const late = await quote(sellerB.client, rfqId, ['2.0000', '3.0000']);
    expect(late.status).toBe(409);
    expect(late.data.error.message).toMatch(/expired/i);

    const [row] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, quoteId));
    expect(row.quoteStatus).toBe('EXPIRED');
    expect(row.expiredAt).toBeTruthy();

    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    const expired = (timeline.data.data as Array<{ eventType: string; actorType: string; payload: any }>).filter(
      (e) => e.eventType === 'EXPIRED' && e.payload?.scope === 'QUOTE',
    );
    expect(expired).toHaveLength(1);
    expect(expired[0].actorType).toBe('SYSTEM');
  });

  /* ---------------------------------------------------------------- */
  /* RFQ expiry and closure                                           */
  /* ---------------------------------------------------------------- */

  it('expires a lapsed RFQ atomically and stops all negotiation', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    await expireRfqDirectly(rfqId);

    // Five concurrent reads must produce one EXPIRED event, not five.
    const reads = await Promise.all([
      sellerA.client.req(`/api/rfqs/${rfqId}`),
      sellerA.client.req(`/api/rfqs/${rfqId}`),
      buyer.client.req(`/api/rfqs/${rfqId}`),
      buyer.client.req(`/api/rfqs/${rfqId}`),
      sellerB.client.req(`/api/rfqs/${rfqId}`),
    ]);
    for (const r of reads) expect(r.status).toBe(200);
    expect(reads[0].data.data.status).toBe('EXPIRED');

    const events = await db
      .select()
      .from(rfqEvents)
      .where(and(eq(rfqEvents.rfqId, rfqId), eq(rfqEvents.eventType, 'EXPIRED')));
    expect(events).toHaveLength(1);
    expect(events[0].actorType).toBe('SYSTEM');
    expect(events[0].actorUserId).toBeNull();

    const late = await quote(sellerB.client, rfqId, ['1.0000', '2.0000']);
    expect(late.status).toBe(409);
    const decline = await sellerB.client.req(`/api/rfqs/${rfqId}/decline`, { method: 'POST', body: {} });
    expect(decline.status).toBe(409);
    const reject = await buyer.client.req(`/api/rfqs/${rfqId}/quotes/whatever/reject`, {
      method: 'POST',
      body: { reason: 'too late' },
    });
    expect(reject.status).toBe(409);
  });

  it('closes every path after cancellation and refuses a second cancel', async () => {
    const rfqId = await openRfq([sellerAId]);
    const submitted = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const quoteId = submitted.data.data.quoteId as string;

    const cancelled = await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, {
      method: 'POST',
      body: { reason: 'Budget frozen' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.data.status).toBe('CANCELLED');

    expect((await quote(sellerA.client, rfqId, ['9.0000', '19.0000'])).status).toBe(409);
    expect((await sellerA.client.req(`/api/rfqs/${rfqId}/decline`, { method: 'POST', body: {} })).status).toBe(409);
    expect(
      (
        await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/reject`, {
          method: 'POST',
          body: { reason: 'irrelevant now' },
        })
      ).status,
    ).toBe(409);
    expect((await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, { method: 'POST', body: {} })).status).toBe(409);
    expect((await otherBuyer.client.req(`/api/rfqs/${rfqId}/cancel`, { method: 'POST', body: {} })).status).toBe(404);

    // Withdrawing a still-pending offer after cancellation is allowed: it removes
    // an offer and creates nothing.
    const withdrawn = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${quoteId}/withdraw`, {
      method: 'POST',
      body: {},
    });
    expect(withdrawn.status).toBe(200);
  });

  /* ---------------------------------------------------------------- */
  /* Consent, disclosure, identity                                    */
  /* ---------------------------------------------------------------- */

  it('does not accept B2B_PARTNER_DISCOVERY as a substitute for RFQ_PARTICIPATION', async () => {
    const partnerOnly = await register('SUPPLIER');
    const partnerOnlyId = await createEntity(partnerOnly, 'suppliers', displayName('Partner Only'));
    await setConsent(partnerOnly, 'B2B_PARTNER_DISCOVERY', true);

    const created = await createRfq(buyer.client);
    expect(created.status).toBe(201);
    const rfqId = created.data.data.id as string;

    const blocked = await send(buyer.client, rfqId, [partnerOnlyId]);
    expect(blocked.status).toBe(409);
    expect(blocked.data.error.message).toMatch(/not accepted RFQ participation/i);

    // Granting the right consent unblocks the very same invitation.
    await setConsent(partnerOnly, RFQ_PARTICIPATION_CONSENT, true);
    const allowed = await send(buyer.client, rfqId, [partnerOnlyId]);
    expect(allowed.status).toBe(200);
  });

  it('refuses to send without the disclosure acknowledgement', async () => {
    const created = await createRfq(buyer.client);
    const rfqId = created.data.data.id as string;
    const res = await send(buyer.client, rfqId, [sellerAId], false);
    expect(res.status).toBe(422);
    expect(res.data.error.fieldErrors?.[0]?.code).toBe('DISCLOSURE_NOT_ACKNOWLEDGED');

    const stillDraft = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(stillDraft.data.data.status).toBe('DRAFT');
  });

  it('cannot be given a company or seller identity from the request body', async () => {
    const forgedCreate = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: {
        title: 'Forged buyer',
        currencyCode: 'TND',
        items: [{ freeTextName: 'Anything', quantity: '1.0000' }],
        buyerCompanyId: 'some-other-company',
        buyerUserId: otherBuyer.userId,
      },
    });
    expect(forgedCreate.status).toBe(422);

    const rfqId = await openRfq([sellerAId]);

    for (const forged of [
      { sellerId: outsiderId },
      { sellerUserId: outsider.userId },
      { recipientStatus: 'QUOTED' },
    ]) {
      const res = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
        method: 'POST',
        body: { ...quoteBody(await itemsOf(sellerA.client, rfqId), ['1.0000', '2.0000']), ...forged },
      });
      expect(res.status, JSON.stringify(forged)).toBe(422);
    }

    const forgedSend = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [sellerBId], acknowledgeDisclosure: true, buyerCompanyId: 'x' },
    });
    expect(forgedSend.status).toBe(422);

    // The RFQ belongs to the caller's company, always.
    const detail = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(detail.data.data.company.id).toBe(buyerCompanyId);
  });

  /* ---------------------------------------------------------------- */
  /* Event history                                                    */
  /* ---------------------------------------------------------------- */

  it('records actor, timing, type and revision, and shows events to participants only', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    const submitted = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const quoteId = submitted.data.data.quoteId as string;

    const rows = await db.select().from(rfqEvents).where(eq(rfqEvents.rfqId, rfqId));
    for (const row of rows) {
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.eventType).toBeTruthy();
      if (row.eventType === 'SENT' || row.eventType === 'CREATED') expect(row.actorUserId).toBe(buyer.userId);
    }
    const quoteEvent = rows.find((r) => r.eventType === 'QUOTE_SUBMITTED')!;
    expect(quoteEvent.actorUserId).toBe(sellerA.userId);
    expect(quoteEvent.quoteId).toBe(quoteId);
    expect(quoteEvent.quoteRevision).toBe(1);

    // Non-participants see nothing: 404 on the timeline and on the quotes.
    for (const actor of [outsider, otherBuyer]) {
      expect((await actor.client.req(`/api/rfqs/${rfqId}/timeline`)).status).toBe(404);
      expect((await actor.client.req(`/api/rfqs/${rfqId}/quotes`)).status).toBe(404);
    }

    // Seller B sees the invitation and the RFQ, never seller A's quote event.
    const bTimeline = await sellerB.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(bTimeline.status).toBe(200);
    const bEvents = bTimeline.data.data as Array<{ eventType: string }>;
    expect(bEvents.map((e) => e.eventType)).not.toContain('QUOTE_SUBMITTED');
    expect(bTimeline.text).not.toContain(quoteId);
    expect(bTimeline.text).not.toContain(sellerAId);
  });

  it('exposes quote events to the buyer with the revision they describe', async () => {
    const rfqId = await openRfq([sellerBId]);
    await quote(sellerB.client, rfqId, ['3.0000', '4.0000']);
    await quote(sellerB.client, rfqId, ['2.5000', '3.5000']);

    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    const events = timeline.data.data as Array<{ eventType: string; quoteRevision: number | null }>;
    expect(events.filter((e) => e.eventType === 'QUOTE_SUBMITTED' && e.quoteRevision === 1)).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'QUOTE_REVISED' && e.quoteRevision === 2)).toHaveLength(1);
  });

  /* ---------------------------------------------------------------- */
  /* Notifications and money                                          */
  /* ---------------------------------------------------------------- */

  it('notifies inside the platform only, with no contact data in the payload', async () => {
    const rfqId = await openRfq([sellerAId]);
    const submitted = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${submitted.data.data.quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'not competitive' },
    });
    await sellerA.client.req(`/api/rfqs/${rfqId}/decline`, { method: 'POST', body: {} });

    const rows = await notificationsFor([buyer.userId, sellerA.userId]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = `${row.title} ${row.body ?? ''} ${JSON.stringify(row.data ?? {})}`;
      // No email, no account id: the notice carries a business reference (the
      // RFQ number) and a platform link, and nothing that identifies a person.
      expect(text).not.toContain('@');
      expect(text).not.toContain(buyer.email);
      expect(text).not.toContain(sellerA.email);
      expect(text).not.toContain(buyer.userId);
      expect(text).not.toContain(sellerA.userId);
      if (row.data) {
        for (const key of Object.keys(row.data as Record<string, unknown>)) {
          expect(['rfqId', 'quoteId']).toContain(key);
        }
      }
    }
    // The reject notification is addressed to the seller whose quote it was.
    expect(rows.some((r) => r.userId === sellerA.userId && r.type === 'RFQ_QUOTE_REJECTED')).toBe(true);
  });

  it('never writes to the ledger, an order or a payment intent', async () => {
    const before = await financialCounts(buyer.userId);

    const rfqId = await openRfq([sellerAId, sellerBId]);
    const a = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    const b = await quote(sellerB.client, rfqId, ['9.0000', '19.0000']);
    await quote(sellerA.client, rfqId, ['9.9000', '19.9000']);
    await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${b.data.data.quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'lead time too long' },
    });
    await sellerB.client.req(`/api/rfqs/${rfqId}/quotes/${b.data.data.quoteId}/withdraw`, {
      method: 'POST',
      body: {},
    });
    await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, { method: 'POST', body: { reason: 'test' } });

    const after = await financialCounts(buyer.userId);
    expect(after).toEqual(before);

    // A quote is priced but never paid: no payment fields exist on the projection.
    const quotes = await buyer.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(quotes.status).toBe(200);
    for (const q of quotes.data.data as Array<Record<string, unknown>>) {
      expect(q).not.toHaveProperty('paidAt');
      expect(q).not.toHaveProperty('paymentStatus');
      expect(q).not.toHaveProperty('transactionId');
      expect(['SUBMITTED', 'REJECTED', 'WITHDRAWN']).toContain(q.status as string);
    }
    expect(a.status).toBe(201);
  });

  it('keeps the recipient table consistent with the quote lifecycle', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    const a = await quote(sellerA.client, rfqId, ['10.0000', '20.0000']);
    await quote(sellerB.client, rfqId, ['9.0000', '19.0000']);
    await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${a.data.data.quoteId}/withdraw`, {
      method: 'POST',
      body: {},
    });

    const rows = await db.select().from(rfqRecipients).where(eq(rfqRecipients.rfqId, rfqId));
    const bySeller = new Map(rows.map((r) => [r.sellerId, r]));
    expect(bySeller.get(sellerAId)!.recipientStatus).toBe('WITHDRAWN');
    expect(bySeller.get(sellerBId)!.recipientStatus).toBe('QUOTED');

    const buyerView = await buyer.client.req(`/api/rfqs/${rfqId}`);
    const statuses = (buyerView.data.data.recipients as Array<{ sellerId: string; status: string }>).map((r) => [
      r.sellerId,
      r.status,
    ]);
    expect(statuses).toContainEqual([sellerAId, 'WITHDRAWN']);
    expect(statuses).toContainEqual([sellerBId, 'QUOTED']);
  });
});
