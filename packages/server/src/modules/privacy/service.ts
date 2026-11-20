import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import {
  consentEvents,
  dataDeletionRequests,
  dataExportRequests,
  deletionStageEnum,
} from '../../db/schema/privacy';
import { consents, securitySettings, users } from '../../db/schema/auth';
import { profiles } from '../../db/schema/trade';
import { countries } from '../../db/schema/geo';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { anonymizeUser, type AnonymizationResult } from '../../lib/anonymize';
import { resolveMergedPolicy } from '../../lib/policy-engine';
import { recordCountryPolicyGap, resolveCountryPolicyGap } from '../../lib/country-policy-gaps';
import { normalizePhone } from '../auth/service';
import { LEGAL_DOCUMENTS, findLegalDocument, isAcceptable, needsReacceptance, appliesToRoles, type LegalDocumentEntry } from '../../lib/legal/catalogue';
import { newId } from '../../lib/ids';

type DeletionStage = (typeof deletionStageEnum.enumValues)[number];

export const CONSENT_TYPES = [
  'TERMS',
  'PRIVACY_POLICY',
  'COOKIE_POLICY',
  'COMMUNICATIONS',
  'MARKETING',
  'DATA_PROCESSING',
  'ANALYTICS',
  'THIRD_PARTY_SHARING',
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Policy that governs retention duration and the records that survive deletion. */
export const DATA_RETENTION_CODE = 'DATA_RETENTION';
export const DATA_RETENTION_SCOPE = 'PRIVACY' as const;

/**
 * Records a deletion must not erase (financial/legal retention). Static because
 * it is the platform's legal obligation, not a tunable: erasing the ledger or
 * audit trail back would break invoices, settlements and every dispute that
 * references the account. The *duration* that must be preserved is policy.
 */
export const PRESERVED_RECORD_TYPES = [
  'transaction_ledger',
  'audit_logs',
  'disputes',
  'orders',
  'invoices',
] as const;

interface RetentionRules {
  defaultRetentionDays: number;
  legalHoldFinanciallyRequired: boolean;
  /** Optional per-country extra record classes to preserve. */
  preserves?: string[];
}

/**
 * Resolves data-retention rules for a user's country through the Policy Engine
 * (COUNTRY → GLOBAL). Nothing about retention is hardcoded: a missing country
 * row means only the global default applies, and that is registered as a
 * DECISION_REQUIRED gap rather than silently inventing local law.
 */
export async function resolveRetentionForUser(
  db: DB,
  userId: string,
): Promise<{
  rules: RetentionRules;
  source: 'COUNTRY' | 'GLOBAL';
  countryId: string | null;
  countryCode: string | null;
  policyId: string | null;
  version: number | null;
}> {
  const [profile] = await db
    .select({ countryId: profiles.countryId })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1)
    .catch(() => []);
  const countryId = profile?.countryId ?? null;

  const resolved = await resolveMergedPolicy(db, {
    scope: DATA_RETENTION_SCOPE,
    code: DATA_RETENTION_CODE,
    countryId,
  });

  const raw = resolved.rules as Partial<RetentionRules>;
  const days = Number(raw.defaultRetentionDays);
  const rules: RetentionRules = {
    // This default only applies if the global policy row is missing entirely
    // (i.e. the platform itself is unconfigured); it is logged as a gap below.
    defaultRetentionDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 90,
    legalHoldFinanciallyRequired: raw.legalHoldFinanciallyRequired !== false,
    preserves: Array.isArray(raw.preserves) ? raw.preserves.filter((v): v is string => typeof v === 'string') : [],
  };

  let countryCode: string | null = null;
  if (countryId) {
    const [c] = await db
      .select({ code: countries.code })
      .from(countries)
      .where(eq(countries.id, countryId))
      .limit(1);
    countryCode = c?.code ?? null;
  }

  if (countryId && resolved.countryOverrideMissing) {
    await recordCountryPolicyGap(db, {
      countryId,
      scope: DATA_RETENTION_SCOPE,
      code: DATA_RETENTION_CODE,
      reason:
        'Country-specific data-retention rules are not configured; global policy is being applied. ' +
        'Legal review required to define local retention duration.',
      metadata: { countryCode, appliedPolicyId: resolved.policyId, appliedVersion: resolved.version },
    });
  } else if (countryId && resolved.source === 'COUNTRY') {
    await resolveCountryPolicyGap(db, { countryId, scope: DATA_RETENTION_SCOPE, code: DATA_RETENTION_CODE });
  }

  return {
    rules,
    source: resolved.source,
    countryId,
    countryCode,
    policyId: resolved.policyId,
    version: resolved.version,
  };
}

