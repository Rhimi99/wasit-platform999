import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ApiError } from '@wasit/shared';
import { coreMiddleware } from '../src/middleware/core.js';
import { requireAuth } from '../src/middleware/auth.js';
import { setAuthUser } from '../src/lib/request-context.js';
import { errorBody } from '../src/middleware/errors.js';
import { env } from '../src/lib/env.js';
import { closeDb } from '../src/db/client.js';
import {
  requireLegalAcceptance,
  isExemptFromLegalGate,
  pendingForAcceptance,
  LEGAL_ACCEPTANCE_REQUIRED_CODE,
} from '../src/modules/legal/enforcement.js';
import { LEGAL_DOCUMENTS, rolesForAudience, appliesToRoles, type LegalDocumentEntry } from '../src/lib/legal/catalogue.js';

/**
 * LC-01.1 — the legal acceptance gate, database-free half.
 *
 * The gate is mounted over the whole `/api` surface but is inert by default.
 * This suite isolates the *decision* logic (flag × catalogue × accepted
 * versions) and the real `app.use → route` mount order. The user is injected
 * into the request context rather than loaded from a session; the accepted-
 * version lookup still hits the real test database (empty for a synthetic user),
 * so the 403 path is exercised for real. The end-to-end acceptance flow lives in
 * `lc01-legal-framework.test.ts`.
 */

async function withEnv<T>(overrides: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, target[k]]));
  Object.assign(target, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(target, previous);
  }
}

afterAll(async () => {
  await closeDb();
});

/** A synthetic *published* document, to exercise the gate without touching the real catalogue. */
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

function draftEntry(overrides: Partial<LegalDocumentEntry> = {}): LegalDocumentEntry {
  return publishedEntry({ status: 'LEGAL_REVIEW_REQUIRED', effectiveDate: null, version: '0.0.0-draft', ...overrides });
}

