import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { adEvents, adCreatives, campaigns } from '../src/db/schema/ads.js';
import { runAdsRecommendations } from '../src/lib/ai/endpoints.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { suppliers } from '../src/db/schema/trade.js';
import { newId } from '../src/lib/ids.js';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';

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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', { method: 'POST', body: { email, password: 'StrongPass123!', firstName: 'Ads', role } });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
}

async function insertUser(email: string, roleName: string, pass = 'StrongPass123!') {
  const id = newId();
  const passHash = await argon2.hash(pass);
  await db.insert(users).values({ id, email, passwordHash: passHash, firstName: 'Ads', isActive: true, emailVerified: true });
  const role = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: newId(), userId: id, roleId: role[0].id });
  return { id, email };
}

async function insertCampaign(overrides: { objective?: 'PRODUCT_ADS' | 'STORE_ADS'; status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' } = {}) {
  const ownerId = newId();
  await db.insert(users).values({ id: ownerId, email: `p15-ads-owner-${uniq('')}@wasit.tn`, passwordHash: 'x', isActive: true, emailVerified: true });
  const supId = newId();
  await db.insert(suppliers).values({ id: supId, userId: ownerId, companyName: `P15 Supplier ${uniq('')}`, slug: `p15-sup-${uniq('')}`, verified: true, isActive: true });
  const campaignId = newId();
  const objective = overrides.objective ?? 'PRODUCT_ADS';
  const status = overrides.status ?? 'ACTIVE';
  await db.insert(campaigns).values({
    id: campaignId,
    advertiserId: supId,
    advertiserType: 'SUPPLIER',
    title: `P15 Campaign ${uniq('')}`,
    objective,
    status,
    budget: '100.0000',
    spent: '0.0000',
    currencyCode: 'TND',
    startsAt: new Date(Date.now() - 60_000),
    isActive: status === 'ACTIVE',
  });
  return { campaignId, ownerId };
}

describe('Phase 15 — AI Ads Recommendations + Admin Ads Summary', () => {
  it('runAdsRecommendations returns a well-formed result even when no campaigns exist yet', async () => {
    const result = await runAdsRecommendations(db, 'user-x', ['CUSTOMER']);
    expect(result.kind).toBe('ADS_RECOMMENDATIONS');
    expect(result.data.bestObjective).toBe('PRODUCT_ADS');
    expect(typeof result.data.averageCtr).toBe('number');
    expect(typeof result.estimate).toBe('string');
  });

  it('runAdsRecommendations computes CTR and best objective from real ad events', async () => {
    const a = await insertCampaign({ objective: 'PRODUCT_ADS' });
    const b = await insertCampaign({ objective: 'STORE_ADS' });

    // Campaign A: 10 impressions, 5 clicks, 2 conversions (CTR 0.5)
    for (let i = 0; i < 10; i++) {
      await db.insert(adEvents).values({ id: newId(), campaignId: a.campaignId, eventType: 'IMPRESSION', sessionId: `s${i}` });
      if (i < 5) await db.insert(adEvents).values({ id: newId(), campaignId: a.campaignId, eventType: 'CLICK', sessionId: `s${i}` });
      if (i < 2) await db.insert(adEvents).values({ id: newId(), campaignId: a.campaignId, eventType: 'CONVERSION', metadata: { cost: 1 } });
    }
    // Campaign B: 10 impressions, 1 click (CTR 0.1)
    for (let i = 0; i < 10; i++) {
      await db.insert(adEvents).values({ id: newId(), campaignId: b.campaignId, eventType: 'IMPRESSION', sessionId: `s${i}` });
      if (i < 1) await db.insert(adEvents).values({ id: newId(), campaignId: b.campaignId, eventType: 'CLICK', sessionId: `s${i}` });
    }
    // Mirror what the backend's recordAdEvent does on CONVERSION: spent += cost.
    await db.update(campaigns).set({ spent: '2.0000' }).where(eq(campaigns.id, a.campaignId));

    const result = await runAdsRecommendations(db, 'user-x', ['CUSTOMER']);
    const d = result.data as Record<string, unknown>;
    // The DB is shared across test files, so we only assert properties that
    // are universally true: valid best objective, non-negative CTR in [0,1],
    // and that our conversion spend (2.0) is included in totalSpent.
    expect(['PRODUCT_ADS', 'STORE_ADS', 'SUPPLIER_ADS', 'COMPANY_ADS', 'B2B_ADS', 'B2C_ADS', 'TOP_ADS', 'SPONSORED_SEARCH']).toContain(d.bestObjective);
    expect(Number(d.averageCtr)).toBeGreaterThanOrEqual(0);
    expect(Number(d.averageCtr)).toBeLessThanOrEqual(1);
    expect(Number(d.totalSpent)).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/admin/ads/summary requires ADMIN role (403 for CUSTOMER)', async () => {
    const client = makeClient();
    await register(client, `p15-cust-${uniq('')}@wasit.tn`, 'CUSTOMER');
    const denied = await client.req('/api/admin/ads/summary');
    expect(denied.status).toBe(403);
  });

  it('GET /api/admin/ads/summary returns aggregate values for ADMIN', async () => {
    const { campaignId } = await insertCampaign({ objective: 'PRODUCT_ADS' });
    await db.insert(adEvents).values({ id: newId(), campaignId, eventType: 'IMPRESSION', sessionId: 'a1' });
    await db.insert(adEvents).values({ id: newId(), campaignId, eventType: 'IMPRESSION', sessionId: 'a2' });
    await db.insert(adEvents).values({ id: newId(), campaignId, eventType: 'CLICK', sessionId: 'a1' });

    const email = `p15-admin-${uniq('')}@wasit.tn`;
    await insertUser(email, 'ADMIN');
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });
    expect(login.status).toBe(200);
    const res = await client.req('/api/admin/ads/summary');
    expect(res.status).toBe(200);
    expect(res.data.data.campaigns).toBeGreaterThanOrEqual(1);
    expect(res.data.data.impressions).toBeGreaterThanOrEqual(2);
    expect(res.data.data.clicks).toBeGreaterThanOrEqual(1);
    expect(res.data.data.ctr).toBeTypeOf('number');
  });

  it('non-ADMIN roles (SUPPORT) cannot access /api/admin/ads/summary', async () => {
    const email = `p15-support-${uniq('')}@wasit.tn`;
    await insertUser(email, 'SUPPORT');
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });
    expect(login.status).toBe(200);
    const res = await client.req('/api/admin/ads/summary');
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/ads/campaigns lists cross-advertiser campaigns with owner info and is ADMIN-only', async () => {
    const { campaignId } = await insertCampaign({ status: 'ACTIVE' });
    const customer = makeClient();
    await register(customer, `p15-ads-list-cust-${uniq('')}@wasit.tn`, 'CUSTOMER');
    expect((await customer.req('/api/admin/ads/campaigns')).status).toBe(403);

    const email = `p15-ads-list-admin-${uniq('')}@wasit.tn`;
    await insertUser(email, 'ADMIN');
    const admin = makeClient();
    const login = await admin.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });
    expect(login.status).toBe(200);
    const res = await admin.req('/api/admin/ads/campaigns');
    expect(res.status).toBe(200);
    const row = (res.data.data.items as Array<Record<string, unknown>>).find((r) => r.id === campaignId);
    expect(row).toBeTruthy();
    expect(row!.advertiserType).toBe('SUPPLIER');
    // The polymorphic advertiser_id must resolve to a real owner for the moderation desk.
    expect(row!.advertiserName).toBeTruthy();
    expect(row!.ownerEmail).toBeTruthy();
  });

  it('ADMIN can moderate another advertiser\'s campaign (pause/resume) — regression', async () => {
    // Read endpoints already granted admins cross-advertiser scope; the write path did
    // not, so every admin PATCH returned 403 and moderation was impossible from the UI.
    const { campaignId } = await insertCampaign({ status: 'ACTIVE' });
    const email = `p15-ads-mod-admin-${uniq('')}@wasit.tn`;
    await insertUser(email, 'ADMIN');
    const admin = makeClient();
    const login = await admin.req('/api/auth/login', { method: 'POST', body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true } });
    expect(login.status).toBe(200);

    const paused = await admin.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'PAUSED' } });
    expect(paused.status).toBe(200);
    expect(paused.data.data.status).toBe('PAUSED');
    expect(paused.data.data.isActive).toBe(false);

    const resumed = await admin.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'ACTIVE' } });
    expect(resumed.status).toBe(200);
    expect(resumed.data.data.status).toBe('ACTIVE');
    expect(resumed.data.data.isActive).toBe(true);
  });

  it('a different non-admin advertiser still cannot moderate someone else\'s campaign (403)', async () => {
    const { campaignId } = await insertCampaign({ status: 'ACTIVE' });
    const other = makeClient();
    await register(other, `p15-ads-other-${uniq('')}@wasit.tn`, 'MERCHANT');
    const res = await other.req(`/api/ads/campaigns/${campaignId}`, { method: 'PATCH', body: { status: 'PAUSED' } });
    expect(res.status).toBe(403);
  });
});