export interface ConsentAuditContext extends AuditContext {
  userId: string;
}

function consentTypeLabel(t: string): string {
  return (CONSENT_TYPES as readonly string[]).includes(t) ? t : 'CUSTOM';
}

/**
 * Privacy Service
 * - Consent management with append-only history (consent_events)
 * - Data Export readiness (ownership-bounded, no secrets)
 * - Data Deletion workflow (REQUESTED → DEACTIVATED → RETENTION/REVIEW → ELIGIBLE)
 */

export async function listConsents(db: DB, userId: string) {
  return db
    .select({
      id: consents.id,
      consentType: consents.consentType,
      granted: consents.granted,
      givenAt: consents.givenAt,
      revokedAt: consents.revokedAt,
      metadata: consents.metadata,
    })
    .from(consents)
    .where(eq(consents.userId, userId))
    .orderBy(consents.consentType);
}

export async function getConsentState(
  db: DB,
  userId: string,
): Promise<{
  consents: Array<{ type: string; label: string; granted: boolean }>;
  defaults: Array<{ type: string; label: string; grantedByDefault: boolean }>;
  settings: {
    require2FA: boolean;
    loginNotifications: boolean;
    deviceTracking: boolean;
  } | null;
}> {
  const [rows, settings] = await Promise.all([
    listConsents(db, userId),
    db
      .select({
        require2FA: securitySettings.require2FA,
        loginNotifications: securitySettings.loginNotifications,
        deviceTracking: securitySettings.deviceTracking,
      })
      .from(securitySettings)
      .where(eq(securitySettings.userId, userId))
      .limit(1),
  ]);

  const current = new Map<string, boolean>();
  for (const r of rows) current.set(r.consentType, r.granted);

  const defaults = CONSENT_TYPES.map((t) => ({
    type: t,
    label: t,
    grantedByDefault: t === 'TERMS' || t === 'PRIVACY_POLICY' || t === 'DATA_PROCESSING',
  }));

  const normalized = CONSENT_TYPES.map((t) => ({
    type: t,
    label: t,
    granted: current.get(t) ?? false,
  }));

  return { consents: normalized, defaults, settings: settings[0] ?? null };
}

// ---------------------------------------------------------------------------
// Rectification (data-subject right to correct) — LC-01
// ---------------------------------------------------------------------------

export interface RectificationInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  locale?: string | null;
  displayName?: string | null;
}

/**
 * Applies a self-service correction to the caller's own profile. Only a
 * whitelisted set of fields is writable — never email (an identity/contact
 * change that must go through verification, not a free edit) and never any
 * verification flag. The email and verification status are therefore
 * structurally out of reach here, not merely omitted from a schema.
 */
