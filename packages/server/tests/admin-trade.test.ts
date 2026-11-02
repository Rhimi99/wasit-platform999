import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { suppliers, merchants, companies } from '../src/db/schema/trade.js';

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

type Client = ReturnType<typeof makeClient>;

async function registerAs(
  c: Client,
  role: 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY',
): Promise<{ email: string; userId: string }> {
  const email = `it-trade-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Trade', lastName: role, role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await c.req('/api/auth/me');
  return { email, userId: me.data.data.id as string };
}

/** Creates an ADMIN through the DB (the register endpoint refuses privileged roles). */
async function makeAdminClient(): Promise<Client> {
  const id = randomUUID();
  const email = `it-trade-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'Trade',
    lastName: 'Admin',
    isActive: true,
    emailVerified: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role.id });

  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return client;
}

async function createEntity(
  client: Client,
  kind: 'suppliers' | 'merchants' | 'companies',
  name: string,
): Promise<string> {
  const body = kind === 'suppliers'
    ? { companyName: name }
    : kind === 'merchants'
      ? { storeName: name }
      : { legalName: name };
  const res = await client.req(`/api/${kind}`, { method: 'POST', body });
  expect(res.status).toBe(201);
  return res.data.data.id as string;
}

const SELLER_ROLE = { suppliers: 'SUPPLIER', merchants: 'MERCHANT', companies: 'COMPANY' } as const;

const RAW_TABLE = { suppliers, merchants, companies } as const;

/** Trade-desk audit rows only (creation events share the entityId). */
async function tradeAuditActions(entityId: string): Promise<string[]> {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
  return rows
    .filter((r) => r.action.startsWith('TRADE.'))
    .map((r) => r.action)
    .sort();
}

