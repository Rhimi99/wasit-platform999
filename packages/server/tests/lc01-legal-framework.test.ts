import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, consents } from '../src/db/schema/auth.js';
import { consentEvents } from '../src/db/schema/privacy.js';
import { auditLogs } from '../src/db/schema/audit.js';
import {
  LEGAL_DOCUMENTS,
  findLegalDocument,
  publishedDocuments,
  isAcceptable,
  needsReacceptance,
  type LegalDocumentEntry,
} from '../src/lib/legal/catalogue.js';
import {
  recordLegalAcceptance,
  getAcceptedVersions,
  getPendingLegalAcceptances,
  listLegalAcceptances,
} from '../src/modules/privacy/service.js';
import { pendingForAcceptance } from '../src/modules/legal/enforcement.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  await resetRateLimitStore();
});

function makeClient(ip = `198.51.100.${Math.floor(Math.random() * 200 + 1)}`) {
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
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createUser(prefix: string) {
  const id = randomUUID();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const passwordHash = await argon2.hash('Passw0rd!Secure');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: prefix,
    lastName: 'Original',
    emailVerified: true,
    isActive: true,
  });
  return { id, email, password: 'Passw0rd!Secure' };
}

async function loginClient(user: { email: string; password: string }) {
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  return client;
}

/** A synthetic *published* entry, to exercise the acceptance path end-to-end. */
function publishedEntry(overrides: Partial<LegalDocumentEntry> = {}): LegalDocumentEntry {
  return {
    code: 'TERMS_OF_SERVICE',
    audience: 'ALL',
    title: { ar: 'شروط الخدمة', en: 'Terms of Service' },
    summary: { ar: 'x', en: 'x' },
    version: '1.0.0',
    effectiveDate: '2026-01-01T00:00:00.000Z',
    status: 'PUBLISHED',
    consentType: 'TERMS',
    acceptanceRequired: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Catalogue (pure)
// ---------------------------------------------------------------------------
describe('LC-01 — legal catalogue (pure)', () => {
  it('covers the nine required artefacts', () => {
    const codes = LEGAL_DOCUMENTS.map((d) => d.code);
    for (const required of [
      'TERMS_OF_SERVICE',
      'PRIVACY_POLICY',
      'COOKIE_POLICY',
      'REFUND_DISPUTE_POLICY',
      'BUYER_TERMS',
      'SELLER_MERCHANT_TERMS',
      'SUPPLIER_TERMS',
      'DATA_PROCESSING_AGREEMENT',
      'PROHIBITED_GOODS_POLICY',
    ]) {
      expect(codes).toContain(required);
    }
  });

  it('ships every document unpublished — nothing is in force before review', () => {
    for (const d of LEGAL_DOCUMENTS) {
      expect(d.status).toBe('LEGAL_REVIEW_REQUIRED');
      expect(d.effectiveDate).toBeNull();
    }
    expect(publishedDocuments()).toEqual([]);
  });

  it('never discloses or accepts an unpublished draft', () => {
    for (const d of LEGAL_DOCUMENTS) {
      expect(isAcceptable(d)).toBe(false);
    }
    expect(findLegalDocument('NOT_A_DOCUMENT')).toBeNull();
  });

  it('acceptability requires published + effective + acceptance-required', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(isAcceptable(publishedEntry(), now)).toBe(true);
    // Future effective date is not yet in force.
    expect(isAcceptable(publishedEntry({ effectiveDate: '2026-12-01T00:00:00.000Z' }), now)).toBe(false);
    // Not published.
    expect(isAcceptable(publishedEntry({ status: 'APPROVED' }), now)).toBe(false);
    // No acceptance obligation.
    expect(isAcceptable(publishedEntry({ acceptanceRequired: false }), now)).toBe(false);
  });

  it('flags re-acceptance on a missing or stale version only when published', () => {
    expect(needsReacceptance(publishedEntry(), null)).toBe(true);
    expect(needsReacceptance(publishedEntry(), '0.9.0')).toBe(true);
    expect(needsReacceptance(publishedEntry(), '1.0.0')).toBe(false);
    expect(needsReacceptance(publishedEntry({ status: 'APPROVED' }), null)).toBe(false);
    expect(needsReacceptance(publishedEntry({ acceptanceRequired: false }), null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Public surface — published documents only
// ---------------------------------------------------------------------------
describe('LC-01 — public legal surface', () => {
  it('returns an empty published index while nothing is approved', async () => {
    const client = makeClient();
    const { status, data } = await client.req('/api/public/legal/documents');
    expect(status).toBe(200);
    expect((data as { data: { items: unknown[] } }).data.items).toEqual([]);
  });

  it('does not disclose an unpublished draft (404, not a leak)', async () => {
    const client = makeClient();
    const { status } = await client.req('/api/public/legal/documents/TERMS_OF_SERVICE');
    expect(status).toBe(404);
  });

  it('serves no user data on the public index', async () => {
    const client = makeClient();
    const res = await client.req('/api/public/legal/documents');
    const body = JSON.stringify(res.data);
    expect(body).not.toMatch(/@wasit\.tn|email|passwordHash|userId/i);
  });
});

// ---------------------------------------------------------------------------
// Authenticated acceptance state
// ---------------------------------------------------------------------------
describe('LC-01 — acceptance state', () => {
  it('requires a session', async () => {
    const client = makeClient();
    const { status } = await client.req('/api/legal/acceptances/me');
    expect(status).toBe(401);
  });

  it('reports no pending acceptances while nothing is published', async () => {
    const user = await createUser('lc01-state');
    const client = await loginClient(user);
    const { status, data } = await client.req('/api/legal/acceptances/me');
    expect(status).toBe(200);
    const d = (data as { data: { pendingAcceptances: unknown[]; inForce: unknown[] } }).data;
    expect(d.pendingAcceptances).toEqual([]);
    expect(d.inForce).toEqual([]);
  });

  it('refuses acceptance of an unpublished document (409)', async () => {
    const user = await createUser('lc01-refuse');
    const client = await loginClient(user);
    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'TERMS_OF_SERVICE', version: '0.0.0-draft' },
    });
    expect(status).toBe(409);
  });

  it('refuses acceptance of an unknown document (409)', async () => {
    const user = await createUser('lc01-unknown');
    const client = await loginClient(user);
    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'MADE_UP', version: '1' },
    });
    expect(status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Version-pinned acceptance + re-acceptance (service, synthetic published doc)
// ---------------------------------------------------------------------------
describe('LC-01 — version-pinned acceptance', () => {
  it('records the accepted version, audit and consent history', async () => {
    const user = await createUser('lc01-accept');
    const catalogue = [publishedEntry()];
    const result = await recordLegalAcceptance(
      db,
      { userId: user.id, actorId: user.id, ipAddress: '203.0.113.9', userAgent: 'vitest' },
      { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', locale: 'ar' },
      catalogue,
    );
    expect(result.version).toBe('1.0.0');

    const versions = await getAcceptedVersions(db, user.id);
    expect(versions.TERMS_OF_SERVICE).toBe('1.0.0');

    const events = await db
      .select({ action: consentEvents.action, metadata: consentEvents.metadata })
      .from(consentEvents)
      .where(and(eq(consentEvents.userId, user.id), eq(consentEvents.consentType, 'LEGAL_DOCUMENT')));
    expect(events.length).toBe(1);
    expect((events[0].metadata as Record<string, unknown>).version).toBe('1.0.0');

    const audit = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'LEGAL.DOCUMENT_ACCEPTED'), eq(auditLogs.entityId, user.id)));
    expect(audit.length).toBe(1);
  });

  it('clears a pending acceptance once accepted, and re-demands on a version bump', async () => {
    const user = await createUser('lc01-pending');
    const v1 = [publishedEntry({ version: '1.0.0' })];
    expect((await getPendingLegalAcceptances(db, user.id, v1, ['CUSTOMER'])).map((p) => p.code)).toEqual(['TERMS_OF_SERVICE']);

    await recordLegalAcceptance(
      db,
      { userId: user.id, actorId: user.id },
      { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0' },
      v1,
    );
    expect(await getPendingLegalAcceptances(db, user.id, v1, ['CUSTOMER'])).toEqual([]);

    // Bump the in-force version: the old acceptance is stale and must be re-asked.
    const v2 = [publishedEntry({ version: '2.0.0' })];
    const pending = await getPendingLegalAcceptances(db, user.id, v2, ['CUSTOMER']);
    expect(pending.map((p) => p.code)).toEqual(['TERMS_OF_SERVICE']);
    expect(pending[0].version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// Audience scoping against the real database path (H1)
// ---------------------------------------------------------------------------
describe('LC-01.1 — audience-scoped pending (database path)', () => {
  const mixedCatalogue = (): LegalDocumentEntry[] => [
    publishedEntry({ code: 'TERMS_OF_SERVICE', audience: 'ALL', consentType: 'TERMS' }),
    publishedEntry({ code: 'BUYER_TERMS', audience: 'BUYER', consentType: null }),
    publishedEntry({ code: 'SELLER_MERCHANT_TERMS', audience: 'SELLER', consentType: null }),
    publishedEntry({ code: 'SUPPLIER_TERMS', audience: 'SUPPLIER', consentType: null }),
    publishedEntry({ code: 'COMPANY_TERMS', audience: 'COMPANY', consentType: null }),
  ];

  it('a CUSTOMER is asked only for ALL + BUYER terms', async () => {
    const user = await createUser('lc01-aud-cust');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['CUSTOMER']);
    expect(pending.map((p) => p.code).sort()).toEqual(['BUYER_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a MERCHANT is asked only for ALL + its seller terms', async () => {
    const user = await createUser('lc01-aud-merch');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['MERCHANT']);
    expect(pending.map((p) => p.code).sort()).toEqual(['SELLER_MERCHANT_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a SUPPLIER is asked only for ALL + its supplier terms', async () => {
    const user = await createUser('lc01-aud-supp');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['SUPPLIER']);
    expect(pending.map((p) => p.code).sort()).toEqual(['SUPPLIER_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a COMPANY is asked only for ALL + its company terms', async () => {
    const user = await createUser('lc01-aud-co');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['COMPANY']);
    expect(pending.map((p) => p.code).sort()).toEqual(['COMPANY_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a multi-role user gets the union, without duplicates', async () => {
    const user = await createUser('lc01-aud-multi');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['CUSTOMER', 'MERCHANT']);
    const codes = pending.map((p) => p.code).sort();
    expect(codes).toEqual(['BUYER_TERMS', 'SELLER_MERCHANT_TERMS', 'TERMS_OF_SERVICE']);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('a staff role is asked only for ALL documents', async () => {
    const user = await createUser('lc01-aud-admin');
    const pending = await getPendingLegalAcceptances(db, user.id, mixedCatalogue(), ['ADMIN']);
    expect(pending.map((p) => p.code)).toEqual(['TERMS_OF_SERVICE']);
  });

  it('the gate and the pending service agree for the same user and catalogue', async () => {
    const user = await createUser('lc01-aud-agree');
    const catalogue = mixedCatalogue();
    for (const roles of [['CUSTOMER'], ['MERCHANT'], ['SUPPLIER'], ['COMPANY'], ['ADMIN'], ['CUSTOMER', 'SUPPLIER']]) {
      const accepted = await getAcceptedVersions(db, user.id);
      const fromGate = pendingForAcceptance(catalogue, accepted, roles).map((d) => d.code).sort();
      const fromService = (await getPendingLegalAcceptances(db, user.id, catalogue, roles)).map((p) => p.code).sort();
      expect(fromService, roles.join('+')).toEqual(fromGate);
    }
  });
});

// ---------------------------------------------------------------------------
// Rectification (right to correct)
// ---------------------------------------------------------------------------
describe('LC-01 — rectification', () => {
  it('requires a session', async () => {
    const client = makeClient();
    const { status } = await client.req('/api/privacy/me', { method: 'PATCH', body: { firstName: 'X' } });
    expect(status).toBe(401);
  });

  it('corrects whitelisted fields and audits field names only', async () => {
    const user = await createUser('lc01-rectify');
    const client = await loginClient(user);
    const { status, data } = await client.req('/api/privacy/me', {
      method: 'PATCH',
      body: { firstName: 'Corrected', displayName: 'Public Name' },
    });
    expect(status).toBe(200);
    expect((data as { data: { changed: string[] } }).data.changed).toEqual(
      expect.arrayContaining(['firstName', 'displayName']),
    );

    const [row] = await db
      .select({ firstName: users.firstName, email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(row.firstName).toBe('Corrected');
    expect(row.email).toBe(user.email);

    const audit = await db
      .select({ after: auditLogs.after })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'PRIVACY.RECTIFICATION'), eq(auditLogs.entityId, user.id)));
    expect(audit.length).toBe(1);
    // The audit records which fields changed, never the values themselves.
    expect(JSON.stringify(audit[0].after)).not.toContain('Corrected');
  });

  it('cannot change email or verification through rectification', async () => {
    const user = await createUser('lc01-email');
    const client = await loginClient(user);
    const { status } = await client.req('/api/privacy/me', {
      method: 'PATCH',
      body: { email: 'attacker@evil.example', emailVerified: false, firstName: 'Still Fine' },
    });
    expect(status).toBe(200);
    const [row] = await db
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    expect(row.email).toBe(user.email);
    expect(row.emailVerified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consent separation (cookies ≠ terms ≠ marketing)
// ---------------------------------------------------------------------------
describe('LC-01 — consent separation', () => {
  it('keeps cookie, terms and marketing consents independent', async () => {
    const user = await createUser('lc01-consent');
    const client = await loginClient(user);
    const put = (consentType: string, granted: boolean) =>
      client.req('/api/privacy/consents', { method: 'PUT', body: { consentType, granted } });

    expect((await put('COOKIE_POLICY', true)).status).toBe(200);
    expect((await put('MARKETING', false)).status).toBe(200);

    const rows = await db
      .select({ consentType: consents.consentType, granted: consents.granted })
      .from(consents)
      .where(eq(consents.userId, user.id));
    const byType = new Map(rows.map((r) => [r.consentType, r.granted]));
    expect(byType.get('COOKIE_POLICY')).toBe(true);
    expect(byType.get('MARKETING')).toBe(false);
    // Granting the cookie policy consent must not imply acceptance of the terms.
    expect(byType.get('TERMS')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LC-01.1 — consent infrastructure (history, anti-forgery, isolation)
// ---------------------------------------------------------------------------
describe('LC-01.1 — acceptance history API', () => {
  it('requires a session', async () => {
    const { status } = await makeClient().req('/api/legal/acceptances/history');
    expect(status).toBe(401);
  });

  it('returns the caller\'s own acceptances newest-first with version and time', async () => {
    const user = await createUser('lc011-history');
    await recordLegalAcceptance(
      db,
      { userId: user.id, actorId: user.id },
      { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', locale: 'ar' },
      [publishedEntry({ version: '1.0.0' })],
    );
    await recordLegalAcceptance(
      db,
      { userId: user.id, actorId: user.id },
      { documentCode: 'TERMS_OF_SERVICE', version: '2.0.0', locale: 'fr' },
      [publishedEntry({ version: '2.0.0' })],
    );

    const client = await loginClient(user);
    const { status, data } = await client.req('/api/legal/acceptances/history');
    expect(status).toBe(200);
    const items = (data as { data: { items: Array<{ documentCode: string; version: string; acceptedAt: string | null; locale: string | null }> } }).data.items;
    expect(items).toHaveLength(2);
    expect(items[0].version).toBe('2.0.0');
    expect(items[1].version).toBe('1.0.0');
    expect(items[0].locale).toBe('fr');
    expect(typeof items[0].acceptedAt).toBe('string');
    expect(Number.isNaN(Date.parse(items[0].acceptedAt as string))).toBe(false);
  });

  it('never returns another user\'s acceptances (isolation)', async () => {
    const a = await createUser('lc011-iso-a');
    const b = await createUser('lc011-iso-b');
    await recordLegalAcceptance(db, { userId: a.id, actorId: a.id }, { documentCode: 'TERMS_OF_SERVICE', version: '9.9.9' }, [
      publishedEntry({ version: '9.9.9' }),
    ]);

    const clientB = await loginClient(b);
    const history = await clientB.req('/api/legal/acceptances/history');
    expect((history.data as { data: { items: unknown[] } }).data.items).toEqual([]);

    const state = await clientB.req('/api/legal/acceptances/me');
    const versions = (state.data as { data: { acceptedVersions: Record<string, string> } }).data.acceptedVersions;
    expect(versions.TERMS_OF_SERVICE).toBeUndefined();
  });
});

describe('LC-01.1 — anti-forgery', () => {
  it('rejects an acceptance that tries to name another user (strict body, 422)', async () => {
    const victim = await createUser('lc011-victim');
    const attacker = await createUser('lc011-attacker');
    const client = await loginClient(attacker);

    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', userId: victim.id },
    });
    expect(status).toBe(422);

    // Nothing was recorded for the victim, and nothing for the attacker either.
    expect(await getAcceptedVersions(db, victim.id)).toEqual({});
    expect(await getAcceptedVersions(db, attacker.id)).toEqual({});
  });

  it('records only against the session user, never a body-supplied identity', async () => {
    const victim = await createUser('lc011-victim2');
    const attacker = await createUser('lc011-attacker2');
    // The strict schema rejects an unknown key outright, so the attacker cannot
    // even reach the service with a forged identity.
    const client = await loginClient(attacker);
    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', actorId: victim.id },
    });
    expect(status).toBe(422);
    expect(await getAcceptedVersions(db, victim.id)).toEqual({});
  });
});

describe('LC-01.1 — enforcement stays inert on drafts', () => {
  it('does not block registration or login while enforcement is off', async () => {
    const email = `lc011-reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
    const client = makeClient();
    const reg = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'Passw0rd!Secure', firstName: 'Reg', lastName: 'User', role: 'CUSTOMER' },
    });
    expect([200, 201]).toContain(reg.status);

    // Login may still be refused for *unrelated* reasons (the suite runs with
    // mandatory email verification), but never by the legal gate. The precise
    // claim is that the legal gate is not the blocker.
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'Passw0rd!Secure' } });
    const code = (login.data as { error?: { code?: string } } | null)?.error?.code;
    expect(code).not.toBe('LEGAL_ACCEPTANCE_REQUIRED');

    // And a verified account signs in normally with the gate off.
    const verified = await createUser('lc011-login-ok');
    const verifiedClient = await loginClient(verified);
    expect((await verifiedClient.req('/api/legal/acceptances/me')).status).toBe(200);
  });

  it('does not block ordinary authenticated requests while only drafts exist', async () => {
    const user = await createUser('lc011-noblock');
    const client = await loginClient(user);
    // `/api/legal/acceptances/me` is exempt anyway; use a normal product surface.
    const { status } = await client.req('/api/privacy/me');
    expect(status).toBe(200);
    // And the legal state itself reports nothing pending, since nothing is published.
    const state = await client.req('/api/legal/acceptances/me');
    expect((state.data as { data: { pendingAcceptances: unknown[] } }).data.pendingAcceptances).toEqual([]);
  });
});

describe('LC-01.1 — separation from cookie/marketing consents', () => {
  it('a legal acceptance does not grant cookie or marketing consent, and vice versa', async () => {
    const user = await createUser('lc011-separation');
    await recordLegalAcceptance(db, { userId: user.id, actorId: user.id }, { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0' }, [
      publishedEntry({ version: '1.0.0' }),
    ]);

    const rows = await db
      .select({ consentType: consents.consentType, granted: consents.granted })
      .from(consents)
      .where(eq(consents.userId, user.id));
    const byType = new Map(rows.map((r) => [r.consentType, r.granted]));
    // Accepting terms mirrors the TERMS consent only.
    expect(byType.get('TERMS')).toBe(true);
    expect(byType.get('COOKIE_POLICY')).toBeUndefined();
    expect(byType.get('MARKETING')).toBeUndefined();

    // And a marketing revoke must not disturb the recorded legal acceptance.
    const client = await loginClient(user);
    await client.req('/api/privacy/consents', { method: 'PUT', body: { consentType: 'MARKETING', granted: true } });
    expect((await getAcceptedVersions(db, user.id)).TERMS_OF_SERVICE).toBe('1.0.0');
  });

  it('listLegalAcceptances returns only LEGAL_DOCUMENT rows, not other consents', async () => {
    const user = await createUser('lc011-only-legal');
    await recordLegalAcceptance(db, { userId: user.id, actorId: user.id }, { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0' }, [
      publishedEntry({ version: '1.0.0' }),
    ]);
    const client = await loginClient(user);
    await client.req('/api/privacy/consents', { method: 'PUT', body: { consentType: 'COOKIE_POLICY', granted: true } });
    await client.req('/api/privacy/consents', { method: 'PUT', body: { consentType: 'MARKETING', granted: true } });

    const items = await listLegalAcceptances(db, user.id);
    expect(items.map((i) => i.documentCode)).toEqual(['TERMS_OF_SERVICE']);
  });
});

// ---------------------------------------------------------------------------
// M1 — the four supported locales are accepted by the API (ar/fr/en/zh)
// ---------------------------------------------------------------------------
describe('M1 — locale acceptance across the API', () => {
  const SUPPORTED = ['ar', 'fr', 'en', 'zh'] as const;

  it('accepts every supported locale at registration and persists it', async () => {
    for (const locale of SUPPORTED) {
      const email = `m1-reg-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
      const client = makeClient();
      const { status } = await client.req('/api/auth/register', {
        method: 'POST',
        body: { email, password: 'Passw0rd!Secure', firstName: 'Loc', lastName: 'User', locale, role: 'CUSTOMER' },
      });
      expect(status, `register locale=${locale}`).toBe(201);
      const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.email, email)).limit(1);
      expect(row.locale, `stored locale=${locale}`).toBe(locale);
    }
  });

  it('rejects an unsupported locale at registration (422) and never creates the user', async () => {
    const email = `m1-reg-bad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
    const client = makeClient();
    const { status } = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'Passw0rd!Secure', locale: 'de', role: 'CUSTOMER' },
    });
    expect(status).toBe(422);
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows.length).toBe(0);
  });

  it('rejects a non-string locale at registration (422)', async () => {
    const client = makeClient();
    const { status } = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email: `m1-reg-type-${Date.now()}@wasit.tn`, password: 'Passw0rd!Secure', locale: 123 },
    });
    expect(status).toBe(422);
  });

  it('accepts every supported locale on the privacy rectification route and persists it', async () => {
    const user = await createUser('m1-privacy');
    const client = await loginClient(user);
    for (const locale of SUPPORTED) {
      const { status } = await client.req('/api/privacy/me', { method: 'PATCH', body: { locale } });
      expect(status, `privacy locale=${locale}`).toBe(200);
      const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, user.id)).limit(1);
      expect(row.locale, `stored locale=${locale}`).toBe(locale);
    }
  });

  it('rejects an unsupported locale on the privacy route (422)', async () => {
    const user = await createUser('m1-privacy-bad');
    const client = await loginClient(user);
    const { status } = await client.req('/api/privacy/me', { method: 'PATCH', body: { locale: 'es' } });
    expect(status).toBe(422);
  });

  it('rejects a non-string locale on the privacy route (422)', async () => {
    const user = await createUser('m1-privacy-type');
    const client = await loginClient(user);
    const { status } = await client.req('/api/privacy/me', { method: 'PATCH', body: { locale: { code: 'zh' } } });
    expect(status).toBe(422);
  });

  it('accepts the four locales on the legal acceptances route, failing on state (409) not on the locale (422)', async () => {
    // The real catalogue is all-drafts, so a valid request reaches the handler
    // and is refused with 409 "not open for acceptance". A rejected locale would
    // fail validation *before* the handler with 422 — which is exactly the bug
    // M1 fixes for `zh`. Any non-422 outcome proves the locale itself was
    // accepted; we pin the exact 409 so the proof is not merely "not 422".
    const user = await createUser('m1-accept');
    const client = await loginClient(user);
    for (const locale of SUPPORTED) {
      const { status, data } = await client.req('/api/legal/acceptances', {
        method: 'POST',
        body: { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', locale },
      });
      expect(status, `accept locale=${locale}`).toBe(409);
      expect((data as { message?: string }).message).toBe('Document is not open for acceptance');
    }
  });

  it('rejects an unsupported locale on the legal acceptances route (422, before the handler)', async () => {
    const user = await createUser('m1-accept-bad');
    const client = await loginClient(user);
    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', locale: 'de' },
    });
    expect(status).toBe(422);
  });

  it('rejects a non-string locale on the legal acceptances route (422)', async () => {
    const user = await createUser('m1-accept-type');
    const client = await loginClient(user);
    const { status } = await client.req('/api/legal/acceptances', {
      method: 'POST',
      body: { documentCode: 'TERMS_OF_SERVICE', version: '1.0.0', locale: ['zh'] },
    });
    expect(status).toBe(422);
  });

  it('omitting the locale still defaults registration to ar', async () => {
    const email = `m1-reg-default-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
    const client = makeClient();
    const { status } = await client.req('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'Passw0rd!Secure', role: 'CUSTOMER' },
    });
    expect(status).toBe(201);
    const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.email, email)).limit(1);
    expect(row.locale).toBe('ar');
  });
});