export async function rectifyOwnProfile(
  db: DB,
  ctx: ConsentAuditContext,
  input: RectificationInput,
): Promise<{ changed: string[] }> {
  const userId = ctx.userId;
  const now = new Date();

  const [before] = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!before) throw ApiError.notFound('User');

  const patch: { firstName?: string | null; lastName?: string | null; phone?: string | null; locale?: string } = {};
  if (input.firstName !== undefined) patch.firstName = input.firstName?.trim().slice(0, 100) || null;
  if (input.lastName !== undefined) patch.lastName = input.lastName?.trim().slice(0, 100) || null;
  if (input.phone !== undefined) patch.phone = normalizePhone(input.phone);
  if (input.locale !== undefined && input.locale) patch.locale = input.locale;

  const changed: string[] = (Object.keys(patch) as Array<keyof typeof patch>).filter(
    (k) => (patch[k] ?? null) !== ((before[k] ?? null) as string | null),
  );

  if (changed.length > 0) {
    await db
      .update(users)
      .set({ ...patch, updatedAt: now })
      .where(eq(users.id, userId));
  }

  if (input.displayName !== undefined) {
    const [existingProfile] = await db
      .select({ userId: profiles.userId, displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    const nextDisplayName = input.displayName?.trim().slice(0, 150) || null;
    if (existingProfile) {
      if ((existingProfile.displayName ?? null) !== nextDisplayName) {
        await db.update(profiles).set({ displayName: nextDisplayName, updatedAt: now }).where(eq(profiles.userId, userId));
        changed.push('displayName');
      }
    } else if (nextDisplayName) {
      await db.insert(profiles).values({ userId, displayName: nextDisplayName });
      changed.push('displayName');
    }
  }

  await writeAudit(
    db,
    { actorId: ctx.actorId ?? userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'PRIVACY.RECTIFICATION',
      entityType: 'USER',
      entityId: userId,
      // Record which fields changed, never the values themselves.
      after: { fields: changed },
      metadata: { source: 'USER' },
    },
  );

  return { changed };
}

// ---------------------------------------------------------------------------
// Legal-document acceptance (LC-01)
// ---------------------------------------------------------------------------

/**
 * Records a user's acceptance of a specific *version* of a legal document. This
 * is distinct from `setConsent`: a consent is a grant/revoke of a processing
 * purpose, whereas acceptance pins the exact text version the user agreed to,
 * with the instant and the client context. Storing the version is what makes
 * "re-accept when the terms change" answerable later — a bare boolean cannot.
 *
 * The catalogue is the source of truth for which version is in force; the route
 * refuses any document that is not published-and-acceptable, so this function is
 * only ever reached for a real, approved text.
 */
export async function recordLegalAcceptance(
  db: DB,
  ctx: ConsentAuditContext,
  input: { documentCode: string; version: string; locale?: string },
  catalogue: readonly LegalDocumentEntry[] = LEGAL_DOCUMENTS,
): Promise<{ documentCode: string; version: string; acceptedAt: string }> {
  const now = new Date();
  const acceptedAt = now.toISOString();
  const metadata = {
    version: input.version,
    locale: input.locale ?? null,
    acceptedAt,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ipAddress ?? null,
  };

  // Mirror into the generic consent table so the disclosure/acceptance appears
  // in the user's consent list alongside the other consents. `setConsent` also
  // appends the consent_events history row and the audit entry.
  const entry = findLegalDocument(input.documentCode, catalogue);
  if (entry?.consentType) {
    await setConsent(db, ctx, entry.consentType, true, 'USER');
  }

  await db.insert(consentEvents).values({
    id: newId(),
    userId: ctx.userId,
    consentType: 'LEGAL_DOCUMENT',
    action: 'ACCEPT',
    granted: true,
    actorId: ctx.actorId ?? null,
    source: 'USER',
    metadata: { documentCode: input.documentCode, ...metadata },
  });

  await writeAudit(
    db,
    { actorId: ctx.actorId ?? ctx.userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: 'LEGAL.DOCUMENT_ACCEPTED',
      entityType: 'USER',
      entityId: ctx.userId,
      after: { documentCode: input.documentCode, version: input.version },
      metadata,
    },
  );

  return { documentCode: input.documentCode, version: input.version, acceptedAt };
}

/** Latest accepted version per document code for a user, from the append-only log. */
export async function getAcceptedVersions(db: DB, userId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ metadata: consentEvents.metadata })
    .from(consentEvents)
    .where(and(eq(consentEvents.userId, userId), eq(consentEvents.consentType, 'LEGAL_DOCUMENT'), eq(consentEvents.action, 'ACCEPT')))
    .orderBy(desc(consentEvents.createdAt));
  const out: Record<string, string> = {};
  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const code = typeof m.documentCode === 'string' ? m.documentCode : null;
    const version = typeof m.version === 'string' ? m.version : null;
    if (code && version && !(code in out)) out[code] = version;
  }
  return out;
}

/**
 * The legal documents a user must (re-)accept, from the code catalogue versus
 * their recorded acceptances, scoped to the audiences their roles cover. A
 * missing acceptance and a stale version are both "needs acceptance"; a document
 * that is not yet published is never demanded, so the platform does not block
 * users on an unapproved draft; and a document whose audience does not match any
 * of the user's roles is never demanded either, so a buyer is never asked to
 * accept seller terms (LC-01.1, H1).
 *
 * `roles` is the caller's trusted role set (from the session) and is optional
 * for the audience-neutral call sites that pass no user; when it is absent or
 * empty, only `ALL` documents apply.
 */
