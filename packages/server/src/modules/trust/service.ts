import { desc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { trustScores } from '../../db/schema/trust';
import { users } from '../../db/schema/auth';
import { computeTrustScore, explainTrustScore } from '../../lib/trust-engine';

export interface TrustScoreRow {
  id: string;
  userId: string;
  score: number;
  level: string;
  factors: Record<string, unknown>;
  summary: string | null;
  effectiveAt: string;
}

function mapRow(row: typeof trustScores.$inferSelect): TrustScoreRow {
  return {
    id: row.id,
    userId: row.userId,
    score: row.score,
    level: row.level,
    factors: (row.factors ?? {}) as Record<string, unknown>,
    summary: row.summary,
    effectiveAt: row.effectiveAt.toISOString(),
  };
}

/** Latest cached trust snapshot for a user (null if never computed). */
export async function getLatestTrustScore(db: DB, userId: string): Promise<TrustScoreRow | null> {
  const rows = await db
    .select()
    .from(trustScores)
    .where(eq(trustScores.userId, userId))
    .orderBy(desc(trustScores.effectiveAt))
    .limit(1);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Full trust history (each snapshot) for a user — explainable score over time. */
export async function getTrustScoreHistory(db: DB, userId: string): Promise<TrustScoreRow[]> {
  const rows = await db
    .select()
    .from(trustScores)
    .where(eq(trustScores.userId, userId))
    .orderBy(desc(trustScores.effectiveAt))
    .limit(200);
  return rows.map(mapRow);
}

/** Computes a fresh trust score, persists a snapshot, and returns it + history. */
export async function recomputeTrust(db: DB, userId: string): Promise<{
  score: TrustScoreRow;
  history: TrustScoreRow[];
}> {
  const result = await computeTrustScore(db, userId);
  const history = await getTrustScoreHistory(db, userId);
  return {
    score: {
      id: '',
      userId,
      score: result.score,
      level: result.level,
      factors: result.factors as unknown as Record<string, unknown>,
      summary: result.summary,
      effectiveAt: new Date().toISOString(),
    },
    history,
  };
}

/** Trust overview: snapshot + derived explanation string. */
export async function getTrustOverview(db: DB, userId: string): Promise<{
  latest: TrustScoreRow | null;
  explanation: string | null;
  historyCount: number;
}> {
  const latest = await getLatestTrustScore(db, userId);
  if (!latest) {
    return { latest: null, explanation: null, historyCount: 0 };
  }
  const explanation = explainTrustScore(latest.score, latest.factors);
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(trustScores)
    .where(eq(trustScores.userId, userId));
  return { latest, explanation, historyCount: Number(counts[0]?.count ?? 0) };
}

/** Admin: list snapshots for users (latest per user). */
export async function listAllLatestTrustScores(db: DB): Promise<Array<TrustScoreRow & { email: string | null }>> {
  const rows = await db
    .select({
      id: trustScores.id,
      userId: trustScores.userId,
      score: trustScores.score,
      level: trustScores.level,
      factors: trustScores.factors,
      summary: trustScores.summary,
      effectiveAt: trustScores.effectiveAt,
      email: users.email,
    })
    .from(trustScores)
    .leftJoin(users, eq(users.id, trustScores.userId))
    .where(eq(users.isActive, true))
    .orderBy(desc(trustScores.effectiveAt));

  // Dedupe to latest per user (query ordered by effectiveAt desc then take first per user)
  const seen = new Set<string>();
  const latest: Array<TrustScoreRow & { email: string | null }> = [];
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    latest.push({
      id: r.id,
      userId: r.userId,
      score: r.score,
      level: r.level,
      factors: (r.factors ?? {}) as Record<string, unknown>,
      summary: r.summary,
      effectiveAt: r.effectiveAt.toISOString(),
      email: r.email,
    });
  }
  return latest.slice(0, 200);
}

export async function adminRecomputeFor(db: DB, userId: string, actorId: string): Promise<TrustScoreRow> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw ApiError.notFound('User');
  await computeTrustScore(db, userId);
  const latest = await getLatestTrustScore(db, userId);
  if (!latest) throw ApiError.internal('Trust recompute failed');
  return latest;
}

export { ApiError };