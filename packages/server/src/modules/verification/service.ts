import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { users } from '../../db/schema/auth';
import {
  verificationDocuments,
  verificationRequests,
  type verificationLevelEnum,
  type verificationStatusEnum,
} from '../../db/schema/trust';
import { policies } from '../../db/schema/engine';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service';
import { newId } from '../../lib/ids';

export type VerificationLevel = (typeof verificationLevelEnum.enumValues)[number];
export type VerificationStatus = (typeof verificationStatusEnum.enumValues)[number];

export const VERIFICATION_LEVEL_ORDER: Record<VerificationLevel, number> = {
  NONE: 0,
  BASIC: 1,
  VERIFIED: 2,
  BUSINESS_VERIFIED: 3,
  INTERNATIONAL_VERIFIED: 4,
};

export interface VerificationPolicyRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  isActive: boolean;
}

/** Highest currently approved verification level for a user. */
export async function currentVerificationLevel(db: DB, userId: string): Promise<VerificationLevel> {
  const rows = await db
    .select({ targetLevel: verificationRequests.targetLevel })
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.userId, userId),
      eq(verificationRequests.status, 'APPROVED'),
    ));
  let best: VerificationLevel = 'NONE';
  for (const r of rows) {
    if (VERIFICATION_LEVEL_ORDER[r.targetLevel] > VERIFICATION_LEVEL_ORDER[best]) {
      best = r.targetLevel;
    }
  }
  return best;
}

/** Lists active verification policies from the Policy Engine (scope=VERIFICATION). */
export async function listVerificationPolicies(db: DB): Promise<VerificationPolicyRow[]> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(
      eq(policies.scope, 'VERIFICATION'),
      eq(policies.isActive, true),
    ))
    .orderBy(asc(policies.code));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    rules: (r.rules ?? {}) as Record<string, unknown>,
    isActive: r.isActive,
  }));
}

export interface SubmitVerificationInput {
  targetLevel: VerificationLevel;
  documentType?: string;
  documentRef?: string;
  isBusiness?: boolean;
  businessId?: string;
}

/** Submits a new verification request for a target level (one active at a time). */
export async function submitVerificationRequest(
  db: DB,
  userId: string,
  input: SubmitVerificationInput,
  ctx: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string }> {
  if (!VERIFICATION_LEVEL_ORDER[input.targetLevel] || input.targetLevel === 'NONE') {
    throw ApiError.validation([
      { field: 'targetLevel', message: `Invalid verification target level: ${input.targetLevel}`, code: 'VALIDATION_FAILED' },
    ]);
  }

  const current = await currentVerificationLevel(db, userId);
  if (VERIFICATION_LEVEL_ORDER[input.targetLevel] <= VERIFICATION_LEVEL_ORDER[current]) {
    throw ApiError.conflict(
      `Your current verification level is ${current}. Request a higher level.`,
    );
  }

  // One pending/in-review request per user at a time
  const active = await db
    .select({ id: verificationRequests.id })
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.userId, userId),
      sql`status in ('PENDING', 'SUBMITTED', 'IN_REVIEW')`,
    ))
    .limit(1);
  if (active.length > 0) {
    throw ApiError.conflict('You already have an active verification request');
  }

  const id = newId();
  await db.insert(verificationRequests).values({
    id,
    userId,
    targetLevel: input.targetLevel,
    status: 'SUBMITTED',
    documentType: input.documentType ?? null,
    documentRef: input.documentRef ?? null,
    isBusiness: input.isBusiness ?? false,
    businessId: input.businessId ?? null,
    submittedAt: new Date(),
  });

  if (input.documentType && input.documentRef) {
    await db.insert(verificationDocuments).values({
      id: newId(),
      requestId: id,
      type: input.documentType,
      fileRef: input.documentRef,
      uploadedById: userId,
    });
  }

  await writeAudit(db, { actorId: ctx.actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'VERIFICATION.SUBMITTED',
    entityType: 'VERIFICATION_REQUEST',
    entityId: id,
    after: { targetLevel: input.targetLevel, userId, isBusiness: input.isBusiness ?? false },
  });

  return { id };
}