export async function getPendingLegalAcceptances(
  db: DB,
  userId: string,
  catalogue: readonly LegalDocumentEntry[] = LEGAL_DOCUMENTS,
  roles: readonly string[] = [],
): Promise<Array<{ code: string; title: { ar: string; en: string }; version: string }>> {
  const accepted = await getAcceptedVersions(db, userId);
  return catalogue.filter(
    (d) =>
      d.acceptanceRequired &&
      isAcceptable(d) &&
      appliesToRoles(d, roles) &&
      needsReacceptance(d, accepted[d.code] ?? null),
  ).map((d) => ({ code: d.code, title: d.title, version: d.version }));
}

/**
 * The caller's own legal-acceptance history: one entry per acceptance act, from
 * the append-only log, newest first. Scoped to the given user id and never
 * exposing any other user's rows — the only caller passes the session user.
 * Only the fields needed to show "what you agreed to, when" are returned; the
 * captured client context (ip/user-agent) is deliberately omitted.
 */
export async function listLegalAcceptances(
  db: DB,
  userId: string,
): Promise<Array<{ documentCode: string; version: string; acceptedAt: string | null; locale: string | null }>> {
  const rows = await db
    .select({ metadata: consentEvents.metadata, createdAt: consentEvents.createdAt })
    .from(consentEvents)
    .where(
      and(
        eq(consentEvents.userId, userId),
        eq(consentEvents.consentType, 'LEGAL_DOCUMENT'),
        eq(consentEvents.action, 'ACCEPT'),
      ),
    )
    .orderBy(desc(consentEvents.createdAt));

  return rows.flatMap((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const documentCode = typeof m.documentCode === 'string' ? m.documentCode : null;
    const version = typeof m.version === 'string' ? m.version : null;
    if (!documentCode || !version) return [];
    return [
      {
        documentCode,
        version,
        acceptedAt: typeof m.acceptedAt === 'string' ? m.acceptedAt : r.createdAt.toISOString(),
        locale: typeof m.locale === 'string' ? m.locale : null,
      },
    ];
  });
}

export async function setConsent(
  db: DB,
  ctx: ConsentAuditContext,
  consentType: string,
  granted: boolean,
  source = 'USER',
): Promise<void> {
  const type = consentTypeLabel(consentType);
  const now = new Date();

  const existing = await db
    .select()
    .from(consents)
    .where(and(eq(consents.userId, ctx.userId), eq(consents.consentType, type)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(consents).values({
      id: newId(),
      userId: ctx.userId,
      consentType: type,
      granted,
      givenAt: granted ? now : null,
      revokedAt: granted ? null : now,
      metadata: { source },
    });
  } else {
    await db
      .update(consents)
      .set({
        granted,
        givenAt: granted ? (existing[0].givenAt ?? now) : existing[0].givenAt,
        revokedAt: granted ? null : now,
        metadata: {
          ...((existing[0].metadata as Record<string, unknown>) ?? {}),
          source,
          updatedAt: now.toISOString(),
        },
      })
      .where(eq(consents.id, existing[0].id));
  }

  // Append-only history
  await db.insert(consentEvents).values({
    id: newId(),
    userId: ctx.userId,
    consentType: type,
    action: granted ? 'GRANT' : 'REVOKE',
    granted,
    actorId: ctx.actorId ?? null,
    fromGranted: existing.length > 0 ? existing[0].granted : null,
    source,
    metadata: { consentLabel: type },
  });

  await writeAudit(
    db,
    { actorId: ctx.actorId ?? ctx.userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent },
    {
      action: granted ? 'PRIVACY.CONSENT_GRANT' : 'PRIVACY.CONSENT_REVOKE',
      entityType: 'USER',
      entityId: ctx.userId,
      after: { consentType: type, granted },
      metadata: { source },
    },
  );
}

// ---------------------------------------------------------------------------
// Data Export — ownership-bounded export with no secrets
// ---------------------------------------------------------------------------

export async function buildUserExport(db: DB, userId: string): Promise<Record<string, unknown>> {
  const [userRows, profileRows, consentRows, settingsRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        locale: users.locale,
        emailVerified: users.emailVerified,
        mfaEnabled: users.mfaEnabled,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({
        userId: profiles.userId,
        displayName: profiles.displayName,
        avatarUrl: profiles.avatarUrl,
        bio: profiles.bio,
        countryId: profiles.countryId,
        cityId: profiles.cityId,
        defaultCurrencyId: profiles.defaultCurrencyId,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1)
      .catch(() => []),
    listConsents(db, userId),
    db
      .select({
        require2FA: securitySettings.require2FA,
        loginNotifications: securitySettings.loginNotifications,
        deviceTracking: securitySettings.deviceTracking,
      })
      .from(securitySettings)
      .where(eq(securitySettings.userId, userId))
      .limit(1),
  ]);

  const user = userRows[0];
  if (!user) throw ApiError.notFound('User not found');
  const profile = profileRows[0];

  return {
    generatedAt: new Date().toISOString(),
    requestedBy: userId,
    account: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      locale: user.locale,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      createdAt: String(user.createdAt),
      updatedAt: String(user.updatedAt),
    },
    profile: profile
      ? {
          userId: profile.userId,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          countryId: profile.countryId,
          cityId: profile.cityId,
          defaultCurrencyId: profile.defaultCurrencyId,
        }
      : null,
    consents: consentRows.map((c) => ({
      type: c.consentType,
      granted: c.granted,
      givenAt: c.givenAt ? String(c.givenAt) : null,
      revokedAt: c.revokedAt ? String(c.revokedAt) : null,
    })),
    securityPreferences: settingsRows[0] ?? null,
    // Explicitly NO: password hashes, session tokens, MFA secrets, other users' data.
    _notice: 'Secrets (password hashes, tokens, MFA secrets) are never exported.',
  };
}

