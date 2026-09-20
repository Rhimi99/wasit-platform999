import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { riskEvents, riskProfiles } from '../../db/schema/risk';
import { users } from '../../db/schema/auth';
import { assessRisk, levelForScore } from '../../lib/risk-engine';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service';
import { newId } from '../../lib/ids';

export interface RiskProfileRow {
  userId: string;
  email: string | null;
  currentScore: number;
  level: string;
  lastEvaluatedAt: string;
  flags: Record<string, unknown>;
}

/** Latest profile for every user with a non-default assessment (admin/RISK/SUPPORT). */
export async function listRiskProfiles(db: DB): Promise<RiskProfileRow[]> {
  const rows = await db
    .select({
      userId: riskProfiles.userId,
      currentScore: riskProfiles.currentScore,
      level: riskProfiles.level,
      lastEvaluatedAt: riskProfiles.lastEvaluatedAt,
      flags: riskProfiles.flags,
      email: users.email,
    })
    .from(riskProfiles)
    .leftJoin(users, eq(users.id, riskProfiles.userId))
    .orderBy(desc(riskProfiles.currentScore))
    .limit(200);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    currentScore: r.currentScore,
    level: r.level,
    lastEvaluatedAt: r.lastEvaluatedAt.toISOString(),
    flags: (r.flags ?? {}) as Record<string, unknown>,
  }));
}

export interface RiskEventRow {
  id: string;
  userId: string;
  eventType: string;
  severity: string;
  riskScore: number;
  reasonCode: string;
  recommendedAction: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export async function listRiskEvents(
  db: DB,
  query: { userId?: string; level?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: RiskEventRow[]; page: number; pageSize: number; total: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const conditions: ReturnType<typeof eq>[] = [];
  if (query.userId) conditions.push(eq(riskEvents.userId, query.userId));
  if (query.level) conditions.push(eq(riskEvents.severity, query.level as never));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(riskEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const rows = await db
    .select()
    .from(riskEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(riskEvents.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      eventType: r.eventType,
      severity: r.severity,
      riskScore: r.riskScore,
      reasonCode: r.reasonCode,
      recommendedAction: r.recommendedAction,
      details: (r.details ?? {}) as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total: Number(total),
  };
}

export interface RiskProfileDetail extends RiskProfileRow {
  events: RiskEventRow[];
}

/** Full profile for a single user including event history. */
export async function getRiskProfile(db: DB, userId: string): Promise<RiskProfileDetail | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw ApiError.notFound('User');

  const profileRows = await db
    .select()
    .from(riskProfiles)
    .where(eq(riskProfiles.userId, userId))
    .limit(1);

  const eventsRows = await db
    .select()
    .from(riskEvents)
    .where(eq(riskEvents.userId, userId))
    .orderBy(desc(riskEvents.createdAt))
    .limit(100);

  const profile = profileRows[0];
  return {
    userId,
    email: user.email,
    currentScore: profile?.currentScore ?? 0,
    level: profile?.level ?? 'LOW',
    lastEvaluatedAt: (profile?.lastEvaluatedAt ?? new Date()).toISOString(),
    flags: (profile?.flags ?? {}) as Record<string, unknown>,
    events: eventsRows.map((r) => ({
      id: r.id,
      userId: r.userId,
      eventType: r.eventType,
      severity: r.severity,
      riskScore: r.riskScore,
      reasonCode: r.reasonCode,
      recommendedAction: r.recommendedAction,
      details: (r.details ?? {}) as Record<string, unknown> | null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** Re-runs the Risk Engine for a user and records the outcome + audit + notification. */
export async function reassessUserRisk(db: DB, userId: string, actorId: string): Promise<RiskProfileDetail> {
  await getRiskProfile(db, userId); // verifies the user exists
  const result = await assessRisk(db, userId);

  await writeAudit(db, { actorId }, {
    action: 'RISK.REASSESS',
    entityType: 'USER',
    entityId: userId,
    after: { score: result.score, level: result.level, action: result.recommendedAction },
  });

  // Notify the risk team if the level is elevated.
  if (result.level === 'HIGH' || result.level === 'SEVERE') {
    const admins = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.isActive, true), sql`id in (select user_id from user_roles where role_id in (select id from roles where name in ('RISK', 'ADMIN', 'SUPER_ADMIN')))`))
      .limit(50);
    for (const a of admins) {
      await createNotification(db, {
        userId: a.id,
        type: 'RISK.ALERT',
        title: 'Risk alert',
        body: `User ${userId} risk level is ${result.level}. Recommended action: ${result.recommendedAction}.`,
        data: { userId, level: result.level, score: result.score, action: result.recommendedAction },
      });
    }
  }

  return getRiskProfile(db, userId) as Promise<RiskProfileDetail>;
}

/**
 * Records a single, already-classified risk signal as a risk event and folds it
 * into the user's profile score. Used by the anti-fee-evasion detector, which
 * passes signal codes only (never the message text). Kept separate from
 * assessRisk so a live event does not trigger a full re-assessment on every
 * message, and so the score is monotonic until the next reassessment.
 */
export async function recordRiskSignal(
  db: DB,
  input: {
    userId: string;
    eventType: string;
    reasonCode: string;
    severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';
    weight: number;
    details?: Record<string, unknown>;
    recommendedAction?: string;
  },
): Promise<void> {
  const severity = input.severity ?? 'MEDIUM';
  await db.insert(riskEvents).values({
    id: newId(),
    userId: input.userId,
    eventType: input.eventType,
    severity,
    riskScore: input.weight,
    reasonCode: input.reasonCode,
    recommendedAction: input.recommendedAction ?? 'REVIEW',
    details: input.details ?? null,
  });

  const existing = await db
    .select()
    .from(riskProfiles)
    .where(eq(riskProfiles.userId, input.userId))
    .limit(1);

  if (existing.length > 0) {
    const nextScore = Math.min(100, existing[0].currentScore + input.weight);
    const nextLevel = levelForScore(nextScore);
    const flags = (existing[0].flags ?? {}) as { reasonCodes?: string[] };
    const codes = new Set([...(flags.reasonCodes ?? []), input.reasonCode]);
    await db
      .update(riskProfiles)
      .set({
        currentScore: nextScore,
        level: nextLevel,
        lastEvaluatedAt: new Date(),
        updatedAt: new Date(),
        flags: { reasonCodes: [...codes] },
      })
      .where(eq(riskProfiles.id, existing[0].id));
  } else {
    await db.insert(riskProfiles).values({
      id: newId(),
      userId: input.userId,
      currentScore: Math.min(100, input.weight),
      level: levelForScore(Math.min(100, input.weight)),
      flags: { reasonCodes: [input.reasonCode] },
    });
  }
}

export { ApiError };