export interface VerificationRequestRow {
  id: string;
  targetLevel: VerificationLevel;
  status: VerificationStatus;
  documentType: string | null;
  documentRef: string | null;
  isBusiness: boolean;
  businessId: string | null;
  reviewNotes: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** Lists the current user's verification requests (newest first). */
export async function listMyVerificationRequests(db: DB, userId: string): Promise<VerificationRequestRow[]> {
  const rows = await db
    .select()
    .from(verificationRequests)
    .where(eq(verificationRequests.userId, userId))
    .orderBy(desc(verificationRequests.createdAt));
  return rows.map((r) => ({
    id: r.id,
    targetLevel: r.targetLevel,
    status: r.status,
    documentType: r.documentType,
    documentRef: r.documentRef,
    isBusiness: r.isBusiness,
    businessId: r.businessId,
    reviewNotes: r.reviewNotes,
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface VerificationStatusOverview {
  currentLevel: VerificationLevel;
  emailVerified: boolean;
  phoneVerified: boolean;
  activeRequest: VerificationRequestRow | null;
  recentRequests: VerificationRequestRow[];
  nextStep: string | null;
}

/** Aggregates the user's current verification state (UI-facing). */
export async function getMyVerificationStatus(db: DB, userId: string): Promise<VerificationStatusOverview> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw ApiError.notFound('User');

  const all = await listMyVerificationRequests(db, userId);
  const currentLevel = await currentVerificationLevel(db, userId);
  const activeRequest = all.find((r) => ['PENDING', 'SUBMITTED', 'IN_REVIEW'].includes(r.status)) ?? null;

  let nextStep: string | null = null;
  const candidates: VerificationLevel[] = ['BASIC', 'VERIFIED', 'BUSINESS_VERIFIED', 'INTERNATIONAL_VERIFIED'];
  const nextLevel = candidates.find((l) => VERIFICATION_LEVEL_ORDER[l] > VERIFICATION_LEVEL_ORDER[currentLevel]);
  if (nextLevel) {
    if (activeRequest) {
      nextStep = `pending ${activeRequest.targetLevel}`;
    } else {
      nextStep = nextLevel;
    }
  }

  return {
    currentLevel,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    activeRequest,
    recentRequests: all,
    nextStep,
  };
}

// ---------- Admin ----------

export interface AdminRequestListQuery {
  status?: VerificationStatus;
  level?: VerificationLevel;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminVerificationRequestRow extends VerificationRequestRow {
  userId: string;
  email: string | null;
}

export async function listAllVerificationRequests(
  db: DB,
  query: AdminRequestListQuery = {},
): Promise<{ items: AdminVerificationRequestRow[]; page: number; pageSize: number; total: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof sql>)[] = [];
  if (query.status) conditions.push(eq(verificationRequests.status, query.status));
  if (query.level) conditions.push(eq(verificationRequests.targetLevel, query.level));
  if (query.q) {
    conditions.push(sql`(
      ${verificationRequests.userId} in (select u.id from users u where u.email ilike ${`%${query.q}%`})
    )`);
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(verificationRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const rows = await db
    .select({
      id: verificationRequests.id,
      userId: verificationRequests.userId,
      email: users.email,
      targetLevel: verificationRequests.targetLevel,
      status: verificationRequests.status,
      documentType: verificationRequests.documentType,
      isBusiness: verificationRequests.isBusiness,
      reviewNotes: verificationRequests.reviewNotes,
      submittedAt: verificationRequests.submittedAt,
      decidedAt: verificationRequests.decidedAt,
      createdAt: verificationRequests.createdAt,
    })
    .from(verificationRequests)
    .leftJoin(users, eq(users.id, verificationRequests.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(verificationRequests.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.email ?? null,
      targetLevel: r.targetLevel,
      status: r.status,
      documentType: r.documentType,
      documentRef: (r as unknown as { documentRef: string | null }).documentRef ?? null,
      isBusiness: r.isBusiness,
      businessId: (r as unknown as { businessId: string | null }).businessId ?? null,
      reviewNotes: r.reviewNotes,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total: Number(total),
  };
}

export type ReviewDecision = 'APPROVED' | 'REJECTED';

export async function reviewVerificationRequest(
  db: DB,
  requestId: string,
  actorId: string,
  input: { decision: ReviewDecision; notes?: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string }> {
  const [request] = await db
    .select()
    .from(verificationRequests)
    .where(eq(verificationRequests.id, requestId))
    .limit(1);
  if (!request) throw ApiError.notFound('Verification request');
  if (request.status === 'APPROVED' || request.status === 'REJECTED') {
    throw ApiError.conflict('Verification request already decided');
  }

  // Rejecting a higher-level request must not downgrade an already held level.
  await db
    .update(verificationRequests)
    .set({
      status: input.decision,
      reviewedById: actorId,
      reviewNotes: input.notes ?? request.reviewNotes,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(verificationRequests.id, requestId));

  await writeAudit(db, { actorId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: input.decision === 'APPROVED' ? 'VERIFICATION.APPROVED' : 'VERIFICATION.REJECTED',
    entityType: 'VERIFICATION_REQUEST',
    entityId: requestId,
    before: { status: request.status },
    after: { status: input.decision, notes: input.notes ?? null },
    metadata: { targetLevel: request.targetLevel, userId: request.userId },
  });

  await createNotification(db, {
    userId: request.userId,
    type: 'VERIFICATION.DECISION',
    title: 'Verification update',
    body: input.decision === 'APPROVED'
      ? `Your verification request for ${request.targetLevel} was approved.`
      : `Your verification request for ${request.targetLevel} was rejected${input.notes ? `: ${input.notes}` : '.'}`,
    data: { requestId, targetLevel: request.targetLevel, decision: input.decision },
  });

  return { id: requestId };
}