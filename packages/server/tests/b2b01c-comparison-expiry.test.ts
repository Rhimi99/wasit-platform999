import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { orders, sellerSettlements, transactionLedger } from '../src/db/schema/commerce.js';
import { notifications } from '../src/db/schema/messaging.js';
import { paymentIntents } from '../src/db/schema/payments_extras.js';
import { rfqEvents, rfqQuoteLines, rfqQuotes, rfqRecipients, rfqs } from '../src/db/schema/rfq.js';
import { RFQ_PARTICIPATION_CONSENT } from '../src/lib/consent-types.js';
import { runRfqExpirySweep } from '../src/modules/rfq/expiry.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

/**
 * B2B-01 phase 3 — offer comparison and reliable expiry, over real HTTP and a
 * real Postgres, with no mocks and no route interception.
 *
 * The suite is adversarial on purpose. It tries to read a competitor's price as
 * a seller, to make a lapsed or rejected quote look live, to smuggle a second
 * currency into a price ranking, and to make the sweep write the same expiry
 * twice (by running it again, and by running five copies at once).
 */

const app = createApp();

let ipCounter = 40;
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
  const email = `${unique('rfq3')}@wasit.tn`;
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
      title: 'Comparison request',
      currencyCode: 'TND',
      items: [
        { freeTextName: 'Bottle 75cl', quantity: '100.0000', unit: 'unit', targetPrice: '1.0000' },
        { freeTextName: 'Shrink wrap', quantity: '10.0000', unit: 'roll', targetPrice: '2.0000' },
      ],
      ...overrides,
    },
  });
}

async function send(client: Client, rfqId: string, sellerIds: string[]) {
  return client.req(`/api/rfqs/${rfqId}/send`, {
    method: 'POST',
    body: { sellerIds, acknowledgeDisclosure: true },
  });
}

async function itemsOf(client: Client, rfqId: string): Promise<Array<{ id: string; quantity: string }>> {
  const res = await client.req(`/api/rfqs/${rfqId}`);
  expect(res.status).toBe(200);
  return res.data.data.items as Array<{ id: string; quantity: string }>;
}

async function quote(
  client: Client,
  rfqId: string,
  unitPrices: [string, string],
  extra: Record<string, unknown> = {},
) {
  const items = await itemsOf(client, rfqId);
  return client.req(`/api/rfqs/${rfqId}/quotes`, {
    method: 'POST',
    body: {
      currencyCode: 'TND',
      lines: items.map((item, index) => ({
        rfqItemId: item.id,
        unitPrice: unitPrices[index],
        quantity: item.quantity,
      })),
      ...extra,
    },
  });
}

async function comparison(client: Client, rfqId: string) {
  return client.req(`/api/rfqs/${rfqId}/comparison`);
}

/** Deadline drift is simulated in the row, because the API never sets it backwards. */
async function makeRfqDue(rfqId: string): Promise<void> {
  await db.update(rfqs).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(rfqs.id, rfqId));
}

async function makeQuoteDue(quoteId: string): Promise<void> {
  // `valid_until` is immutable by trigger (migration 0046): a test that needs to
  // move the clock must say so explicitly and put the guard back afterwards.
  await db.execute(sql`alter table rfq_quotes disable trigger rfq_quotes_frozen_terms`);
  try {
    await db.update(rfqQuotes).set({ validUntil: new Date(Date.now() - 60_000) }).where(eq(rfqQuotes.id, quoteId));
  } finally {
    await db.execute(sql`alter table rfq_quotes enable trigger rfq_quotes_frozen_terms`);
  }
}

async function expiredEvents(rfqId: string, scope?: 'RFQ' | 'QUOTE') {
  const rows = await db
    .select()
    .from(rfqEvents)
    .where(and(eq(rfqEvents.rfqId, rfqId), eq(rfqEvents.eventType, 'EXPIRED')));
  return scope
    ? rows.filter((r) => (r.payload as { scope?: string } | null)?.scope === scope)
    : rows;
}

async function financialCounts() {
  const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(orders);
  const [l] = await db.select({ n: sql<number>`count(*)::int` }).from(transactionLedger);
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(paymentIntents);
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(sellerSettlements);
  return { orders: o.n, ledger: l.n, payments: p.n, settlements: s.n };
}

