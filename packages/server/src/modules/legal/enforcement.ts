import type { Context, Next } from 'hono';
import { ApiError } from '@wasit/shared';
import { legalAcceptanceEnforced } from '../../lib/env';
import { getContext } from '../../lib/request-context';
import { loadAuthUser } from '../../middleware/auth';
import { LEGAL_DOCUMENTS, isAcceptable, needsReacceptance, appliesToRoles, type LegalDocumentEntry } from '../../lib/legal/catalogue';
import { getAcceptedVersions } from '../privacy/service';

/**
 * Mandatory legal-document acceptance (LC-01) — the enforcement gate.
 *
 * This is the *second half* of the legal framework: the first half records that
 * a user accepted a specific version of a specific document; this gate refuses
 * to proceed while a published, in-force document is still unaccepted. Both
 * halves exist so that the day counsel approves the texts, enabling the gate is
 * a single reviewed flag rather than a new build.
 *
 * Three independent conditions must all hold before any request is blocked:
 *  1. `LEGAL_ACCEPTANCE_ENFORCEMENT=on` — off by default, set only after the
 *     texts are approved. This is the "key" an operator turns deliberately.
 *  2. A document is actually published-and-in-force (`isAcceptable`) — the
 *     catalogue ships every document as `LEGAL_REVIEW_REQUIRED` with no
 *     effective date, so against drafts the gate is a no-op even when the flag
 *     is on. There is no way to block a user on an unapproved draft.
 *  3. The authenticated user has not accepted the version currently in force.
 *
 * Because condition 2 is evaluated against the code catalogue, a user is never
 * asked to accept, and never blocked by, a text that has not passed review.
 *
 * The gate never inspects anonymous requests (the route's own `requireAuth`
 * handles those) and is exempt on the surfaces a user needs to *reach* the
 * acceptance act: `/api/auth` (sign in), `/api/health`, and the legal module
 * itself (`/api/legal/*`, `/api/public/legal/*`) so the SPA can read the
 * pending list and record acceptance without first clearing the gate.
 */

/** The distinct error code a blocked request carries, so the SPA can route to the acceptance page. */
export const LEGAL_ACCEPTANCE_REQUIRED_CODE = 'LEGAL_ACCEPTANCE_REQUIRED' as const;

/**
 * Surfaces a user must always be able to reach so a pending acceptance can be
 * read and cleared instead of locking the account out entirely: the auth
 * surface (sign in / sign out), health probes, and the legal module's own
 * routes (public index + authenticated acceptance endpoints).
 */
const LEGAL_GATE_EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/health',
  '/api/legal',
  '/api/public/legal',
] as const;

export function isExemptFromLegalGate(path: string): boolean {
  return LEGAL_GATE_EXEMPT_PREFIXES.some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * Documents the user must accept right now, given a catalogue and the user's
 * roles. Pure and synchronous so it can be unit-tested without a database; the
 * middleware supplies the user's accepted versions and role set.
 *
 * This is the single audience-aware decision used by the gate and the pending
 * surface: a document counts only when it is published-and-in-force, its
 * audience covers at least one of the user's roles, and the in-force version is
 * not already accepted. `roles` is required so a caller can never accidentally
 * demand a role-specific document of an unrelated user; an empty role set yields
 * nothing (there is no account to bind) — the gate never runs without a resolved
 * user.
 */
export function pendingForAcceptance(
  catalogue: readonly LegalDocumentEntry[],
  accepted: Record<string, string>,
  roles: readonly string[],
  now: Date = new Date(),
): LegalDocumentEntry[] {
  return catalogue.filter(
    (d) =>
      d.acceptanceRequired &&
      isAcceptable(d, now) &&
      appliesToRoles(d, roles) &&
      needsReacceptance(d, accepted[d.code] ?? null),
  );
}

export function requireLegalAcceptance(options: { catalogue?: readonly LegalDocumentEntry[] } = {}) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!legalAcceptanceEnforced()) return next();
    if (isExemptFromLegalGate(c.req.path)) return next();

    // Resolve the session first so this works whether mounted before or after a
    // router's own `requireAuth` (the loader is memoised per request).
    await loadAuthUser(c);
    const ctx = getContext(c);
    const user = ctx?.user;
    // Anonymous: the route's own `requireAuth`/RBAC guard handles it.
    if (!user) return next();

    // The catalogue is a parameter so an isolated test can exercise the gate
    // against a synthetic published document; production always uses the real
    // (all-drafts) catalogue, which keeps the gate inert.
    const catalogue = options.catalogue ?? LEGAL_DOCUMENTS;

    // Fast path: if no document is published-and-in-force there is nothing to
    // demand, so we never touch the database for the common (draft-only) state.
    const inForce = catalogue.filter((d) => d.acceptanceRequired && isAcceptable(d));
    if (inForce.length === 0) return next();

    const accepted = await getAcceptedVersions(ctx.db, user.id);
    const pending = pendingForAcceptance(catalogue, accepted, user.roles);
    if (pending.length === 0) return next();

    throw ApiError.legalAcceptanceRequired('You must accept the current legal documents to continue', {
      pending: pending.map((d) => ({ code: d.code, version: d.version, title: d.title })),
    });
  };
}
