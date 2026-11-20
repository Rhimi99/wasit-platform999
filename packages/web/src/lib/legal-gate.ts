// LC-01.2 — central handling of the legal-acceptance 403.
//
// The server refuses a request with `403 LEGAL_ACCEPTANCE_REQUIRED` while a
// published, in-force document is unaccepted. The SPA must send the user to the
// acceptance page — once, centrally — instead of every caller re-implementing
// the check. The decision is a pure function so it can be unit-tested without a
// DOM; the side effect (a full-page navigation) is a separate, tiny function.

/** The one error code that triggers the redirect. Nothing else is matched. */
export const LEGAL_ACCEPTANCE_REQUIRED_CODE = 'LEGAL_ACCEPTANCE_REQUIRED';

/** Where a user clears a pending acceptance. */
export const LEGAL_ACCEPTANCE_PATH = '/dashboard/legal';

interface LegalGateError {
  statusCode?: number;
  code?: string;
}

/**
 * Whether a failed request should navigate to the legal acceptance page.
 *
 * Deliberately narrow, to avoid redirect loops and to leave every other error
 * untouched:
 *  - it must be exactly `403` — a 401 (session) or a CSRF/MFA failure never
 *    qualifies, and neither does any other `ApiError` type;
 *  - the error code must be `LEGAL_ACCEPTANCE_REQUIRED` — an ordinary `FORBIDDEN`
 *    is left alone;
 *  - the user must not already be on the acceptance page;
 *  - the request must not itself target the acceptance surface, so the page's own
 *    reads/accept calls can never re-trigger the redirect.
 */
export function shouldRedirectToLegalAcceptance(
  error: LegalGateError | null | undefined,
  requestPath: string,
  currentPath: string,
): boolean {
  if (!error || error.statusCode !== 403) return false;
  if (error.code !== LEGAL_ACCEPTANCE_REQUIRED_CODE) return false;
  if (currentPath === LEGAL_ACCEPTANCE_PATH) return false;
  // The acceptance endpoints are exempt server-side; mirror that here so a
  // request made *for* the acceptance page can never bounce the user back.
  if (requestPath.startsWith('/api/legal/')) return false;
  return true;
}

/** Navigates to the acceptance page. Guarded so it is a no-op outside a DOM. */
export function redirectToLegalAcceptance(): void {
  if (typeof window === 'undefined') return;
  window.location.assign(LEGAL_ACCEPTANCE_PATH);
}
