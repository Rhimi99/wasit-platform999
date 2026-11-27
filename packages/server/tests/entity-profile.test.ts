import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { companies, merchants, suppliers } from '../src/db/schema/trade.js';

/**
 * ENTITY-01 — a party can read and edit its own entity profile, and nothing else.
 *
 * The suite pins the four properties the feature exists for:
 *  1. the row is resolved from the authenticated user, never from the payload;
 *  2. the editable surface is an allow-list per entity type (the three tables
 *     do not share column names);
 *  3. verification, activation, ownership and legal identifiers are refused
 *     with a 422 instead of being silently dropped;
 *  4. every accepted change lands in `audit_logs` with before/after.
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

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function registerRole(role: 'CUSTOMER' | 'MERCHANT' | 'SUPPLIER' | 'COMPANY') {
  const client = makeClient();
  const email = `entity01-${role.toLowerCase()}-${stamp()}@wasit.tn`;
  const r = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'EN', role },
  });
  expect(r.status, `register ${role}`).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status, `login ${role}`).toBe(200);
  const me = await client.req('/api/auth/me');
  return { client, userId: me.data.data.id as string, email };
}

async function createEntity(
  client: ReturnType<typeof makeClient>,
  type: 'MERCHANT' | 'SUPPLIER' | 'COMPANY',
  name: string,
) {
  const path = type === 'MERCHANT' ? '/api/merchants' : type === 'SUPPLIER' ? '/api/suppliers' : '/api/companies';
  const field = type === 'MERCHANT' ? 'storeName' : type === 'SUPPLIER' ? 'companyName' : 'legalName';
  const res = await client.req(path, { method: 'POST', body: { [field]: name } });
  expect(res.status, `create ${type}`).toBe(201);
  return res.data.data.id as string;
}

describe('ENTITY-01 — reading your own entity profiles', () => {
  it('requires authentication', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/entities/me')).status).toBe(401);
  });

  it('returns nulls for an account that owns no entity, and never leaks userId', async () => {
    const customer = await registerRole('CUSTOMER');
    const res = await customer.client.req('/api/entities/me');
    expect(res.status).toBe(200);
    expect(res.data.data).toEqual({ merchant: null, supplier: null, company: null });
  });

  it('returns the caller’s own profile with its type-specific fields', async () => {
    const merchant = await registerRole('MERCHANT');
    await createEntity(merchant.client, 'MERCHANT', `Store ${stamp()}`);

    const res = await merchant.client.req('/api/entities/me');
    expect(res.status).toBe(200);
    expect(res.data.data.merchant.type).toBe('merchant');
    expect(res.data.data.merchant.storeName).toContain('Store');
    expect(res.data.data.merchant.verified).toBe(false);
    expect(res.data.data.merchant.isActive).toBe(true);
    expect(res.data.data.merchant.userId).toBeUndefined();
    expect(res.data.data.supplier).toBeNull();
  });
});

describe('ENTITY-01 — editing your own profile', () => {
  it('merchant updates the commercial fields it owns', async () => {
    const merchant = await registerRole('MERCHANT');
    const id = await createEntity(merchant.client, 'MERCHANT', `Store ${stamp()}`);

    const res = await merchant.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { storeName: 'Renamed Store', description: 'Fresh description', cityId: 'city-1' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.changed).toBe(true);
    expect(res.data.data.entity.storeName).toBe('Renamed Store');

    const [row] = await db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    expect(row.storeName).toBe('Renamed Store');
    expect(row.description).toBe('Fresh description');
    expect(row.cityId).toBe('city-1');
  });

  it('supplier updates its own profile through both the self and addressed routes', async () => {
    const supplier = await registerRole('SUPPLIER');
    const id = await createEntity(supplier.client, 'SUPPLIER', `Supplier ${stamp()}`);

    const self = await supplier.client.req('/api/entities/supplier/me', {
      method: 'PATCH',
      body: { companyName: 'Supplier Renamed', industry: 'ignored-on-supplier' },
    });
    // `industry` is a company column: unknown keys are refused, not dropped.
    expect(self.status).toBe(422);

    const ok = await supplier.client.req('/api/entities/supplier/me', {
      method: 'PATCH',
      body: { companyName: 'Supplier Renamed', description: 'Wholesale parts' },
    });
    expect(ok.status).toBe(200);
    expect(ok.data.data.entity.companyName).toBe('Supplier Renamed');

    const addressed = await supplier.client.req(`/api/suppliers/${id}`, {
      method: 'PATCH',
      body: { cityId: 'city-9' },
    });
    expect(addressed.status).toBe(200);
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    expect(row.companyName).toBe('Supplier Renamed');
    expect(row.cityId).toBe('city-9');
  });

  it('company updates its own profile', async () => {
    const company = await registerRole('COMPANY');
    const id = await createEntity(company.client, 'COMPANY', `Company ${stamp()}`);

    const res = await company.client.req('/api/entities/company/me', {
      method: 'PATCH',
      body: { legalName: 'Global Industries SA', industry: 'Manufacturing' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.entity.legalName).toBe('Global Industries SA');
    expect(res.data.data.entity.industry).toBe('Manufacturing');

    const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
    expect(row.legalName).toBe('Global Industries SA');
  });

  it('a no-op patch reports changed:false and writes no audit row', async () => {
    const merchant = await registerRole('MERCHANT');
    const name = `Same ${stamp()}`;
    const id = await createEntity(merchant.client, 'MERCHANT', name);

    const res = await merchant.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { storeName: name },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.changed).toBe(false);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'ENTITY.UPDATE')));
    expect(rows).toHaveLength(0);
  });
});

describe('ENTITY-01 — protected fields are refused', () => {
  const cases: Array<{ type: 'MERCHANT' | 'COMPANY'; body: Record<string, unknown>; field: string }> = [
    { type: 'MERCHANT', body: { verified: true }, field: 'verified' },
    { type: 'MERCHANT', body: { isActive: false }, field: 'isActive' },
    { type: 'MERCHANT', body: { slug: 'hijacked-slug' }, field: 'slug' },
    { type: 'MERCHANT', body: { userId: 'someone-else' }, field: 'userId' },
    { type: 'COMPANY', body: { registrationNumber: 'RC-999' }, field: 'registrationNumber' },
    { type: 'COMPANY', body: { taxId: 'TAX-999' }, field: 'taxId' },
  ];

  for (const testCase of cases) {
    it(`${testCase.type}: ${testCase.field} is a 422 and the row is untouched`, async () => {
      const owner = await registerRole(testCase.type);
      const id = await createEntity(owner.client, testCase.type, `Guard ${stamp()}`);
      const table = testCase.type === 'MERCHANT' ? merchants : companies;
      const [before] = await db.select().from(table).where(eq(table.id, id)).limit(1);

      const path = testCase.type === 'MERCHANT' ? '/api/entities/merchant/me' : '/api/entities/company/me';
      const res = await owner.client.req(path, { method: 'PATCH', body: testCase.body });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.data.error)).toContain(testCase.field);

      const [after] = await db.select().from(table).where(eq(table.id, id)).limit(1);
      expect(after).toEqual(before);
    });
  }

  it('rejects an empty name instead of storing it', async () => {
    const merchant = await registerRole('MERCHANT');
    await createEntity(merchant.client, 'MERCHANT', `Valid ${stamp()}`);
    const res = await merchant.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { storeName: '' },
    });
    expect(res.status).toBe(422);
  });
});

describe('ENTITY-01 — isolation and ownership', () => {
  it('one merchant cannot touch another merchant’s row', async () => {
    const a = await registerRole('MERCHANT');
    const b = await registerRole('MERCHANT');
    const aId = await createEntity(a.client, 'MERCHANT', `A ${stamp()}`);
    const bId = await createEntity(b.client, 'MERCHANT', `B ${stamp()}`);

    const foreign = await a.client.req(`/api/merchants/${bId}`, {
      method: 'PATCH',
      body: { storeName: 'Hijacked' },
    });
    expect(foreign.status).toBe(403);

    const [bRow] = await db.select().from(merchants).where(eq(merchants.id, bId)).limit(1);
    expect(bRow.storeName).toContain('B ');
    expect(aId).not.toBe(bId);
  });

  it('one company cannot touch another company’s row', async () => {
    const a = await registerRole('COMPANY');
    const b = await registerRole('COMPANY');
    const bId = await createEntity(b.client, 'COMPANY', `B ${stamp()}`);

    const foreign = await a.client.req(`/api/companies/${bId}`, {
      method: 'PATCH',
      body: { legalName: 'Hijacked SA' },
    });
    expect(foreign.status).toBe(403);
    const [row] = await db.select().from(companies).where(eq(companies.id, bId)).limit(1);
    expect(row.legalName).toContain('B ');
  });

  it('each account only sees its own entity', async () => {
    const a = await registerRole('MERCHANT');
    const b = await registerRole('MERCHANT');
    await createEntity(a.client, 'MERCHANT', `OnlyA ${stamp()}`);
    await createEntity(b.client, 'MERCHANT', `OnlyB ${stamp()}`);

    const mineA = await a.client.req('/api/entities/me');
    const mineB = await b.client.req('/api/entities/me');
    expect(mineA.data.data.merchant.storeName).toContain('OnlyA');
    expect(mineB.data.data.merchant.storeName).toContain('OnlyB');
    expect(mineA.data.data.merchant.id).not.toBe(mineB.data.data.merchant.id);
  });

  it('a role cannot write a profile type it does not own', async () => {
    const supplier = await registerRole('SUPPLIER');
    await createEntity(supplier.client, 'SUPPLIER', `S ${stamp()}`);
    const res = await supplier.client.req('/api/entities/company/me', {
      method: 'PATCH',
      body: { legalName: 'Not Mine SA' },
    });
    expect(res.status).toBe(403);
  });

  it('a customer without the permission is refused before any row is touched', async () => {
    const customer = await registerRole('CUSTOMER');
    const res = await customer.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { storeName: 'Ghost Store' },
    });
    expect(res.status).toBe(403);
  });

  it('a merchant account without a profile gets a 404 and no row is created', async () => {
    const merchant = await registerRole('MERCHANT');
    const res = await merchant.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { storeName: 'Ghost Store' },
    });
    expect(res.status).toBe(404);
    const rows = await db.select().from(merchants).where(eq(merchants.storeName, 'Ghost Store'));
    expect(rows).toHaveLength(0);
  });
});

describe('ENTITY-01 — audit trail', () => {
  it('records actor, entity and only the changed fields', async () => {
    const merchant = await registerRole('MERCHANT');
    const id = await createEntity(merchant.client, 'MERCHANT', `Audited ${stamp()}`);

    const res = await merchant.client.req('/api/entities/merchant/me', {
      method: 'PATCH',
      body: { description: 'audited change', logoUrl: null },
    });
    expect(res.status).toBe(200);

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'ENTITY.UPDATE')))
      .limit(1);
    expect(entry).toBeTruthy();
    expect(entry.actorId).toBe(merchant.userId);
    expect(entry.entityType).toBe('MERCHANT');
    expect(entry.before).toEqual({ description: null });
    expect(entry.after).toEqual({ description: 'audited change' });
    expect(entry.metadata).toMatchObject({ fields: ['description'], source: 'self-service' });
  });
});
