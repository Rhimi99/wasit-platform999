import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  shouldRedirectToLegalAcceptance,
  redirectToLegalAcceptance,
  LEGAL_ACCEPTANCE_REQUIRED_CODE,
  LEGAL_ACCEPTANCE_PATH,
} from '../src/lib/legal-gate';
import { api, apiCall, ApiClientError } from '../src/lib/api';

/**
 * M2 — the SPA's central reaction to a pending legal acceptance.
 *
 * The redirect decision is a pure function, so most cases are asserted directly.
 * The last block drives the *real* central `request()` in `lib/api.ts` (with a
 * stubbed fetch/window) to prove the wiring: only `403 + LEGAL_ACCEPTANCE_REQUIRED`
 * navigates, and never in a way that could loop.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs `fetch` to answer every request with the same JSON body/status. */
function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Stubs the minimal `window` the client touches, returning the `assign` spy. */
function stubWindow(pathname: string) {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { pathname, assign } });
  return assign;
}

const legal403 = {
  success: false,
  error: {
    code: LEGAL_ACCEPTANCE_REQUIRED_CODE,
    message: 'You must accept the current legal documents to continue',
    details: { pending: [{ code: 'TERMS_OF_SERVICE', version: '1.0.0', title: { ar: 'شروط الخدمة', en: 'Terms of Service' } }] },
  },
};

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------
describe('M2 — shouldRedirectToLegalAcceptance (pure)', () => {
  it('routes on 403 + LEGAL_ACCEPTANCE_REQUIRED from an ordinary page', () => {
    expect(shouldRedirectToLegalAcceptance({ statusCode: 403, code: LEGAL_ACCEPTANCE_REQUIRED_CODE }, '/api/orders', '/dashboard/orders')).toBe(true);
  });

  it('does not redirect when the user is already on the acceptance page', () => {
    expect(shouldRedirectToLegalAcceptance({ statusCode: 403, code: LEGAL_ACCEPTANCE_REQUIRED_CODE }, '/api/orders', LEGAL_ACCEPTANCE_PATH)).toBe(false);
  });

  it('does not redirect a request made for the acceptance page itself', () => {
    expect(shouldRedirectToLegalAcceptance({ statusCode: 403, code: LEGAL_ACCEPTANCE_REQUIRED_CODE }, '/api/legal/acceptances/me', '/dashboard')).toBe(false);
    expect(shouldRedirectToLegalAcceptance({ statusCode: 403, code: LEGAL_ACCEPTANCE_REQUIRED_CODE }, '/api/legal/acceptances', '/dashboard')).toBe(false);
  });

  it('never treats an ordinary FORBIDDEN (e.g. CSRF) as a legal redirect', () => {
    expect(shouldRedirectToLegalAcceptance({ statusCode: 403, code: 'FORBIDDEN' }, '/api/orders', '/dashboard')).toBe(false);
  });

  it('never treats a 401 (session/MFA) as a legal redirect', () => {
    expect(shouldRedirectToLegalAcceptance({ statusCode: 401, code: 'UNAUTHORIZED' }, '/api/orders', '/dashboard')).toBe(false);
    expect(shouldRedirectToLegalAcceptance({ statusCode: 401, code: 'MFA_REQUIRED' }, '/api/auth/mfa/challenge', '/login')).toBe(false);
  });

  it('does not redirect on a missing error', () => {
    expect(shouldRedirectToLegalAcceptance(null, '/api/orders', '/dashboard')).toBe(false);
    expect(shouldRedirectToLegalAcceptance(undefined, '/api/orders', '/dashboard')).toBe(false);
  });
});

describe('M2 — redirectToLegalAcceptance side effect', () => {
  it('navigates to the acceptance page', () => {
    const assign = stubWindow('/dashboard/orders');
    redirectToLegalAcceptance();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(LEGAL_ACCEPTANCE_PATH);
  });

  it('is a no-op without a DOM (never throws)', () => {
    expect(() => redirectToLegalAcceptance()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration through the real central client
// ---------------------------------------------------------------------------
describe('M2 — central client wiring (real request())', () => {
  it('redirects exactly once on a legal 403 and still throws a typed error', async () => {
    stubFetch(403, legal403);
    const assign = stubWindow('/dashboard/orders');

    await expect(api.me()).rejects.toBeInstanceOf(ApiClientError);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(LEGAL_ACCEPTANCE_PATH);
  });

  it('does not redirect when already on the acceptance page', async () => {
    stubFetch(403, legal403);
    const assign = stubWindow(LEGAL_ACCEPTANCE_PATH);

    await expect(api.me()).rejects.toBeInstanceOf(ApiClientError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not redirect for a legal-endpoint request that itself 403s (no loop)', async () => {
    stubFetch(403, legal403);
    const assign = stubWindow('/dashboard');

    await expect(api.legalAcceptances()).rejects.toBeInstanceOf(ApiClientError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves an ordinary 403 (FORBIDDEN) untouched', async () => {
    stubFetch(403, { success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission' } });
    const assign = stubWindow('/dashboard/orders');

    await expect(api.me()).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves a 401 untouched', async () => {
    stubFetch(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    const assign = stubWindow('/dashboard/orders');

    await expect(api.me()).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves an MFA challenge failure untouched', async () => {
    stubFetch(401, { success: false, error: { code: 'MFA_REQUIRED', message: 'MFA required' } });
    const assign = stubWindow('/login');

    await expect(api.mfaChallenge('tok', '000000')).rejects.toMatchObject({ statusCode: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps `pending` reachable for the acceptance UI via apiCall', async () => {
    stubFetch(403, legal403);
    stubWindow(LEGAL_ACCEPTANCE_PATH); // on the page, so no navigation side effect

    const res = await apiCall(() => api.me());
    expect(res.error).toBeTruthy();
    const pending = (res.errorObject?.details as { pending: Array<{ code: string; version: string }> } | undefined)?.pending;
    expect(pending).toEqual([{ code: 'TERMS_OF_SERVICE', version: '1.0.0', title: { ar: 'شروط الخدمة', en: 'Terms of Service' } }]);
  });
});