// ---------------------------------------------------------------------------
// Decision logic (pure)
// ---------------------------------------------------------------------------
describe('LC-01.1 — pending acceptance decision', () => {
  it('demands a published, in-force document that was never accepted', () => {
    expect(pendingForAcceptance([publishedEntry()], {}, ['CUSTOMER']).map((d) => d.code)).toEqual(['TERMS_OF_SERVICE']);
  });

  it('demands nothing once the in-force version is accepted', () => {
    expect(pendingForAcceptance([publishedEntry()], { TERMS_OF_SERVICE: '1.0.0' }, ['CUSTOMER'])).toEqual([]);
  });

  it('re-demands on a version bump (stale acceptance)', () => {
    expect(
      pendingForAcceptance([publishedEntry({ version: '2.0.0' })], { TERMS_OF_SERVICE: '1.0.0' }, ['CUSTOMER']).map((d) => d.code),
    ).toEqual(['TERMS_OF_SERVICE']);
  });

  it('never demands an unapproved draft, even unaccepted', () => {
    expect(pendingForAcceptance([draftEntry()], {}, ['CUSTOMER'])).toEqual([]);
  });

  it('never demands a document that does not require acceptance', () => {
    expect(pendingForAcceptance([publishedEntry({ acceptanceRequired: false })], {}, ['CUSTOMER'])).toEqual([]);
  });

  it('does not demand a published document whose effective date is in the future', () => {
    const future = publishedEntry({ effectiveDate: '2999-01-01T00:00:00.000Z' });
    expect(pendingForAcceptance([future], {}, ['CUSTOMER'], new Date('2026-06-01T00:00:00.000Z'))).toEqual([]);
  });

  it('the real catalogue demands nothing (all drafts) — the shipped default is inert', () => {
    expect(pendingForAcceptance(LEGAL_DOCUMENTS, {}, ['CUSTOMER'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audience scoping (H1)
// ---------------------------------------------------------------------------
describe('LC-01.1 — audience → role mapping', () => {
  const A = (audience: LegalDocumentEntry['audience'], code: string) => publishedEntry({ audience, code, consentType: null });

  it('maps each audience to exactly the roles it governs', () => {
    expect(rolesForAudience('ALL')).toContain('CUSTOMER');
    expect(rolesForAudience('ALL')).toContain('ADMIN');
    expect(rolesForAudience('ALL')).not.toContain('VISITOR');
    expect(rolesForAudience('BUYER')).toEqual(['CUSTOMER']);
    expect(rolesForAudience('MERCHANT')).toEqual(['MERCHANT']);
    expect(rolesForAudience('SUPPLIER')).toEqual(['SUPPLIER']);
    expect(rolesForAudience('COMPANY')).toEqual(['COMPANY']);
    // There is no SELLER role; the seller-facing document binds MERCHANT only,
    // never SUPPLIER or COMPANY (they carry their own audiences).
    expect(rolesForAudience('SELLER')).toEqual(['MERCHANT']);
    // A visitor document never governs a signed-in account.
    expect(rolesForAudience('VISITOR')).toEqual([]);
  });

  it('a CUSTOMER is demanded ALL + BUYER, never seller/supplier/company terms', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    expect(pendingForAcceptance(cat, {}, ['CUSTOMER']).map((d) => d.code).sort()).toEqual(['BUYER_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a MERCHANT is demanded ALL + its own seller terms, not supplier/company terms', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    expect(pendingForAcceptance(cat, {}, ['MERCHANT']).map((d) => d.code).sort()).toEqual(['SELLER_MERCHANT_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a SUPPLIER is demanded ALL + its own supplier terms only', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    expect(pendingForAcceptance(cat, {}, ['SUPPLIER']).map((d) => d.code).sort()).toEqual(['SUPPLIER_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a COMPANY is demanded ALL + its own company terms only', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    expect(pendingForAcceptance(cat, {}, ['COMPANY']).map((d) => d.code).sort()).toEqual(['COMPANY_TERMS', 'TERMS_OF_SERVICE']);
  });

  it('a multi-role user gets the union of their audiences, without duplicates', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    const pending = pendingForAcceptance(cat, {}, ['CUSTOMER', 'MERCHANT']);
    const codes = pending.map((d) => d.code).sort();
    expect(codes).toEqual(['BUYER_TERMS', 'SELLER_MERCHANT_TERMS', 'TERMS_OF_SERVICE']);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('staff roles with no audience receive only ALL documents', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
      A('VISITOR', 'COOKIE_POLICY'),
    ];
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'RISK', 'DISPUTE', 'MARKETER']) {
      expect(pendingForAcceptance(cat, {}, [role]).map((d) => d.code), role).toEqual(['TERMS_OF_SERVICE']);
    }
  });

  it('never matches an unknown role to BUYER/SELLER/SUPPLIER/COMPANY, but still binds it to ALL (negative)', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
    ];
    // An unknown role matches no role-specific audience, yet is never exempt
    // from an ALL document.
    expect(pendingForAcceptance(cat, {}, ['UNKNOWN_ROLE']).map((d) => d.code)).toEqual(['TERMS_OF_SERVICE']);
  });

  it('an authenticated account with no roles is bound by ALL only, never by a role-specific audience', () => {
    const cat = [
      A('ALL', 'TERMS_OF_SERVICE'),
      A('ALL', 'PRIVACY_POLICY'),
      A('BUYER', 'BUYER_TERMS'),
      A('SELLER', 'SELLER_MERCHANT_TERMS'),
      A('SUPPLIER', 'SUPPLIER_TERMS'),
      A('COMPANY', 'COMPANY_TERMS'),
      A('VISITOR', 'COOKIE_POLICY'),
    ];
    // Empty roles = an authenticated account that holds no role, NOT an
    // anonymous visitor. It must still be bound by the documents that apply to
    // everyone, and by nothing else.
    expect(pendingForAcceptance(cat, {}, []).map((d) => d.code).sort()).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE']);
    expect(appliesToRoles(A('ALL', 'TERMS_OF_SERVICE'), [])).toBe(true);
    expect(appliesToRoles(A('BUYER', 'BUYER_TERMS'), [])).toBe(false);
    expect(appliesToRoles(A('SELLER', 'SELLER_MERCHANT_TERMS'), [])).toBe(false);
    expect(appliesToRoles(A('SUPPLIER', 'SUPPLIER_TERMS'), [])).toBe(false);
    expect(appliesToRoles(A('COMPANY', 'COMPANY_TERMS'), [])).toBe(false);
  });

  it('distinguishes "no roles" (an account) from "no user" (anonymous)', () => {
    const allDoc = A('ALL', 'TERMS_OF_SERVICE');
    // An empty array is an account with no role → bound by ALL.
    expect(appliesToRoles(allDoc, [])).toBe(true);
    // null/undefined is "no user context" → bound by nothing.
    expect(appliesToRoles(allDoc, null)).toBe(false);
    expect(appliesToRoles(allDoc, undefined)).toBe(false);
  });

  it('never demands a VISITOR document from a signed-in account', () => {
    const cat = [A('VISITOR', 'COOKIE_POLICY'), A('ALL', 'TERMS_OF_SERVICE')];
    for (const roles of [['CUSTOMER'], ['MERCHANT'], ['ADMIN'], []]) {
      expect(pendingForAcceptance(cat, {}, roles).map((d) => d.code), JSON.stringify(roles)).toEqual(['TERMS_OF_SERVICE']);
    }
  });
});

describe('LC-01.1 — gate exemptions', () => {
  it('exempts the surfaces needed to read and clear a pending acceptance', () => {
    for (const p of ['/api/auth/login', '/api/health', '/api/legal/acceptances/me', '/api/public/legal/documents']) {
      expect(isExemptFromLegalGate(p), p).toBe(true);
    }
  });

  it('does not exempt ordinary product surfaces', () => {
    for (const p of ['/api/orders', '/api/products', '/api/privacy/me']) {
      expect(isExemptFromLegalGate(p), p).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Mounted middleware (real use → route order, injected user)
// ---------------------------------------------------------------------------
function makeApp(user: { id: string; roles: string[] } | null, catalogue: readonly LegalDocumentEntry[]) {
  const app = new Hono();
  app.onError((err, c) => errorBody(err, c));
  app.use('*', coreMiddleware);
  app.use('/api/*', async (c, next) => {
    if (user) {
      setAuthUser(c, {
        id: user.id,
        email: 'user@wasit.tn',
        emailVerified: true,
        isActive: true,
        mfaEnabled: false,
        roles: user.roles as never,
      });
    }
    await next();
  });
  // Same mount order as `createApp()`: gate over the whole /api surface, before routes.
  app.use('/api/*', requireLegalAcceptance({ catalogue }));
  const ok = (c: Context) => c.json({ success: true, data: { ok: true } });
  app.get('/api/orders', requireAuth, ok);
  app.get('/api/legal/acceptances/me', requireAuth, ok);
  app.get('/api/auth/login', ok);
  app.get('/api/health', ok);
  return app;
}

describe('LC-01.1 — gate enforcement (mounted, flag-controlled)', () => {
  const user = { id: 'lc011-gate-user', roles: ['CUSTOMER'] };

  it('is inert when enforcement is off, even with a published unaccepted document', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'off' }, async () => {
      const res = await makeApp(user, [publishedEntry()]).request('/api/orders');
      expect(res.status).toBe(200);
    });
  });

  it('is a no-op when enforcement is on but only drafts exist', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp(user, [draftEntry()]).request('/api/orders');
      expect(res.status).toBe(200);
    });
  });

  it('exempts /api/auth, /api/health and the legal surface even when enforcement is on', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const app = makeApp(user, [publishedEntry()]);
      expect((await app.request('/api/auth/login')).status).toBe(200);
      expect((await app.request('/api/health')).status).toBe(200);
      expect((await app.request('/api/legal/acceptances/me')).status).toBe(200);
    });
  });

  it('leaves anonymous requests to the route guard (401, not a legal error)', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp(null, [publishedEntry()]).request('/api/orders');
      expect(res.status).toBe(401);
    });
  });

  it('blocks an authenticated request while a published document is unaccepted (403 + code)', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp(user, [publishedEntry()]).request('/api/orders');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(LEGAL_ACCEPTANCE_REQUIRED_CODE);
    });
  });
});