describe('PR-02 — admin trade desk (seller vetting)', () => {
  it('lists seller entities per kind for an admin, including inactive ones', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, 'SUPPLIER');
    const supplierName = `Desk Supplier ${Date.now()}`;
    const supplierId = await createEntity(seller, 'suppliers', supplierName);

    // Suspend it directly so the desk must surface an inactive row.
    await db.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, supplierId));

    const res = await admin.req(`/api/admin/trade/suppliers?q=${encodeURIComponent(supplierName)}&pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const row = (res.data.data.items as Array<{ id: string; isActive: boolean; kind: string }>).find((r) => r.id === supplierId);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
    expect(row!.kind).toBe('suppliers');
  });

  it('verifies a supplier and records an audit entry, and the directory reflects it', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, 'SUPPLIER');
    const supplierName = `Verify Supplier ${Date.now()}`;
    const supplierId = await createEntity(seller, 'suppliers', supplierName);

    const res = await admin.req(`/api/admin/trade/suppliers/${supplierId}`, {
      method: 'PATCH',
      body: { verified: true },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.verified).toBe(true);

    // The badge the public directory reads is now true. Query by name: the demo
    // DB is shared across suites, so the row may not be on page 1 by pageSize alone.
    const dir = await admin.req(`/api/directory/suppliers?q=${encodeURIComponent(supplierName)}`);
    expect(dir.status).toBe(200);
    const dirRow = (dir.data.data.items as Array<{ id: string; verified: boolean }>).find((r) => r.id === supplierId);
    expect(dirRow?.verified).toBe(true);

    expect(await tradeAuditActions(supplierId)).toEqual(['TRADE.VERIFIED']);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, supplierId), eq(auditLogs.action, 'TRADE.VERIFIED')))
      .limit(1);
    expect(audit.entityType).toBe('SUPPLIER');
    expect(audit.before).toEqual({ verified: false, isActive: true });
    expect(audit.after).toEqual({ verified: true, isActive: true });
  });

  it('suspends and reactivates a merchant, removing it from the public directory while suspended', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, 'MERCHANT');
    const merchantName = `Suspend Merchant ${Date.now()}`;
    const merchantId = await createEntity(seller, 'merchants', merchantName);

    const suspended = await admin.req(`/api/admin/trade/merchants/${merchantId}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.data.data.isActive).toBe(false);

    const dir = await admin.req(`/api/directory/merchants?q=${encodeURIComponent(merchantName)}`);
    expect(dir.status).toBe(200);
    expect((dir.data.data.items as Array<{ id: string }>).some((r) => r.id === merchantId)).toBe(false);

    expect(await tradeAuditActions(merchantId)).toEqual(['TRADE.SUSPENDED']);

    const reactivated = await admin.req(`/api/admin/trade/merchants/${merchantId}`, {
      method: 'PATCH',
      body: { isActive: true },
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.data.data.isActive).toBe(true);

    const dirAfter = await admin.req(`/api/directory/merchants?q=${encodeURIComponent(merchantName)}`);
    expect((dirAfter.data.data.items as Array<{ id: string }>).some((r) => r.id === merchantId)).toBe(true);
  });

  it('lets an admin vet a company too (kind is not limited to one table)', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, 'COMPANY');
    const companyId = await createEntity(seller, 'companies', `Desk Company ${Date.now()}`);

    const res = await admin.req(`/api/admin/trade/companies/${companyId}`, {
      method: 'PATCH',
      body: { verified: true, isActive: true },
    });
    expect(res.status).toBe(200);
    expect(res.data.data).toMatchObject({ id: companyId, verified: true, isActive: true });

    expect(await tradeAuditActions(companyId)).toEqual(['TRADE.VERIFIED']);
  });

  it('blocks a non-admin seller from every trade desk route, even for its own entity', async () => {
    const seller = makeClient();
    await registerAs(seller, 'SUPPLIER');
    const supplierId = await createEntity(seller, 'suppliers', `Forbidden Supplier ${Date.now()}`);

    const list = await seller.req('/api/admin/trade/suppliers');
    expect(list.status).toBe(403);
    const patch = await seller.req(`/api/admin/trade/suppliers/${supplierId}`, {
      method: 'PATCH',
      body: { verified: true },
    });
    expect(patch.status).toBe(403);

    // The refusal is enforced, not merely hidden: the flag is unchanged.
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    expect(row.verified).toBe(false);
  });

  it('refuses each seller role its own kind, closing the self-verification trap', async () => {
    // SUPPLIER, MERCHANT and COMPANY each hold their own `*_UPDATE` permission, so a
    // permission-only guard would let a seller verify or suspend itself. The role
    // gate must refuse all three, and the flag must stay untouched.
    const cases = [
      { kind: 'suppliers', role: 'SUPPLIER' },
      { kind: 'merchants', role: 'MERCHANT' },
      { kind: 'companies', role: 'COMPANY' },
    ] as const;

    for (const { kind, role } of cases) {
      const seller = makeClient();
      await registerAs(seller, role);
      const entityId = await createEntity(seller, kind, `Self ${role} ${Date.now()}`);

      const patch = await seller.req(`/api/admin/trade/${kind}/${entityId}`, {
        method: 'PATCH',
        body: { verified: true },
      });
      expect(patch.status).toBe(403);
      expect((await seller.req(`/api/admin/trade/${kind}`)).status).toBe(403);

      const [row] = await db.select().from(RAW_TABLE[kind]).where(eq(RAW_TABLE[kind].id, entityId)).limit(1);
      expect(row.verified).toBe(false);
    }
  });

  it('blocks an anonymous caller with 401', async () => {
    const anon = makeClient();
    const res = await anon.req('/api/admin/trade/suppliers');
    expect(res.status).toBe(401);
  });

  it('rejects an update with no flags (422) and an unknown entity (404)', async () => {
    const admin = await makeAdminClient();

    const noFlags = await admin.req(`/api/admin/trade/suppliers/${randomUUID()}`, {
      method: 'PATCH',
      body: {},
    });
    expect(noFlags.status).toBe(422);

    const missing = await admin.req(`/api/admin/trade/suppliers/${randomUUID()}`, {
      method: 'PATCH',
      body: { verified: true },
    });
    expect(missing.status).toBe(404);
  });

  it('rejects a non-boolean flag with 422', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, 'SUPPLIER');
    const supplierId = await createEntity(seller, 'suppliers', `BadFlag Supplier ${Date.now()}`);

    const res = await admin.req(`/api/admin/trade/suppliers/${supplierId}`, {
      method: 'PATCH',
      body: { verified: 'yes' },
    });
    expect(res.status).toBe(422);
  });

  it('records STATUS_UNCHANGED when a retry sends the value already stored', async () => {
    const admin = await makeAdminClient();
    const seller = makeClient();
    await registerAs(seller, SELLER_ROLE.merchants);
    const merchantId = await createEntity(seller, 'merchants', `Idempotent Merchant ${Date.now()}`);

    await admin.req(`/api/admin/trade/merchants/${merchantId}`, { method: 'PATCH', body: { verified: true } });
    await admin.req(`/api/admin/trade/merchants/${merchantId}`, { method: 'PATCH', body: { verified: true } });

    expect(await tradeAuditActions(merchantId)).toEqual(['TRADE.STATUS_UNCHANGED', 'TRADE.VERIFIED']);
  });
});