export async function createExportRequest(
  db: DB,
  userId: string,
  requestedBy: string,
): Promise<{ exportId: string; data: Record<string, unknown> }> {
  const data = await buildUserExport(db, userId);
  const exportId = newId();

  await db.insert(dataExportRequests).values({
    id: exportId,
    userId,
    requestedBy,
    format: 'json',
    status: 'COMPLETED',
    scope: {
      account: true,
      profile: true,
      consents: true,
      securityPreferences: true,
    },
    completedAt: new Date(),
  });

  await writeAudit(
    db,
    { actorId: requestedBy },
    {
      action: 'PRIVACY.DATA_EXPORT',
      entityType: 'USER',
      entityId: userId,
      metadata: { exportId },
    },
  );

  return { exportId, data };
}

// ---------------------------------------------------------------------------
// Data Deletion — staged workflow (no hard delete of financial/audit records)
// ---------------------------------------------------------------------------

export async function createDeletionRequest(
  db: DB,
  userId: string,
  requestedBy: string,
  reason?: string,
): Promise<{ requestId: string; stage: string }> {
  // Resolve retention from the Policy Engine (country-aware) BEFORE writing, so
  // the stored window and preserved-record list reflect configured law rather
  // than a value baked into the source.
  const retention = await resolveRetentionForUser(db, userId);

  // Deactivate the account immediately.
  await db.update(users).set({ isActive: false }).where(eq(users.id, userId));

  const requestId = newId();

  const retentionPolicy = {
    defaultRetentionDays: retention.rules.defaultRetentionDays,
    legalHoldFinanciallyRequired: retention.rules.legalHoldFinanciallyRequired,
    preserves: [...new Set([...PRESERVED_RECORD_TYPES, ...(retention.rules.preserves ?? [])])],
    policySource: retention.source,
    policyId: retention.policyId,
    policyVersion: retention.version,
    countryCode: retention.countryCode,
  };

  const retentionUntil = new Date(
    Date.now() + retention.rules.defaultRetentionDays * 86400_000,
  );

  await db.insert(dataDeletionRequests).values({
    id: requestId,
    userId,
    requestedBy,
    reason: reason ?? null,
    stage: 'DEACTIVATED',
    retentionPolicy,
    retentionUntil,
  });

  await writeAudit(
    db,
    { actorId: requestedBy },
    {
      action: 'PRIVACY.DELETION_REQUEST',
      entityType: 'USER',
      entityId: userId,
      after: {
        requestId,
        stage: 'DEACTIVATED',
        retentionUntil: String(retentionUntil),
        policySource: retention.source,
        retentionDays: retention.rules.defaultRetentionDays,
      },
      metadata: { reason: reason ?? null, countryCode: retention.countryCode },
    },
  );

  return { requestId, stage: 'DEACTIVATED' };
}

