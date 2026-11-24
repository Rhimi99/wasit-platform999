import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { policies } from '../src/db/schema/engine.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from '@wasit/shared';
import { createRfq } from '../src/modules/rfq/service.js';
import { RFQ_PARTICIPATION_CONSENT } from '../src/lib/consent-types.js';

/**
 * B2B-01 phase 1 — RFQ isolation gate.
 *
 * Every case below goes through the real HTTP app against the real database
 * (no mocks, no route interception). The point is not the happy path; it is the
 * four isolation claims that must hold before any negotiation UI is built:
 *
 *   1. another company never sees an RFQ it did not issue;
 *   2. a seller that was not invited never sees the RFQ at all;
 *   3. seller A never sees seller B's quote or B's timeline entries;
 *   4. no response leaks a user id, an email or a phone number.
 */

const app = createApp();

let ipCounter = 40;
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

interface Actor {
  client: Client;
  userId: string;
  email: string;
}

async function register(role: Role): Promise<Actor> {
  const client = makeClient();
  const email = `${unique('rfq')}@wasit.tn`;
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

async function grantRfqConsent(actor: Actor): Promise<void> {
  const res = await actor.client.req('/api/privacy/consents', {
    method: 'PUT',
    body: { consentType: RFQ_PARTICIPATION_CONSENT, granted: true },
  });
  expect(res.status).toBe(200);
}

async function revokeRfqConsent(actor: Actor): Promise<void> {
  const res = await actor.client.req('/api/privacy/consents', {
    method: 'PUT',
    body: { consentType: RFQ_PARTICIPATION_CONSENT, granted: false },
  });
  expect(res.status).toBe(200);
}

async function activeCategoryId(client: Client): Promise<string> {
  const cats = await client.req('/api/categories');
  expect(cats.status).toBe(200);
  return (cats.data.data as Array<{ id: string }>)[0].id;
}

async function createActiveProduct(actor: Actor, sellerId: string, sellerType: 'SUPPLIER' | 'MERCHANT'): Promise<string> {
  const categoryId = await activeCategoryId(actor.client);
  const sku = unique('SKU').toUpperCase();
  const res = await actor.client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType,
      categoryId,
      name: `RFQ Item ${sku}`,
      sku,
      basePrice: '12.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 100,
      lowStockThreshold: 5,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const productId = res.data.data.id as string;
  const publish = await actor.client.req(`/api/products/${productId}/status`, {
    method: 'PATCH',
    body: { status: 'ACTIVE' },
  });
  expect(publish.status).toBe(200);
  return productId;
}

/** Inserts a user with a staff role directly: staff cannot self-register. */
async function createStaffUser(roleName: 'ADMIN' | 'SUPER_ADMIN'): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `${unique('rfq-staff')}@wasit.tn`,
    passwordHash: 'x',
    firstName: 'Staff',
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  expect(role, `role ${roleName} must be seeded`).toBeTruthy();
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });
  return id;
}

function rfqBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Bulk packaging for Q3',
    description: 'Corrugated boxes, delivered to Tunis.',
    currencyCode: 'tnd',
    items: [
      { freeTextName: 'Corrugated box 40x30x30', quantity: '1000.0000', unit: 'unit', targetPrice: '1.2000' },
      { freeTextName: 'Packing tape 48mm', quantity: '500.0000', unit: 'roll' },
    ],
    ...overrides,
  };
}