describe('B2B-01 phase 3 — comparison and expiry (real HTTP + real Postgres)', () => {
  let buyer: Actor;
  let sellerA: Actor;
  let sellerAId: string;
  let sellerB: Actor;
  let sellerBId: string;
  let sellerC: Actor;
  let sellerCId: string;
  let outsider: Actor;
  let otherBuyer: Actor;

  beforeAll(async () => {
    buyer = await register('COMPANY');
    await createEntity(buyer, 'companies', 'Comparison Buyer SARL');

    otherBuyer = await register('COMPANY');
    await createEntity(otherBuyer, 'companies', 'Unrelated Buyer SARL');

    sellerA = await register('SUPPLIER');
    sellerAId = await createEntity(sellerA, 'suppliers', 'Glass Works North');
    await setConsent(sellerA, RFQ_PARTICIPATION_CONSENT, true);

    sellerB = await register('MERCHANT');
    sellerBId = await createEntity(sellerB, 'merchants', 'Trade House East');
    await setConsent(sellerB, RFQ_PARTICIPATION_CONSENT, true);

    sellerC = await register('SUPPLIER');
    sellerCId = await createEntity(sellerC, 'suppliers', 'Packing South');
    await setConsent(sellerC, RFQ_PARTICIPATION_CONSENT, true);

    outsider = await register('MERCHANT');
    await createEntity(outsider, 'merchants', 'Never Invited');
    await setConsent(outsider, RFQ_PARTICIPATION_CONSENT, true);
  });

  // The RFQ routes are rate-limited per user; one spec issues more than the
  // per-minute allowance. The limits themselves are unchanged.
  beforeEach(async () => {
    await resetRateLimitStore();
  });

  afterAll(async () => {
    await closeDb();
  });

  async function openRfq(sellerIds: string[], overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await createRfq(buyer.client, overrides);
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const id = created.data.data.id as string;
    const sent = await send(buyer.client, id, sellerIds);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    return id;
  }

  /* ------------------------------------------------------------------ */
  /* Comparison                                                          */
  /* ------------------------------------------------------------------ */

  it('compares several offers with price, quantities, currency, lead time, validity, terms and revision', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId, sellerCId]);

    expect((await quote(sellerA.client, rfqId, ['1.1000', '2.0000'], {
      leadTimeDays: 7,
      paymentTerms: '50% upfront',
      notes: 'Palletised, FOB Tunis',
    })).status).toBe(201);
    expect((await quote(sellerB.client, rfqId, ['0.9500', '2.2000'], {
      leadTimeDays: 21,
      paymentTerms: 'Net 30',
    })).status).toBe(201);
    expect((await quote(sellerC.client, rfqId, ['1.0500', '1.9000'], { leadTimeDays: 14 })).status).toBe(201);

    const res = await comparison(buyer.client, rfqId);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const view = res.data.data;

    expect(view.scope).toBe('ALL');
    expect(view.rfq.currencyCode).toBe('TND');
    expect(view.rfq.acceptsQuotes).toBe(true);
    expect(view.rows).toHaveLength(3);
    expect(view.items).toHaveLength(2);

    const byName = new Map<string, any>(view.rows.map((r: any) => [r.sellerName, r]));
    const a = byName.get('Glass Works North')!;
    const b = byName.get('Trade House East')!;

    // 100 * 1.1 + 10 * 2.0 = 130 ; 100 * 0.95 + 10 * 2.2 = 117
    expect(a.itemsTotal).toBe('130.0000');
    expect(b.itemsTotal).toBe('117.0000');
    expect(b.priceRank).toBe(1);
    expect(a.priceRank).toBe(3); // B 117 < C 124 < A 130

    expect(a.currencyCode).toBe('TND');
    expect(a.revision).toBe(1);
    expect(a.status).toBe('SUBMITTED');
    expect(a.comparable).toBe(true);
    expect(a.leadTimeDays).toBe(7);
    expect(a.paymentTerms).toBe('50% upfront');
    expect(a.notes).toBe('Palletised, FOB Tunis');
    expect(typeof a.validUntil).toBe('string');
    expect(new Date(a.validUntil).getTime()).toBeGreaterThan(Date.now());

    // Each line carries what was asked and what was offered, plus the delta to target.
    const line = a.lines.find((l: any) => l.itemName === 'Bottle 75cl');
    expect(line.requestedQuantity).toBe('100.0000');
    expect(line.quotedQuantity).toBe('100.0000');
    expect(line.unitPrice).toBe('1.1000');
    expect(line.lineTotal).toBe('110.0000');
    expect(line.targetPrice).toBe('1.0000');
    expect(line.targetDelta).toBe('0.1000');

    expect(view.summary.comparableQuotes).toBe(3);
    expect(view.summary.lowestTotal).toBe('117.0000');
    expect(view.summary.highestTotal).toBe('130.0000');
    expect(view.summary.bestPriceQuoteId).toBe(b.quoteId);
    expect(view.summary.fastestLeadTimeDays).toBe(7);
    expect(view.summary.fastestLeadTimeQuoteId).toBe(a.quoteId);
    expect(view.summary.currencyMixed).toBe(false);

    // Per-item statistics: bottle 0.95 .. 1.10, wrap 1.90 .. 2.20
    const bottle = view.summary.perItem.find((p: any) => p.itemName === 'Bottle 75cl')!;
    expect(bottle.lowestUnitPrice).toBe('0.9500');
    expect(bottle.highestUnitPrice).toBe('1.1000');
    expect(bottle.averageUnitPrice).toBe('1.0333');
    const wrap = view.summary.perItem.find((p: any) => p.itemName === 'Shrink wrap')!;
    expect(wrap.lowestUnitPrice).toBe('1.9000');
    expect(wrap.highestUnitPrice).toBe('2.2000');
  });

  it('keeps each seller’s different lead times visible instead of collapsing them', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['1.0000', '2.0000'], { leadTimeDays: 3 });
    await quote(sellerB.client, rfqId, ['1.0000', '2.0000'], { leadTimeDays: 45 });

    const view = (await comparison(buyer.client, rfqId)).data.data;
    const leads = view.rows.map((r: any) => r.leadTimeDays).sort((x: number, y: number) => x - y);
    expect(leads).toEqual([3, 45]);
    expect(view.summary.fastestLeadTimeDays).toBe(3);
  });

  it('ignores older revisions and compares only the newest live one', async () => {
    const rfqId = await openRfq([sellerAId]);
    const first = await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    expect(first.status).toBe(201);
    const second = await quote(sellerA.client, rfqId, ['0.9000', '1.9000']);
    expect(second.status).toBe(201);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].revision).toBe(2);
    expect(view.rows[0].itemsTotal).toBe('109.0000');
    expect(view.summary.comparableQuotes).toBe(1);

    // The superseded revision is not compared, but it is not hidden either.
    const superseded = view.excluded.filter((e: any) => e.reason === 'SUPERSEDED');
    expect(superseded).toHaveLength(1);
    expect(superseded[0].revision).toBe(1);
    expect(superseded[0].quoteId).toBe(first.data.data.quoteId);
  });

  it('excludes an expired quote and refuses to rank it', async () => {
    const rfqId = await openRfq([sellerAId]);
    const q = await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await makeQuoteDue(q.data.data.quoteId);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rows).toHaveLength(0);
    expect(view.summary.comparableQuotes).toBe(0);
    expect(view.summary.lowestTotal).toBeNull();
    expect(view.excluded).toHaveLength(1);
    expect(view.excluded[0].reason).toBe('EXPIRED');

    // The comparison persisted the lapse through the same guarded statement.
    const [row] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, q.data.data.quoteId));
    expect(row.quoteStatus).toBe('EXPIRED');
    expect(row.expiredAt).toBeTruthy();
  });

  it('excludes withdrawn and rejected offers with their own reasons', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    const withdrawn = await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    expect((await sellerA.client.req(`/api/rfqs/${rfqId}/quotes/${withdrawn.data.data.quoteId}/withdraw`, {
      method: 'POST',
      body: { reason: 'Out of stock' },
    })).status).toBe(200);
    const rejected = await quote(sellerB.client, rfqId, ['1.2000', '2.0000']);
    expect((await buyer.client.req(`/api/rfqs/${rfqId}/quotes/${rejected.data.data.quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'Too expensive for this volume' },
    })).status).toBe(200);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rows).toHaveLength(0);
    const reasons = view.excluded.map((e: any) => e.reason).sort();
    expect(reasons).toEqual(['REJECTED', 'WITHDRAWN']);
    expect(view.summary.lowestTotal).toBeNull();
  });

  it('never mixes currencies in one price comparison', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']); // 130.0000 TND
    const foreign = await quote(sellerB.client, rfqId, ['0.0100', '0.0100']); // would look cheapest
    expect(foreign.status).toBe(201);
    // Simulate a row that predates the currency guard: it must still be excluded.
    await db.execute(sql`alter table rfq_quotes disable trigger rfq_quotes_frozen_terms`);
    await db.update(rfqQuotes).set({ currencyCode: 'EUR' }).where(eq(rfqQuotes.id, foreign.data.data.quoteId));
    await db.execute(sql`alter table rfq_quotes enable trigger rfq_quotes_frozen_terms`);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].currencyCode).toBe('TND');
    expect(view.summary.lowestTotal).toBe('130.0000');
    expect(view.summary.bestPriceQuoteId).toBe(view.rows[0].quoteId);
    expect(view.summary.currencyMixed).toBe(true);
    const excluded = view.excluded.find((e: any) => e.reason === 'CURRENCY_MISMATCH');
    expect(excluded).toBeTruthy();
  });

  it('shows a seller only its own offer, never a competitor’s price', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    const mine = await quote(sellerA.client, rfqId, ['1.1000', '2.0000']); // 130.0000
    await quote(sellerB.client, rfqId, ['0.5000', '0.5000']); // 55.0000

    const res = await comparison(sellerA.client, rfqId);
    expect(res.status).toBe(200);
    expect(res.data.data.scope).toBe('OWN');
    expect(res.data.data.rows).toHaveLength(1);
    expect(res.data.data.rows[0].quoteId).toBe(mine.data.data.quoteId);
    expect(res.data.data.rows[0].sellerId).toBe(sellerAId);
    // The competing total must not appear anywhere in the payload.
    expect(res.text).not.toContain('55.0000');
    expect(res.text).not.toContain('Trade House East');
  });

  it('refuses the comparison to non-participants and to another company', async () => {
    const rfqId = await openRfq([sellerAId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);

    const outsiderRes = await comparison(outsider.client, rfqId);
    expect(outsiderRes.status).toBe(404);
    expect(outsiderRes.text).not.toContain('1.1000');

    const otherBuyerRes = await comparison(otherBuyer.client, rfqId);
    expect(otherBuyerRes.status).toBe(404);

    const anonymous = await makeClient().req(`/api/rfqs/${rfqId}/comparison`);
    expect(anonymous.status).toBe(401);
  });

  it('reports quotes of a cancelled RFQ as not comparable', async () => {
    const rfqId = await openRfq([sellerAId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    expect((await buyer.client.req(`/api/rfqs/${rfqId}/cancel`, {
      method: 'POST',
      body: { reason: 'Sourced internally' },
    })).status).toBe(200);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rfq.status).toBe('CANCELLED');
    expect(view.rfq.acceptsQuotes).toBe(false);
    expect(view.rows).toHaveLength(0);
    expect(view.summary.comparableQuotes).toBe(0);
    expect(view.excluded.map((e: any) => e.reason)).toContain('RFQ_NOT_OPEN');
  });

  it('treats quantity as requested-and-offered, and refuses a mismatched quantity', async () => {
    const rfqId = await openRfq([sellerAId]);
    const items = await itemsOf(sellerA.client, rfqId);
    const forged = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        lines: items.map((item, index) => ({
          rfqItemId: item.id,
          unitPrice: '1.0000',
          quantity: index === 0 ? '50.0000' : item.quantity,
        })),
      },
    });
    expect(forged.status).toBe(422);

    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rows[0].lines.map((l: any) => [l.requestedQuantity, l.quotedQuantity])).toEqual([
      ['100.0000', '100.0000'],
      ['10.0000', '10.0000'],
    ]);
  });

  it('does not write anything: no order, ledger, payment, settlement or quote mutation', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await quote(sellerB.client, rfqId, ['0.9000', '1.9000']);

    const before = await financialCounts();
    const quotesBefore = await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId));
    const linesBefore = await db
      .select()
      .from(rfqQuoteLines)
      .where(inArray(rfqQuoteLines.quoteId, quotesBefore.map((q) => q.id)));

    for (let i = 0; i < 3; i += 1) {
      expect((await comparison(buyer.client, rfqId)).status).toBe(200);
    }

    const after = await financialCounts();
    expect(after).toEqual(before);

    const quotesAfter = await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId));
    expect(quotesAfter.map((q) => [q.id, q.quoteStatus, q.itemsTotal, q.revision])).toEqual(
      quotesBefore.map((q) => [q.id, q.quoteStatus, q.itemsTotal, q.revision]),
    );
    const linesAfter = await db
      .select()
      .from(rfqQuoteLines)
      .where(inArray(rfqQuoteLines.quoteId, quotesAfter.map((q) => q.id)));
    expect(linesAfter.length).toBe(linesBefore.length);
  });

  /* ------------------------------------------------------------------ */
  /* Expiry: lazy + periodic                                             */
  /* ------------------------------------------------------------------ */

  it('sweeps a lapsed RFQ once, with a SYSTEM event carrying the deadline and the reason', async () => {
    const rfqId = await openRfq([sellerAId]);
    await makeRfqDue(rfqId);

    const first = await runRfqExpirySweep(db, { batchSize: 50 });
    expect(first.rfqsExpired).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(row.status).toBe('EXPIRED');

    const events = await expiredEvents(rfqId, 'RFQ');
    expect(events).toHaveLength(1);
    expect(events[0].actorType).toBe('SYSTEM');
    expect(events[0].actorUserId).toBeNull();
    const payload = events[0].payload as { expiresAt?: string; reason?: string; fromStatus?: string };
    expect(payload.reason).toBe('RESPONSE_WINDOW_LAPSED');
    expect(payload.fromStatus).toBe('OPEN');
    expect(payload.expiresAt).toBe(row.expiresAt!.toISOString());

    // The buyer is told once, in-app, and the seller too.
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, buyer.userId), eq(notifications.type, 'RFQ_EXPIRED')));
    expect(notes.filter((n) => (n.data as { rfqId?: string } | null)?.rfqId === rfqId)).toHaveLength(1);
  });

  it('is idempotent: a second sweep writes nothing and duplicates no event', async () => {
    const rfqId = await openRfq([sellerAId]);
    await makeRfqDue(rfqId);
    await runRfqExpirySweep(db);

    const eventsBefore = await expiredEvents(rfqId);
    const notesBefore = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, buyer.userId));

    const second = await runRfqExpirySweep(db);
    expect(second.rfqsExpired).toBe(0);
    expect(second.quotesExpired).toBe(0);

    expect(await expiredEvents(rfqId)).toHaveLength(eventsBefore.length);
    const notesAfter = await db.select().from(notifications).where(eq(notifications.userId, buyer.userId));
    expect(notesAfter.length).toBe(notesBefore.length);
  });

  it('is safe under five concurrent sweeps: exactly one expiry per row', async () => {
    const rfqIds = await Promise.all([
      openRfq([sellerAId]),
      openRfq([sellerBId]),
      openRfq([sellerCId]),
    ]);
    const quotes: string[] = [];
    quotes.push((await quote(sellerA.client, rfqIds[0], ['1.1000', '2.0000'])).data.data.quoteId);
    quotes.push((await quote(sellerB.client, rfqIds[1], ['1.1000', '2.0000'])).data.data.quoteId);
    quotes.push((await quote(sellerC.client, rfqIds[2], ['1.1000', '2.0000'])).data.data.quoteId);
    for (const id of rfqIds) await makeRfqDue(id);
    for (const id of quotes) await makeQuoteDue(id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => runRfqExpirySweep(db, { batchSize: 10 })),
    );
    // Each RFQ is expired by exactly one caller; the totals must add up to 3.
    expect(results.reduce((sum, r) => sum + r.rfqsExpired, 0)).toBe(3);
    expect(results.reduce((sum, r) => sum + r.quotesExpired, 0)).toBe(3);

    for (const rfqId of rfqIds) {
      const [row] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
      expect(row.status).toBe('EXPIRED');
      expect(await expiredEvents(rfqId, 'RFQ')).toHaveLength(1);
      expect(await expiredEvents(rfqId, 'QUOTE')).toHaveLength(1);
    }
    const statuses = await db.select().from(rfqQuotes).where(inArray(rfqQuotes.id, quotes));
    expect(statuses.every((q) => q.quoteStatus === 'EXPIRED' && q.expiredAt)).toBe(true);
  });

  it('expires a lapsed quote and records its validity deadline', async () => {
    const rfqId = await openRfq([sellerAId]); // RFQ stays OPEN
    const q = await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await makeQuoteDue(q.data.data.quoteId);

    const result = await runRfqExpirySweep(db);
    expect(result.quotesExpired).toBeGreaterThanOrEqual(1);

    const [quoteRow] = await db.select().from(rfqQuotes).where(eq(rfqQuotes.id, q.data.data.quoteId));
    expect(quoteRow.quoteStatus).toBe('EXPIRED');
    expect(quoteRow.expiredAt).toBeTruthy();

    const events = await expiredEvents(rfqId, 'QUOTE');
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { reason?: string; validUntil?: string; revision?: number };
    expect(payload.reason).toBe('QUOTE_VALIDITY_LAPSED');
    expect(payload.revision).toBe(1);
    expect(payload.validUntil).toBe(quoteRow.validUntil.toISOString());

    const [rfqRow] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(rfqRow.status).toBe('OPEN');

    // A lapsed quote closes *that seller's* negotiation: a "revision 2" would be
    // a new offer against a dead one, so the server refuses it (phase 2 rule,
    // unchanged here). The RFQ itself stays open for the other invitees.
    const again = await quote(sellerA.client, rfqId, ['1.0000', '1.9000']);
    expect(again.status).toBe(409);
    expect(again.data.error.message).toMatch(/expired/i);
    expect(await expiredEvents(rfqId, 'QUOTE')).toHaveLength(1);
  });

  it('never touches a decided, cancelled or already expired RFQ, nor a finished quote', async () => {
    const awardedId = await openRfq([sellerAId]);
    const cancelledId = await openRfq([sellerBId]);
    const alreadyExpiredId = await openRfq([sellerCId]);
    const liveId = await openRfq([sellerAId]);

    const rejected = await quote(sellerA.client, liveId, ['1.1000', '2.0000']);
    expect((await buyer.client.req(`/api/rfqs/${liveId}/quotes/${rejected.data.data.quoteId}/reject`, {
      method: 'POST',
      body: { reason: 'Not this round' },
    })).status).toBe(200);
    const withdrawn = await quote(sellerA.client, liveId, ['0.9900', '1.9900']);
    expect((await sellerA.client.req(`/api/rfqs/${liveId}/quotes/${withdrawn.data.data.quoteId}/withdraw`, {
      method: 'POST',
      body: { reason: 'Change of plan' },
    })).status).toBe(200);

    // Phase 4 will set AWARDED; the sweep must treat it as settled already.
    await db.update(rfqs).set({ status: 'AWARDED', awardedAt: new Date() }).where(eq(rfqs.id, awardedId));
    await buyer.client.req(`/api/rfqs/${cancelledId}/cancel`, { method: 'POST', body: { reason: 'Closed' } });
    await db.update(rfqs).set({ status: 'EXPIRED' }).where(eq(rfqs.id, alreadyExpiredId));

    for (const id of [awardedId, cancelledId, alreadyExpiredId]) await makeRfqDue(id);

    const before = await db
      .select({ id: rfqs.id, status: rfqs.status, awardedAt: rfqs.awardedAt, cancelledAt: rfqs.cancelledAt })
      .from(rfqs)
      .where(inArray(rfqs.id, [awardedId, cancelledId, alreadyExpiredId]));
    const quotesBefore = await db
      .select({ id: rfqQuotes.id, status: rfqQuotes.quoteStatus })
      .from(rfqQuotes)
      .where(eq(rfqQuotes.rfqId, liveId));

    await runRfqExpirySweep(db);

    const after = await db
      .select({ id: rfqs.id, status: rfqs.status, awardedAt: rfqs.awardedAt, cancelledAt: rfqs.cancelledAt })
      .from(rfqs)
      .where(inArray(rfqs.id, [awardedId, cancelledId, alreadyExpiredId]));
    expect(after).toEqual(before);
    for (const id of [awardedId, cancelledId, alreadyExpiredId]) {
      expect(await expiredEvents(id)).toHaveLength(0);
    }
    expect(await db
      .select({ id: rfqQuotes.id, status: rfqQuotes.quoteStatus })
      .from(rfqQuotes)
      .where(eq(rfqQuotes.rfqId, liveId))).toEqual(quotesBefore);
  });

  it('leaves rows that are not due alone and drains a backlog in bounded batches', async () => {
    const dueIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await openRfq([sellerAId]);
      await makeRfqDue(id);
      dueIds.push(id);
    }
    const notDue = await openRfq([sellerAId]);

    const result = await runRfqExpirySweep(db, { batchSize: 2, maxBatches: 10 });
    expect(result.truncated).toBe(false);
    expect(result.batches).toBeGreaterThanOrEqual(2);

    for (const id of dueIds) {
      const [row] = await db.select().from(rfqs).where(eq(rfqs.id, id));
      expect(row.status).toBe('EXPIRED');
    }
    const [untouched] = await db.select().from(rfqs).where(eq(rfqs.id, notDue));
    expect(untouched.status).toBe('OPEN');
  });

  it('stops at maxBatches and reports the truncation instead of running unbounded', async () => {
    for (let i = 0; i < 3; i += 1) {
      const id = await openRfq([sellerAId]);
      await makeRfqDue(id);
    }
    const result = await runRfqExpirySweep(db, { batchSize: 1, maxBatches: 1 });
    expect(result.batches).toBe(1);
    // Either it expired the batch and reports truncation, or it was the last batch.
    expect(result.truncated).toBe(result.rfqsExpired + result.quotesExpired > 0);
  });

  it('does not resurrect an expired RFQ through the comparison or a late quote', async () => {
    const rfqId = await openRfq([sellerAId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await makeRfqDue(rfqId);
    await runRfqExpirySweep(db);

    const late = await quote(sellerA.client, rfqId, ['0.5000', '0.5000']);
    expect(late.status).toBe(409);

    const view = (await comparison(buyer.client, rfqId)).data.data;
    expect(view.rfq.status).toBe('EXPIRED');
    expect(view.rows).toHaveLength(0);

    const [row] = await db.select().from(rfqs).where(eq(rfqs.id, rfqId));
    expect(row.status).toBe('EXPIRED');
    expect(await expiredEvents(rfqId, 'RFQ')).toHaveLength(1);
  });

  it('changes no payment, ledger, settlement or order data while expiring', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await quote(sellerB.client, rfqId, ['0.9000', '1.9000']);
    await makeRfqDue(rfqId);
    await makeQuoteDue((await db.select().from(rfqQuotes).where(eq(rfqQuotes.rfqId, rfqId)))[0].id);

    const before = await financialCounts();
    await runRfqExpirySweep(db);
    await runRfqExpirySweep(db);
    expect(await financialCounts()).toEqual(before);
  });

  it('keeps the participant list and the timeline readable after an expiry', async () => {
    const rfqId = await openRfq([sellerAId, sellerBId]);
    await quote(sellerA.client, rfqId, ['1.1000', '2.0000']);
    await makeRfqDue(rfqId);
    await runRfqExpirySweep(db);

    const recipients = await db.select().from(rfqRecipients).where(eq(rfqRecipients.rfqId, rfqId));
    expect(recipients).toHaveLength(2);

    const timeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(timeline.status).toBe(200);
    const types = (timeline.data.data as Array<{ eventType: string; actorType: string }>).map((e) => [
      e.eventType,
      e.actorType,
    ]);
    expect(types).toContainEqual(['EXPIRED', 'SYSTEM']);
    expect(types).toContainEqual(['CREATED', 'USER']);

    // A seller still sees its own history; the RFQ itself is not deleted.
    const sellerTimeline = await sellerA.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(sellerTimeline.status).toBe(200);
    expect(sellerTimeline.text).toContain('EXPIRED');
  });
});