export async function getDeletionRequest(db: DB, userId: string) {
  const rows = await db
    .select()
    .from(dataDeletionRequests)
    .where(eq(dataDeletionRequests.userId, userId))
    .orderBy(dataDeletionRequests.createdAt)
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    requestId: r.id,
    stage: r.stage,
    reason: r.reason,
    retentionUntil: r.retentionUntil ? String(r.retentionUntil) : null,
    retentionPolicy: r.retentionPolicy,
    createdAt: String(r.createdAt),
  };
}

/** Admin: advance a deletion request through retention stages. */
export async function advanceDeletionStage(
  db: DB,
  requestId: string,
  stage: 'RETENTION' | 'REVIEW' | 'ELIGIBLE' | 'ANONYMIZED' | 'REJECTED',
  reviewerId: string,
  opts: { legalHoldOverride?: boolean } = {},
): Promise<{ stage: string; anonymized?: AnonymizationResult }> {
  const rows = await db
    .select()
    .from(dataDeletionRequests)
    .where(eq(dataDeletionRequests.id, requestId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('Deletion request not found');
  }
  const request = rows[0];

  if (stage === 'REJECTED') {
    // Reactivate the account when a deletion request is rejected.
    await db.update(users).set({ isActive: true }).where(eq(users.id, request.userId));
    await db
      .update(dataDeletionRequests)
      .set({ stage, reviewedBy: reviewerId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(eq(dataDeletionRequests.id, requestId));
    await writeAudit(
      db,
      { actorId: reviewerId },
      {
        action: 'PRIVACY.DELETION_REJECTED',
        entityType: 'USER',
        entityId: request.userId,
        after: { requestId, stage },
      },
    );
    return { stage };
  }

  // ANONYMIZED is the only irreversible stage: it scrubs PII. Refuse while a
  // retention/legal-hold window is still open unless an admin explicitly
  // overrides, so financial-record retention cannot be bypassed silently.
  if (stage === 'ANONYMIZED') {
    const windowOpen = request.retentionUntil != null && request.retentionUntil.getTime() > Date.now();
    if (windowOpen && !opts.legalHoldOverride) {
      throw ApiError.validation([
        {
          field: 'stage',
          message: `Retention window is open until ${request.retentionUntil?.toISOString()}`,
          code: 'RETENTION_WINDOW_OPEN',
        },
      ]);
    }
    if (windowOpen && opts.legalHoldOverride) {
      await writeAudit(
        db,
        { actorId: reviewerId },
        {
          action: 'PRIVACY.LEGAL_HOLD_OVERRIDE',
          entityType: 'USER',
          entityId: request.userId,
          metadata: { requestId, retentionUntil: request.retentionUntil?.toISOString() },
        },
      );
    }

    const result = await anonymizeUser(db, request.userId);
    const now = new Date();
    await db
      .update(dataDeletionRequests)
      .set({
        stage,
        reviewedBy: reviewerId,
        reviewedAt: now,
        completedAt: now,
        anonymizedAt: now,
        anonymizationLog: { fields: result.fields, at: now.toISOString(), by: reviewerId },
        updatedAt: now,
      })
      .where(eq(dataDeletionRequests.id, requestId));

    await writeAudit(
      db,
      { actorId: reviewerId },
      {
        action: 'PRIVACY.DELETION_ANONYMIZED',
        entityType: 'USER',
        entityId: request.userId,
        after: { requestId, stage, fields: result.fields },
        metadata: { legalHoldOverride: Boolean(opts.legalHoldOverride) },
      },
    );
    return { stage, anonymized: result };
  }

  const completedAt = stage === 'ELIGIBLE' ? new Date() : request.completedAt ?? null;
  await db
    .update(dataDeletionRequests)
    .set({
      stage,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      completedAt,
      updatedAt: new Date(),
    })
    .where(eq(dataDeletionRequests.id, requestId));

  await writeAudit(
    db,
    { actorId: reviewerId },
    {
      action: 'PRIVACY.DELETION_STAGE',
      entityType: 'USER',
      entityId: request.userId,
      after: { requestId, stage },
    },
  );
  return { stage };
}

/**
 * System job: move deletion requests forward once their retention window has
 * elapsed.
 *
 * A request is created in DEACTIVATED with a `retentionUntil` deadline resolved
 * from the Policy Engine. Nothing acted on that deadline before, so a request
 * could stay DEACTIVATED forever and only a human remembering the date would
 * move it. This sweep advances every request whose window has elapsed by one
 * stage per run:
 *   DEACTIVATED → RETENTION → ELIGIBLE
 *
 * The deadline is the gate, so requests still inside their window (including
 * freshly created ones) are never touched. The run is convergent rather than a
 * no-op: repeat runs walk a due request forward one stage at a time and stop at
 * ELIGIBLE. It deliberately does NOT anonymize — scrubbing PII is irreversible
 * and stays a reviewed, audited operator decision.
 *
 * Safe to run concurrently: each transition updates with a stage guard in the
 * WHERE clause, so a second worker (or a manual advance that raced it) affects
 * zero rows. Only rows the job actually moved are audited.
 */
export async function advanceDueDeletionRetentions(db: DB): Promise<{
  retained: number;
  eligible: number;
  requestIds: string[];
}> {
  const now = new Date();

  const due = await db
    .select({ id: dataDeletionRequests.id, stage: dataDeletionRequests.stage })
    .from(dataDeletionRequests)
    .where(
      and(
        inArray(dataDeletionRequests.stage, ['DEACTIVATED', 'RETENTION']),
        isNotNull(dataDeletionRequests.retentionUntil),
        lte(dataDeletionRequests.retentionUntil, now),
      ),
    );

  let retained = 0;
  let eligible = 0;
  const requestIds: string[] = [];

  for (const row of due) {
    const targetStage: DeletionStage = row.stage === 'DEACTIVATED' ? 'RETENTION' : 'ELIGIBLE';
    const updated = await db
      .update(dataDeletionRequests)
      .set({ stage: targetStage, updatedAt: new Date() })
      // Guard on the stage we read: if a human already moved it, this is a no-op.
      .where(and(eq(dataDeletionRequests.id, row.id), eq(dataDeletionRequests.stage, row.stage)))
      .returning({ id: dataDeletionRequests.id, userId: dataDeletionRequests.userId });
    if (updated.length === 0) continue;

    if (targetStage === 'RETENTION') retained += 1;
    else eligible += 1;
    requestIds.push(row.id);

    await writeAudit(
      db,
      { actorId: null },
      {
        action: 'PRIVACY.DELETION_STAGE',
        entityType: 'USER',
        entityId: updated[0].userId,
        before: { stage: row.stage },
        after: { requestId: row.id, stage: targetStage },
        metadata: { automated: true, job: 'retention-sweep' },
      },
    );
  }

  return { retained, eligible, requestIds };
}

/** Admin: list deletion requests. */
export async function listDeletionRequests(db: DB, stage?: string) {
  const conditions = stage
    ? [eq(dataDeletionRequests.stage, stage as DeletionStage)]
    : [];
  const rows = await db
    .select({
      requestId: dataDeletionRequests.id,
      userId: dataDeletionRequests.userId,
      stage: dataDeletionRequests.stage,
      reason: dataDeletionRequests.reason,
      requestedBy: dataDeletionRequests.requestedBy,
      retentionUntil: dataDeletionRequests.retentionUntil,
      retentionPolicy: dataDeletionRequests.retentionPolicy,
      createdAt: dataDeletionRequests.createdAt,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      isActive: users.isActive,
    })
    .from(dataDeletionRequests)
    .leftJoin(users, eq(dataDeletionRequests.userId, users.id))
    .where(conditions.length ? (conditions[0] as never) : undefined)
    .orderBy(desc(dataDeletionRequests.createdAt));
  return rows.map((r) => ({
    requestId: r.requestId,
    userId: r.userId,
    userEmail: r.email,
    userName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    accountActive: r.isActive,
    stage: r.stage,
    reason: r.reason,
    requestedBy: r.requestedBy,
    retentionUntil: r.retentionUntil ? String(r.retentionUntil) : null,
    retentionPolicy: r.retentionPolicy,
    createdAt: String(r.createdAt),
  }));
}