describe('LC-01.1 — gate enforcement is audience-scoped (mounted)', () => {
  const sellerDoc = publishedEntry({ code: 'SELLER_MERCHANT_TERMS', audience: 'SELLER', consentType: null });
  const allDoc = publishedEntry({ code: 'TERMS_OF_SERVICE', audience: 'ALL' });

  it('does not block a CUSTOMER on a seller-only document', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp({ id: 'cust', roles: ['CUSTOMER'] }, [sellerDoc]).request('/api/orders');
      expect(res.status).toBe(200);
    });
  });

  it('blocks a MERCHANT on the same seller-only document', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp({ id: 'merch', roles: ['MERCHANT'] }, [sellerDoc]).request('/api/orders');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(LEGAL_ACCEPTANCE_REQUIRED_CODE);
    });
  });

  it('does not block a SUPPLIER on a seller-only document (their terms differ)', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp({ id: 'supp', roles: ['SUPPLIER'] }, [sellerDoc]).request('/api/orders');
      expect(res.status).toBe(200);
    });
  });

  it('blocks every role on an ALL document', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      for (const role of ['CUSTOMER', 'MERCHANT', 'SUPPLIER', 'COMPANY', 'MARKETER', 'ADMIN', 'SUPER_ADMIN']) {
        const res = await makeApp({ id: `u-${role}`, roles: [role] }, [allDoc]).request('/api/orders');
        expect(res.status, role).toBe(403);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// M2 — the 403 keeps its safe `details.pending`, and only that code does
// ---------------------------------------------------------------------------
describe('M2 — legal-acceptance 403 carries safe details', () => {
  const user = { id: 'm2-gate-user', roles: ['CUSTOMER'] };

  it('preserves details.pending (code/version/title) in the real 403 JSON', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp(user, [publishedEntry()]).request('/api/orders');
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; message: string; details?: { pending: Array<{ code: string; version: string; title: Record<string, string> }> } };
      };
      expect(body.error.code).toBe(LEGAL_ACCEPTANCE_REQUIRED_CODE);
      expect(body.error.details?.pending).toEqual([
        { code: 'TERMS_OF_SERVICE', version: '1.0.0', title: { ar: 'شروط الخدمة', en: 'Terms of Service' } },
      ]);
    });
  });

  it('carries exactly the safe shape: no stack, no secrets, no internal fields', async () => {
    await withEnv({ LEGAL_ACCEPTANCE_ENFORCEMENT: 'on' }, async () => {
      const res = await makeApp(user, [publishedEntry()]).request('/api/orders');
      const body = (await res.json()) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/stack|at .*\.ts:|passwordHash|userId|session|token/i);
      // The details expose only what the SPA needs to list and route: code,
      // version and the public titles.
      const pending = (body.error as { details: { pending: Array<Record<string, unknown>> } }).details.pending;
      expect(Object.keys(pending[0]).sort()).toEqual(['code', 'title', 'version']);
    });
  });

  it('does not leak details for other error codes (legal is the only opt-in)', () => {
    const forbidden = ApiError.forbidden('nope');
    const details = ApiError.prohibitedGoods('no', { ruleId: 'R-1', category: 'X' });
    expect(forbidden.toBody().error).not.toHaveProperty('details');
    expect(details.toBody().error).not.toHaveProperty('details');
  });

  it('omits details when the legal error carries none', () => {
    const bare = new ApiError(403, 'LEGAL_ACCEPTANCE_REQUIRED', 'must accept');
    expect(bare.toBody().error).not.toHaveProperty('details');
  });
});

