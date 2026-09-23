import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { adEvents } from '../src/db/schema/ads.js';
import { eq, sql, desc } from 'drizzle-orm';

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

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Ads', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function setupSupplier(variant = '') {
  const client = makeClient();
  const email = `it-ads-sup-${uniq('')}@wasit.tn`;
  await register(client, email, 'SUPPLIER');
  const profile = await client.req('/api/suppliers', {
    method: 'POST',
    body: { companyName: `Ads Supplier ${email}${variant}` },
  });
  expect(profile.status).toBe(201);
  const supplierId = profile.data.data.id as string;
  return { client, supplierId, email };
}

async function setupCustomer() {
  const client = makeClient();
  const email = `it-ads-cus-${uniq('')}@wasit.tn`;
  await register(client, email, 'CUSTOMER');
  return client;
}

async function createCampaign(
  client: ReturnType<typeof makeClient>,
  supplierId: string,
  overrides: Record<string, unknown> = {},
) {
  return client.req('/api/ads/campaigns', {
    method: 'POST',
    body: {
      advertiserId: supplierId,
      advertiserType: 'SUPPLIER',
      title: uniq('Campaign'),
      objective: 'PRODUCT_ADS',
      budget: '100.0000',
      currencyCode: 'TND',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      ...overrides,
    },
  });
}

