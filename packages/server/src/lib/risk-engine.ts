import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { riskEvents, riskProfiles } from '../db/schema/risk';
import { disputes } from '../db/schema/disputes';
import { transactions } from '../db/schema/commerce';
import { sessions } from '../db/schema/auth';
import { newId } from './ids';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE';

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  reasons: { code: string; weight: number; message: string }[];
  recommendedAction: string;
}

export function levelForScore(score: number): RiskLevel {
  if (score >= 80) return 'SEVERE';
  if (score >= 55) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

export function recommendedActionFor(level: RiskLevel): string {
  switch (level) {
    case 'LOW':
      return 'ALLOW';
    case 'MEDIUM':
      return 'REVIEW';
    case 'HIGH':
      return 'ESCALATE';
    case 'SEVERE':
      return 'BLOCK';
  }
}

/**
 * The Risk Engine is deliberately separate from the Trust Engine.
 * It scores abnormal/fraud signals independently and produces
 * an actionable recommendation with reason codes.
 */
export async function assessRisk(db: DB, userId: string): Promise<RiskAssessment> {
  const reasons: RiskAssessment['reasons'] = [];
  let score = 0;

  // Signal 1: repeated disputes
  const openDisputes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(disputes)
    .where(and(eq(disputes.openedById, userId), sql`status in ('OPEN','UNDER_REVIEW')`));
  const openDisputeCount = openDisputes[0]?.count ?? 0;
  if (openDisputeCount > 2) {
    score += 25;
    reasons.push({ code: 'REPEATED_DISPUTES', weight: 25, message: `${openDisputeCount} open disputes` });
  } else if (openDisputeCount > 0) {
    score += 10;
    reasons.push({ code: 'OPEN_DISPUTE', weight: 10, message: 'Has at least one open dispute' });
  }

  // Signal 2: many sessions (possible account sharing / automated access)
  const sessionCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), sql`revoked_at is null`));
  const sessionsCount = sessionCount[0]?.count ?? 0;
  if (sessionsCount > 10) {
    score += 15;
    reasons.push({ code: 'MANY_SESSIONS', weight: 15, message: `Active sessions: ${sessionsCount}` });
  }

  // Signal 3: failed payment attempts / abnormal transaction pattern
  const failedTx = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(eq(transactions.buyerId, userId), eq(transactions.status, 'FAILED')));
  const failedCount = failedTx[0]?.count ?? 0;
  if (failedCount >= 3) {
    score += 20;
    reasons.push({ code: 'REPEATED_PAYMENT_FAILURES', weight: 20, message: `${failedCount} failed payments` });
  }

  // Signal 4: high dispute to transaction ratio
  const totals = await db
    .select({
      total: sql<number>`count(*)::int`,
      withDispute: sql<number>`count(*) filter (where order_id in (select order_id from disputes))::int`,
    })
    .from(transactions)
    .where(eq(transactions.buyerId, userId));
  const totalTx = totals[0]?.total ?? 0;
  const disputedTx = totals[0]?.withDispute ?? 0;
  if (totalTx > 0 && disputedTx / totalTx > 0.3) {
    score += 20;
    reasons.push({ code: 'HIGH_DISPUTE_RATIO', weight: 20, message: `${disputedTx}/${totalTx} transactions disputed` });
  }

  score = Math.max(0, Math.min(100, score));
  const level = levelForScore(score);
  const recommendedAction = recommendedActionFor(level);

  // Persist risk event and profile
  if (reasons.length > 0) {
    await db.insert(riskEvents).values({
      id: newId(),
      userId,
      eventType: 'RISK_ASSESSMENT',
      severity: level,
      riskScore: score,
      reasonCode: reasons.map((r) => r.code).join('|'),
      recommendedAction,
      details: { reasons },
    });
  }

  const existing = await db
    .select()
    .from(riskProfiles)
    .where(eq(riskProfiles.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(riskProfiles)
      .set({
        currentScore: score,
        level,
        lastEvaluatedAt: new Date(),
        flags: reasons.length > 0 ? { reasonCodes: reasons.map((r) => r.code) } : {},
      })
      .where(eq(riskProfiles.id, existing[0].id));
  } else {
    await db.insert(riskProfiles).values({
      id: newId(),
      userId,
      currentScore: score,
      level,
      flags: reasons.length > 0 ? { reasonCodes: reasons.map((r) => r.code) } : {},
    });
  }

  return { score, level, reasons, recommendedAction };
}