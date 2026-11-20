import { Hono } from 'hono';
import { z } from 'zod';
import { SUPPORTED_LOCALES } from '@wasit/shared';
import { getContext } from '../../lib/request-context';
import { validateBody, getValidatedBody } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import { LEGAL_DOCUMENTS, findLegalDocument, isAcceptable, publishedDocuments, appliesToRoles } from '../../lib/legal/catalogue';
import {
  getAcceptedVersions,
  getPendingLegalAcceptances,
  listLegalAcceptances,
  recordLegalAcceptance,
} from '../privacy/service';

/**
 * LC-01 — legal documents.
 *
 * Two surfaces, deliberately separate:
 *  - public (no session): the *published* texts only. An unapproved draft is
 *    never disclosed, so a visitor can never be shown, or bound by, a document
 *    that has not passed review.
 *  - authenticated: the caller's own acceptance state and the act of accepting
 *    the version currently in force.
 */

export const publicLegalRoutes = new Hono();

// Public index. Empty until a document is PUBLISHED — that is the intended
// fail-closed behaviour, not a bug.
publicLegalRoutes.get('/documents', (c) => {
  const items = publishedDocuments().map((d) => ({
    code: d.code,
    audience: d.audience,
    title: d.title,
    summary: d.summary,
    version: d.version,
    effectiveDate: d.effectiveDate,
    acceptanceRequired: d.acceptanceRequired,
  }));
  return c.json({ success: true, data: { items } });
});

publicLegalRoutes.get('/documents/:code', (c) => {
  const entry = findLegalDocument(c.req.param('code'));
  // Only a published document is disclosed; anything else is "not found" rather
  // than revealing that a draft exists.
  if (!entry || entry.status !== 'PUBLISHED' || entry.effectiveDate === null) {
    return c.json({ success: false, message: 'Document not found' }, 404 as never);
  }
  return c.json({
    success: true,
    data: {
      code: entry.code,
      audience: entry.audience,
      title: entry.title,
      summary: entry.summary,
      version: entry.version,
      effectiveDate: entry.effectiveDate,
      acceptanceRequired: entry.acceptanceRequired,
    },
  });
});

export const legalRoutes = new Hono();

legalRoutes.use('*', requireAuth);

const acceptSchema = z
  .object({
    documentCode: z.string().min(1).max(120),
    version: z.string().min(1).max(50),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  // Strict: a caller must not smuggle a `userId` (or any other field) into the
  // body hoping to record an acceptance for someone else. The route always
  // records against the session user; rejecting unknown keys makes that
  // explicit and rejects the attempt rather than silently ignoring it.
  .strict();

// The caller's legal state: which documents are in force, which they have
// accepted (and at what version), and which still need (re-)acceptance. Scoped
// to the caller's own roles: a document whose audience does not cover any of
// them is neither listed as in-force nor demanded (LC-01.1, H1). The role set
// comes from the session, never from the request body.
legalRoutes.get('/acceptances/me', async (c) => {
  const ctx = getContext(c);
  const roles = ctx.user!.roles;
  const [accepted, pending] = await Promise.all([
    getAcceptedVersions(ctx.db, ctx.user!.id),
    getPendingLegalAcceptances(ctx.db, ctx.user!.id, LEGAL_DOCUMENTS, roles),
  ]);
  return c.json({
    success: true,
    data: {
      acceptedVersions: accepted,
      pendingAcceptances: pending,
      // The documents this caller may show/accept right now (published, in force
      // and matching their roles).
      inForce: LEGAL_DOCUMENTS.filter((d) => isAcceptable(d) && appliesToRoles(d, roles)).map((d) => ({
        code: d.code,
        title: d.title,
        version: d.version,
        effectiveDate: d.effectiveDate,
      })),
    },
  });
});

// The caller's own acceptance history (append-only), newest first. Scoped to the
// session user only — there is no path parameter by which one user could read
// another's acceptances.
legalRoutes.get('/acceptances/history', async (c) => {
  const ctx = getContext(c);
  const items = await listLegalAcceptances(ctx.db, ctx.user!.id);
  return c.json({ success: true, data: { items } });
});

// Records acceptance of a specific published version. The version the caller
// sends must be the version currently in force: accepting a stale or unknown
// version is refused, so a record can never attest to a text that is not live.
legalRoutes.post(
  '/acceptances',
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'legal-accept' }),
  validateBody(acceptSchema),
  async (c) => {
    const ctx = getContext(c);
    const body = getValidatedBody<z.infer<typeof acceptSchema>>(c);
    const entry = findLegalDocument(body.documentCode);
    if (!entry || !isAcceptable(entry)) {
      return c.json({ success: false, message: 'Document is not open for acceptance' }, 409 as never);
    }
    if (body.version !== entry.version) {
      return c.json({ success: false, message: 'Version mismatch: accept the version currently in force' }, 409 as never);
    }
    const result = await recordLegalAcceptance(ctx.db, { userId: ctx.user!.id, actorId: ctx.user!.id, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, body);
    return c.json({ success: true, data: result });
  },
);