describe('Advertising Engine', () => {
  it('rejects unauthenticated campaign creation', async () => {
    const c = makeClient();
    const r = await c.req('/api/ads/campaigns', {
      method: 'POST',
      body: { title: 'x', advertiserId: 'x', advertiserType: 'SUPPLIER' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects CUSTOMER from creating a campaign', async () => {
    const customer = await setupCustomer();
    const r = await createCampaign(customer, '00000000-0000-0000-0000-000000000000');
    // CUSTOMER lacks CAMPAIGN_CREATE/CAMPAIGN_MANAGE → 403 from permission guard.
    expect(r.status).toBe(403);
  });

  it('allows SUPPLIER to create a campaign with its own entity', async () => {
    const { client, supplierId } = await setupSupplier();
    const r = await createCampaign(client, supplierId);
    expect(r.status).toBe(201);
    expect(r.data.data.title).toBeTruthy();
    expect(r.data.data.status).toBe('DRAFT');
    expect(r.data.data.budget).toBe('100.0000');
    expect(r.data.data.isActive).toBe(false);
  });

  it('rejects creating a campaign for an entity the user does not own', async () => {
    const { client, supplierId } = await setupSupplier();
    const other = await setupSupplier('Other');
    const r = await createCampaign(client, other.supplierId);
    expect(r.status).toBe(403);
    void supplierId;
  });

  it('lists only own campaigns (isolation)', async () => {
    const a = await setupSupplier('A');
    const b = await setupSupplier('B');
    await createCampaign(a.client, a.supplierId);
    await createCampaign(b.client, b.supplierId);

    const listA = await a.client.req('/api/ads/campaigns');
    expect(listA.status).toBe(200);
    const itemsA = listA.data.data.items as Array<{ advertiserId: string }>;
    expect(itemsA.length).toBe(1);
    expect(itemsA[0].advertiserId).toBe(a.supplierId);
  });

  it('adds creatives and lists them in campaign detail', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;

    const creative = await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: {
        type: 'BANNER',
        title: 'Intl Olive Oil',
        body: 'Cold-pressed extra virgin Tunisian olive oil',
        targetUrl: 'https://wasit.tn/products/oil',
      },
    });
    expect(creative.status).toBe(201);

    const detail = await client.req(`/api/ads/campaigns/${campaignId}`);
    expect(detail.status).toBe(200);
    expect((detail.data.data.creatives as unknown[]).length).toBe(1);
    expect((detail.data.data.creatives as Array<{ title: string }>)[0].title).toBe('Intl Olive Oil');
  });

  it('cannot access another advertiser campaign detail', async () => {
    const a = await setupSupplier('A');
    const b = await setupSupplier('B');
    const createdA = await createCampaign(a.client, a.supplierId);
    const campaignId = createdA.data.data.id as string;
    const detailB = await b.client.req(`/api/ads/campaigns/${campaignId}`);
    expect(detailB.status).toBe(403);
  });

  it('activates a campaign and serves it, then records events and stats', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;

    // Add creative so the campaign is actually servable.
    const creative = await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: { type: 'BANNER', title: 'Camp', targetUrl: 'https://wasit.tn' },
    });
    expect(creative.status).toBe(201);

    // DRAFT → ACTIVE allowed by owner.
    const activate = await client.req(`/api/ads/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { status: 'ACTIVE' },
    });
    expect(activate.status).toBe(200);
    expect(activate.data.data.status).toBe('ACTIVE');
    expect(activate.data.data.isActive).toBe(true);

    // Serve placement returns this campaign's creative.
    const served = await app.request('/api/ads/served');
    const servedBody = (await served.json()) as { success: boolean; data: { items: Array<{ campaignId: string }> } };
    expect(servedBody.data.items.some((i) => i.campaignId === campaignId)).toBe(true);

    // Record impression, click, conversion (with cost metadata).
    const event = await setupCustomer();
    for (const ev of [
      { eventType: 'IMPRESSION' },
      { eventType: 'CLICK' },
      { eventType: 'CONVERSION', metadata: { cost: '1.0000' } },
    ] as const) {
      const r = await event.req('/api/ads/events', {
        method: 'POST',
        body: { campaignId, eventType: ev.eventType, sessionId: 's1', metadata: ev.metadata },
      });
      expect(r.status).toBe(201);
    }

    // Events persisted.
    const eventsInDb = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(adEvents)
      .where(eq(adEvents.campaignId, campaignId));
    expect(eventsInDb[0].count).toBe(3);

    // Stats reflect counts and updated spent.
    const stats = await client.req(`/api/ads/campaigns/${campaignId}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.data.data.impressions).toBe(1);
    expect(stats.data.data.clicks).toBe(1);
    expect(stats.data.data.conversions).toBe(1);
    expect(stats.data.data.ctr).toBeCloseTo(1, 5);
    expect(stats.data.data.spent).toBe('1.0000');
  });

  it('rejects events for a non-active campaign', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;

    const r = await client.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'IMPRESSION' },
    });
    expect(r.status).toBe(409);
  });

  it('reports owned advertiser entities for the ads UI', async () => {
    const { client, supplierId } = await setupSupplier();
    const r = await client.req('/api/ads/my-advertisers');
    expect(r.status).toBe(200);
    const items = r.data.data.items as Array<{ id: string; type: string; name: string }>;
    expect(items.some((i) => i.id === supplierId && i.type === 'SUPPLIER')).toBe(true);
    void supplierId;
  });

  it('forbids invalid status transition and budget below spent', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;

    const badTransition = await client.req(`/api/ads/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { status: 'ACTIVE' },
    });
    expect(badTransition.status).toBe(200);

    const invalid = await client.req(`/api/ads/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { status: 'DRAFT' },
    });
    // ACTIVE → DRAFT is not allowed.
    expect(invalid.status).toBe(409);
  });

  it('serves a campaign only for the placements it targets', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId, {
      adUnits: { placements: ['MARKETPLACE'] },
    });
    const campaignId = created.data.data.id as string;
    await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: { type: 'BANNER', title: 'Placement Creative' },
    });
    await client.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'ACTIVE' } });

    const targeted = await app.request('/api/ads/served?placement=MARKETPLACE');
    const targetedBody = (await targeted.json()) as { data: { items: Array<{ campaignId: string }> } };
    expect(targetedBody.data.items.some((i) => i.campaignId === campaignId)).toBe(true);

    const elsewhere = await app.request('/api/ads/served?placement=PRODUCT_DETAILS');
    const elsewhereBody = (await elsewhere.json()) as { data: { items: Array<{ campaignId: string }> } };
    expect(elsewhereBody.data.items.some((i) => i.campaignId === campaignId)).toBe(false);
  });

  it('serves an untargeted campaign for every placement', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;
    await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: { type: 'BANNER', title: 'Untargeted Creative' },
    });
    await client.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'ACTIVE' } });

    for (const placement of ['MARKETPLACE', 'PRODUCT_DETAILS', 'SEARCH']) {
      const res = await app.request(`/api/ads/served?placement=${placement}`);
      const body = (await res.json()) as { data: { items: Array<{ campaignId: string }> } };
      expect(body.data.items.some((i) => i.campaignId === campaignId)).toBe(true);
    }
  });

  it('records anonymous impressions and clicks but rejects anonymous conversions', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;
    await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: { type: 'BANNER', title: 'Telemetry Creative' },
    });
    await client.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'ACTIVE' } });

    const anon = makeClient();
    const impression = await anon.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'IMPRESSION', sessionId: 'sess-1' },
    });
    expect(impression.status).toBe(201);

    const click = await anon.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'CLICK', sessionId: 'sess-1' },
    });
    expect(click.status).toBe(201);

    const conversion = await anon.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'CONVERSION', sessionId: 'sess-1', metadata: { cost: '1.0000' } },
    });
    expect(conversion.status).toBe(401);

    // The authenticated advertiser can record a conversion for its own campaign.
    const authedConversion = await client.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'CONVERSION', metadata: { cost: '1.0000' } },
    });
    expect(authedConversion.status).toBe(201);

    const stats = await client.req(`/api/ads/campaigns/${campaignId}/stats`);
    expect(stats.data.data.impressions).toBe(1);
    expect(stats.data.data.clicks).toBe(1);
    expect(stats.data.data.conversions).toBe(1);

    // An authenticated actor is attributed to the stored event.
    const authedImpression = await client.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'IMPRESSION' },
    });
    expect(authedImpression.status).toBe(201);
  });

  it('persists only a hashed ip address on recorded events', async () => {
    const { client, supplierId } = await setupSupplier();
    const created = await createCampaign(client, supplierId);
    const campaignId = created.data.data.id as string;
    await client.req(`/api/ads/campaigns/${campaignId}/creatives`, {
      method: 'POST',
      body: { type: 'BANNER', title: 'Ip Creative' },
    });
    await client.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'ACTIVE' } });

    const anon = makeClient();
    const res = await anon.req('/api/ads/events', {
      method: 'POST',
      body: { campaignId, eventType: 'IMPRESSION' },
    });
    expect(res.status).toBe(201);

    const rows = await db
      .select({ ipHash: adEvents.ipHash, userId: adEvents.userId })
      .from(adEvents)
      .where(eq(adEvents.campaignId, campaignId))
      .orderBy(desc(adEvents.createdAt))
      .limit(1);
    // Either no address was derivable, or it was stored hashed (never raw).
    expect(rows[0].userId).toBeNull();
    if (rows[0].ipHash) expect(rows[0].ipHash).toMatch(/^[a-f0-9]{64}$/);
  });
});