describe('B2B-01 — RFQ isolation (real HTTP + real Postgres)', () => {
  let buyer: Actor;
  let buyerCompanyId: string;
  let sellerA: Actor;
  let sellerAId: string;
  let sellerB: Actor;
  let sellerBId: string;
  let sellerQuiet: Actor;
  let sellerQuietId: string; // owned + consented, never invited
  let sellerNoConsent: Actor;
  let sellerNoConsentId: string;
  let otherBuyer: Actor;
  let otherBuyerCompanyId: string;
  let productId: string;

  beforeAll(async () => {
    buyer = await register('COMPANY');
    buyerCompanyId = await createEntity(buyer, 'companies', `Buyer Co ${unique('B')}`);

    sellerA = await register('SUPPLIER');
    sellerAId = await createEntity(sellerA, 'suppliers', `Supplier A ${unique('S')}`);
    await grantRfqConsent(sellerA);

    sellerB = await register('MERCHANT');
    sellerBId = await createEntity(sellerB, 'merchants', `Merchant B ${unique('M')}`);
    await grantRfqConsent(sellerB);
    productId = await createActiveProduct(sellerB, sellerBId, 'MERCHANT');

    sellerQuiet = await register('MERCHANT');
    sellerQuietId = await createEntity(sellerQuiet, 'merchants', `Merchant Quiet ${unique('M')}`);
    await grantRfqConsent(sellerQuiet);

    sellerNoConsent = await register('SUPPLIER');
    sellerNoConsentId = await createEntity(sellerNoConsent, 'suppliers', `Supplier NoConsent ${unique('S')}`);

    otherBuyer = await register('COMPANY');
    otherBuyerCompanyId = await createEntity(otherBuyer, 'companies', `Other Buyer Co ${unique('B')}`);
  });

  afterAll(async () => {
    await closeDb();
  });

  /* ---------------------------------------------------------------- */
  /* Permissions and identity                                          */
  /* ---------------------------------------------------------------- */

  it('rejects anonymous access to every RFQ endpoint (401)', async () => {
    const anon = makeClient();
    for (const [method, path] of [
      ['GET', '/api/rfqs'],
      ['GET', '/api/rfqs/inbox'],
      ['POST', '/api/rfqs'],
      ['GET', '/api/rfqs/does-not-exist'],
      ['GET', '/api/rfqs/does-not-exist/quotes'],
      ['GET', '/api/rfqs/does-not-exist/timeline'],
      ['POST', '/api/rfqs/does-not-exist/send'],
      ['POST', '/api/rfqs/does-not-exist/cancel'],
      ['POST', '/api/rfqs/does-not-exist/quotes'],
    ] as const) {
      const res = await anon.req(path, { method, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('grants RFQ permissions to the commercial roles only (no ADMIN grants)', () => {
    // ADMIN is hand-listed and must not hold these; SUPER_ADMIN inherits the full
    // set by platform design, which is why every RFQ action is also gated by the
    // ownership checks exercised below (a staff account owns no company).
    for (const p of [PERMISSIONS.RFQ_CREATE, PERMISSIONS.RFQ_READ_OWN, PERMISSIONS.RFQ_QUOTE, PERMISSIONS.RFQ_DECIDE]) {
      expect(ROLE_PERMISSIONS.ADMIN.has(p), `ADMIN must not hold ${p}`).toBe(false);
      expect(ROLE_PERMISSIONS.CUSTOMER.has(p), `CUSTOMER must not hold ${p}`).toBe(false);
      expect(ROLE_PERMISSIONS.SUPPORT.has(p), `SUPPORT must not hold ${p}`).toBe(false);
    }
    expect(ROLE_PERMISSIONS.COMPANY.has(PERMISSIONS.RFQ_CREATE)).toBe(true);
    expect(ROLE_PERMISSIONS.COMPANY.has(PERMISSIONS.RFQ_DECIDE)).toBe(true);
    expect(ROLE_PERMISSIONS.MERCHANT.has(PERMISSIONS.RFQ_QUOTE)).toBe(true);
    expect(ROLE_PERMISSIONS.SUPPLIER.has(PERMISSIONS.RFQ_QUOTE)).toBe(true);
    // A seller must not be able to issue its own RFQs under the seller grant.
    expect(ROLE_PERMISSIONS.MERCHANT.has(PERMISSIONS.RFQ_CREATE)).toBe(false);
    expect(ROLE_PERMISSIONS.SUPPLIER.has(PERMISSIONS.RFQ_CREATE)).toBe(false);
  });

  it('refuses RFQ creation from a role without the permission (403)', async () => {
    const customer = await register('CUSTOMER');
    const res = await customer.client.req('/api/rfqs', { method: 'POST', body: rfqBody() });
    expect(res.status).toBe(403);
  });

  it('refuses RFQ creation for a company-role user that owns no company (403)', async () => {
    const noCompany = await register('COMPANY');
    const res = await noCompany.client.req('/api/rfqs', { method: 'POST', body: rfqBody() });
    expect(res.status).toBe(403);
    expect(res.data.error.message).toMatch(/company/i);
  });

  it('blocks staff (ADMIN / SUPER_ADMIN) at the service layer — they own no buying company', async () => {
    for (const roleName of ['ADMIN', 'SUPER_ADMIN'] as const) {
      const staffId = await createStaffUser(roleName);
      await expect(
        createRfq(db, staffId, {
          title: 'Staff attempt',
          currencyCode: 'TND',
          items: [{ freeTextName: 'Anything', quantity: '1' }],
        }, { actorId: staffId, ipAddress: null, userAgent: null }),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  /* ---------------------------------------------------------------- */
  /* Creation and sending                                              */
  /* ---------------------------------------------------------------- */

  let rfqId: string;

  it('creates a draft with a server-side item list and no leaked identifiers', async () => {
    const res = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: rfqBody({
        items: [
          { productId, quantity: '20.0000' },
          { freeTextName: 'Corrugated box 40x30x30', quantity: '1000.0000', unit: 'unit' },
        ],
      }),
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data.data.status).toBe('DRAFT');
    expect(res.data.data.rfqNumber).toMatch(/^RFQ/);
    rfqId = res.data.data.id as string;

    const detail = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.currencyCode).toBe('TND'); // normalised from "tnd"
    expect(detail.data.data.items).toHaveLength(2);
    expect(detail.data.data.company.id).toBe(buyerCompanyId);

    expect(detail.text).not.toContain(buyer.userId);
    expect(detail.text).not.toContain(buyer.email);
    expect(detail.text).not.toMatch(/"userId"|"sellerUserId"|"buyerUserId"|"email"|"phone"/);
  });

  it('rejects an unknown product id and a zero quantity (422)', async () => {
    const unknown = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: rfqBody({ items: [{ productId: 'no-such-product', quantity: '1.0000' }] }),
    });
    expect(unknown.status).toBe(422);

    const zero = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: rfqBody({ items: [{ freeTextName: 'Thing', quantity: '0.0000' }] }),
    });
    expect(zero.status).toBe(422);

    const noName = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: rfqBody({ items: [{ quantity: '1.0000' }] }),
    });
    expect(noName.status).toBe(422);
  });

  it('requires an explicit disclosure acknowledgement before sending (422)', async () => {
    const res = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [sellerAId], acknowledgeDisclosure: false },
    });
    expect(res.status).toBe(422);
    expect(res.data.error.fieldErrors?.[0]?.code).toBe('DISCLOSURE_NOT_ACKNOWLEDGED');
  });

  it('refuses to invite a seller whose owner has not accepted RFQ participation (409, name only)', async () => {
    const res = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [sellerNoConsentId], acknowledgeDisclosure: true },
    });
    expect(res.status).toBe(409);
    expect(res.data.error.message).toContain('Supplier NoConsent');
    expect(res.data.error.message).not.toContain(sellerNoConsent.userId);
  });

  it('refuses a self-invitation and an unknown seller (409 / 422)', async () => {
    const self = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [buyerCompanyId], acknowledgeDisclosure: true },
    });
    expect(self.status).toBe(409);

    const unknown = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: ['no-such-seller'], acknowledgeDisclosure: true },
    });
    expect(unknown.status).toBe(422);
  });

  it('sends the RFQ to the two consented sellers only', async () => {
    const res = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [sellerAId, sellerBId], acknowledgeDisclosure: true },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.data.status).toBe('OPEN');
    expect(res.data.data.recipientCount).toBe(2);

    const detail = await buyer.client.req(`/api/rfqs/${rfqId}`);
    expect(detail.status).toBe(200);
    const recipients = detail.data.data.recipients as Array<{ sellerId: string; status: string }>;
    expect(recipients.map((r) => r.sellerId).sort()).toEqual([sellerAId, sellerBId].sort());
    expect(detail.text).not.toContain(sellerA.userId);
    expect(detail.text).not.toContain(sellerB.userId);
  });

  it('cannot be sent twice (409)', async () => {
    const res = await buyer.client.req(`/api/rfqs/${rfqId}/send`, {
      method: 'POST',
      body: { sellerIds: [sellerAId], acknowledgeDisclosure: true },
    });
    expect(res.status).toBe(409);
  });

  /* ---------------------------------------------------------------- */
  /* Cross-company isolation                                           */
  /* ---------------------------------------------------------------- */

  it('hides the RFQ from another company entirely (404 + absent from its list)', async () => {
    const direct = await otherBuyer.client.req(`/api/rfqs/${rfqId}`);
    expect(direct.status).toBe(404);

    const list = await otherBuyer.client.req('/api/rfqs');
    expect(list.status).toBe(200);
    const ids = (list.data.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(rfqId);

    const quotes = await otherBuyer.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(quotes.status).toBe(404);
    expect(otherBuyerCompanyId).not.toBe(buyerCompanyId);
  });

  it('hides the RFQ from a seller that was not invited (404, empty inbox)', async () => {
    const direct = await sellerQuiet.client.req(`/api/rfqs/${rfqId}`);
    expect(direct.status).toBe(404);

    const inbox = await sellerQuiet.client.req('/api/rfqs/inbox');
    expect(inbox.status).toBe(200);
    const ids = (inbox.data.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(rfqId);

    const quotes = await sellerQuiet.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(quotes.status).toBe(404);
    const timeline = await sellerQuiet.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(timeline.status).toBe(404);
    expect(sellerQuietId).toBeTruthy();
  });

  it('shows each invited seller only its own invitation', async () => {
    const res = await sellerA.client.req(`/api/rfqs/${rfqId}`);
    expect(res.status).toBe(200);
    expect(res.data.data.buyer.legalName).toContain('Buyer Co');
    expect(res.data.data.myInvitation.sellerId).toBe(sellerAId);
    // The seller sees no recipient list and no other seller's id.
    expect(res.data.data.recipients).toBeUndefined();
    expect(res.text).not.toContain(sellerBId);
    expect(res.text).not.toContain(sellerB.userId);
    expect(res.text).not.toContain(buyer.userId);
    expect(res.text).not.toMatch(/"userId"|"sellerUserId"|"buyerUserId"|"email"|"phone"/);
  });

  /* ---------------------------------------------------------------- */
  /* Quotes: one seller never sees another                             */
  /* ---------------------------------------------------------------- */

  it('rejects a quote from a non-invited seller (404)', async () => {
    const res = await sellerQuiet.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: { currencyCode: 'TND', lines: [{ rfqItemId: 'x', unitPrice: '1.0000', quantity: '1.0000' }] },
    });
    expect(res.status).toBe(404);
  });

  it('validates a quote server-side (currency, completeness, quantity, price)', async () => {
    const items = (await buyer.client.req(`/api/rfqs/${rfqId}`)).data.data.items as Array<{
      id: string;
      quantity: string;
    }>;
    const [first, second] = items;

    const wrongCurrency = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'EUR',
        lines: [
          { rfqItemId: first.id, unitPrice: '1.0000', quantity: first.quantity },
          { rfqItemId: second.id, unitPrice: '2.0000', quantity: second.quantity },
        ],
      },
    });
    expect(wrongCurrency.status).toBe(409);

    const incomplete = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: { currencyCode: 'TND', lines: [{ rfqItemId: first.id, unitPrice: '1.0000', quantity: first.quantity }] },
    });
    expect(incomplete.status).toBe(422);
    expect(incomplete.data.error.fieldErrors?.[0]?.code).toBe('INCOMPLETE_QUOTE');

    const wrongQuantity = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        lines: [
          { rfqItemId: first.id, unitPrice: '1.0000', quantity: '1.0000' },
          { rfqItemId: second.id, unitPrice: '2.0000', quantity: second.quantity },
        ],
      },
    });
    expect(wrongQuantity.status).toBe(422);

    const zeroPrice = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        lines: [
          { rfqItemId: first.id, unitPrice: '0.0000', quantity: first.quantity },
          { rfqItemId: second.id, unitPrice: '2.0000', quantity: second.quantity },
        ],
      },
    });
    expect(zeroPrice.status).toBe(422);
  });

  let quoteAId: string;
  let quoteBId: string;

  it('accepts one quote per invited seller and computes the total itself', async () => {
    const items = (await buyer.client.req(`/api/rfqs/${rfqId}`)).data.data.items as Array<{
      id: string;
      quantity: string;
    }>;
    const [first, second] = items;

    const a = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        leadTimeDays: 10,
        lines: [
          { rfqItemId: first.id, unitPrice: '11.5000', quantity: first.quantity },
          { rfqItemId: second.id, unitPrice: '2.2500', quantity: second.quantity },
        ],
      },
    });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    expect(a.data.data.revision).toBe(1);
    // 20 * 11.5 + 1000 * 2.25 = 230 + 2250 = 2480
    expect(a.data.data.itemsTotal).toBe('2480.0000');
    quoteAId = a.data.data.quoteId as string;

    const b = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes`, {
      method: 'POST',
      body: {
        currencyCode: 'TND',
        lines: [
          { rfqItemId: first.id, unitPrice: '10.0000', quantity: first.quantity },
          { rfqItemId: second.id, unitPrice: '2.0000', quantity: second.quantity },
        ],
      },
    });
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    quoteBId = b.data.data.quoteId as string;
    expect(quoteBId).not.toBe(quoteAId);
  });

  it('never exposes one seller\'s quote to another seller', async () => {
    const aView = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(aView.status).toBe(200);
    const aQuotes = aView.data.data as Array<{ id: string; sellerId: string }>;
    expect(aQuotes).toHaveLength(1);
    expect(aQuotes[0].id).toBe(quoteAId);
    expect(aQuotes[0].sellerId).toBe(sellerAId);
    expect(aView.text).not.toContain(quoteBId);
    expect(aView.text).not.toContain(sellerBId);

    const bView = await sellerB.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(bView.status).toBe(200);
    const bQuotes = bView.data.data as Array<{ id: string; sellerId: string }>;
    expect(bQuotes).toHaveLength(1);
    expect(bQuotes[0].id).toBe(quoteBId);
    expect(bView.text).not.toContain(quoteAId);
    expect(bView.text).not.toContain(sellerAId);
  });

  it('gives the buyer the quotes of both sellers', async () => {
    const res = await buyer.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(res.status).toBe(200);
    const quotes = res.data.data as Array<{ id: string; sellerId: string }>;
    expect(quotes.map((q) => q.id).sort()).toEqual([quoteAId, quoteBId].sort());
    // The buyer still sees no user id, only seller entity ids.
    expect(res.text).not.toContain(sellerA.userId);
    expect(res.text).not.toContain(sellerB.userId);
  });

  it('filters the timeline per participant', async () => {
    const buyerTimeline = await buyer.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(buyerTimeline.status).toBe(200);
    const buyerEvents = (buyerTimeline.data.data as Array<{ eventType: string }>).map((e) => e.eventType);
    expect(buyerEvents.filter((e) => e === 'QUOTE_SUBMITTED')).toHaveLength(2);
    expect(buyerEvents).toContain('SENT');

    const aTimeline = await sellerA.client.req(`/api/rfqs/${rfqId}/timeline`);
    expect(aTimeline.status).toBe(200);
    const aEvents = aTimeline.data.data as Array<{ eventType: string; payload: Record<string, unknown> | null }>;
    expect(aEvents.filter((e) => e.eventType === 'QUOTE_SUBMITTED')).toHaveLength(1);
    expect(JSON.stringify(aEvents)).not.toContain(sellerBId);
    // The buyer-only creation event stays with the buyer.
    expect(aEvents.map((e) => e.eventType)).not.toContain('CREATED');
  });

  /* ---------------------------------------------------------------- */
  /* Consent withdrawal and lifecycle                                  */
  /* ---------------------------------------------------------------- */

  it('withdraws every access when the seller revokes RFQ participation', async () => {
    await revokeRfqConsent(sellerA);

    const detail = await sellerA.client.req(`/api/rfqs/${rfqId}`);
    expect(detail.status).toBe(404);

    const quotes = await sellerA.client.req(`/api/rfqs/${rfqId}/quotes`);
    expect(quotes.status).toBe(404);

    const inbox = await sellerA.client.req('/api/rfqs/inbox');
    expect(inbox.status).toBe(200);
    expect((inbox.data.data as Array<{ id: string }>).map((r) => r.id)).not.toContain(rfqId);

    // The buyer keeps its own view untouched.
    expect((await buyer.client.req(`/api/rfqs/${rfqId}`)).status).toBe(200);

    await grantRfqConsent(sellerA);
    expect((await sellerA.client.req(`/api/rfqs/${rfqId}`)).status).toBe(200);
  });

  it('enforces the negotiation-round ceiling from the policy row, snapshotted per RFQ', async () => {
    // Policy is data: shrinking maxRounds changes the next RFQ, and the snapshot
    // taken at creation is what governs it — never a constant in the service.
    await db
      .update(policies)
      .set({ rules: { quoteValidityDays: 7, maxRounds: 2, maxRecipientsPerRfq: 5, maxItemsPerRfq: 10, responseWindowDays: 10 } })
      .where(and(eq(policies.code, 'RFQ_TERMS'), eq(policies.scope, 'B2B')));

    try {
      const created = await buyer.client.req('/api/rfqs', {
        method: 'POST',
        body: { title: 'Round limit check', currencyCode: 'TND', items: [{ freeTextName: 'Widget', quantity: '5.0000' }] },
      });
      expect(created.status).toBe(201);
      const roundRfqId = created.data.data.id as string;

      const sent = await buyer.client.req(`/api/rfqs/${roundRfqId}/send`, {
        method: 'POST',
        body: { sellerIds: [sellerBId], acknowledgeDisclosure: true },
      });
      expect(sent.status).toBe(200);

      const itemId = (await buyer.client.req(`/api/rfqs/${roundRfqId}`)).data.data.items[0].id as string;
      const quote = (unitPrice: string) =>
        sellerB.client.req(`/api/rfqs/${roundRfqId}/quotes`, {
          method: 'POST',
          body: { currencyCode: 'TND', lines: [{ rfqItemId: itemId, unitPrice, quantity: '5.0000' }] },
        });

      expect((await quote('3.0000')).status).toBe(201);
      expect((await quote('2.9000')).status).toBe(201);
      const third = await quote('2.8000');
      expect(third.status).toBe(409);
      expect(third.data.error.message).toMatch(/2 rounds/);

      // Only the latest revision is listed, and the superseded one is not shown.
      const listed = await sellerB.client.req(`/api/rfqs/${roundRfqId}/quotes`);
      const rows = listed.data.data as Array<{ revision: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(2);

      // Cancelling closes the RFQ for further quotes.
      const cancelled = await buyer.client.req(`/api/rfqs/${roundRfqId}/cancel`, { method: 'POST', body: {} });
      expect(cancelled.status).toBe(200);
      const afterCancel = await quote('2.7000');
      expect(afterCancel.status).toBe(409);
    } finally {
      await db
        .update(policies)
        .set({
          rules: { quoteValidityDays: 14, maxRounds: 5, maxRecipientsPerRfq: 20, maxItemsPerRfq: 50, responseWindowDays: 30 },
        })
        .where(and(eq(policies.code, 'RFQ_TERMS'), eq(policies.scope, 'B2B')));
    }
  });

  it('only the buying company can cancel, and a seller gets 403', async () => {
    const created = await buyer.client.req('/api/rfqs', {
      method: 'POST',
      body: { title: 'Cancel auth check', currencyCode: 'TND', items: [{ freeTextName: 'Thing', quantity: '1.0000' }] },
    });
    const id = created.data.data.id as string;

    const sellerAttempt = await sellerB.client.req(`/api/rfqs/${id}/cancel`, { method: 'POST', body: {} });
    // sellerB holds no RFQ_CREATE permission, so the route refuses before the service.
    expect([403, 404]).toContain(sellerAttempt.status);

    const otherCompany = await otherBuyer.client.req(`/api/rfqs/${id}/cancel`, { method: 'POST', body: {} });
    expect(otherCompany.status).toBe(404);

    const own = await buyer.client.req(`/api/rfqs/${id}/cancel`, { method: 'POST', body: { reason: 'No longer needed' } });
    expect(own.status).toBe(200);
    expect(own.data.data.status).toBe('CANCELLED');
  });
});
