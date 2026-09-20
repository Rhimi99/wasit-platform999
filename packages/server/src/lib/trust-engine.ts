import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { users } from '../db/schema/auth';
import { trustScores, verificationRequests } from '../db/schema/trust';
import { disputes } from '../db/schema/disputes';
import { transactions } from '../db/schema/commerce';
import { resolveOwnedSellerIds } from './seller-ownership';
import { newId } from './ids';

export type TrustFactors = {
  accountAgeDays: number;
  emailVerified: boolean;
  phoneVerified: boolean;
  verificationLevel: number;
  successfulTransactions: number;
  totalTransactions: number;
  disputeCount: number;
  complaintsCount: number;
  profileCompleteness: number;
  businessVerified: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function levelForScore(score: number): string {
  if (score < 40) return 'LOW';
  if (score < 60) return 'BASIC';
  if (score < 80) return 'GOOD';
  return 'EXCELLENT';
}

const MAX_SCORE = 100;
const MIN_SCORE = 0;

/**
 * The Trust Engine computes a transparent, explainable trust score per user.
 * Every factor carries weight; the summary explains why the score is what it is.
 */
export async function computeTrustScore(db: DB, userId: string): Promise<{
  score: number;
  level: string;
  factors: TrustFactors;
  summary: string;
}> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`User ${userId} not found`);

  const accountAgeDays = Math.max(
    0,
    Math.floor((Date.now() - user.createdAt.getTime()) / 86400000),
  );

  const verificationRows = await db
    .select()
    .from(verificationRequests)
    .where(
      and(eq(verificationRequests.userId, userId), eq(verificationRequests.status, 'APPROVED')),
    );

  const verificationLevel = Math.max(
    0,
    ...verificationRows.map((v) =>
      v.targetLevel === 'BASIC'
        ? 1
        : v.targetLevel === 'VERIFIED'
          ? 2
          : v.targetLevel === 'BUSINESS_VERIFIED'
            ? 3
            : v.targetLevel === 'INTERNATIONAL_VERIFIED'
              ? 4
              : 0,
    ),
  );

  const txResult = await db
    .select({
      total: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where status = 'PAID')::int`,
    })
    .from(transactions)
    .where(
      eq(transactions.sellerId, userId),
    );

  let totalTransactions = txResult[0]?.total ?? 0;
  let successfulTransactions = txResult[0]?.successful ?? 0;

  // Seller transactions are stored against seller entity ids; aggregate the
  // entities owned by this user so the score reflects all their activity.
  const ownedSellers = await resolveOwnedSellerIds(db, userId);
  if (ownedSellers.length > 0) {
    const entityTx = await db
      .select({
        total: sql<number>`count(*)::int`,
        successful: sql<number>`count(*) filter (where status = 'PAID')::int`,
      })
      .from(transactions)
      .where(inArray(transactions.sellerId, ownedSellers));
    totalTransactions += entityTx[0]?.total ?? 0;
    successfulTransactions += entityTx[0]?.successful ?? 0;
  }

  const disputeCountRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(disputes)
    .where(eq(disputes.openedById, userId));
  const disputeCount = disputeCountRow[0]?.count ?? 0;

  const factors: TrustFactors = {
    accountAgeDays,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    verificationLevel,
    successfulTransactions,
    totalTransactions,
    disputeCount,
    complaintsCount: 0,
    profileCompleteness: 50,
    businessVerified: verificationLevel >= 3,
  };

  let score = 30; // base

  // Account age: up to +10 points
  score += clamp(accountAgeDays / 30, 0, 1) * 10;

  if (user.emailVerified) score += 5;
  if (user.phoneVerified) score += 5;

  // Verification level: up to +20
  score += verificationLevel * 5;

  // Transaction history: up to +20 (ratio of successful)
  if (totalTransactions > 0) {
    const successRatio = successfulTransactions / totalTransactions;
    score += clamp(successRatio, 0, 1) * 20;
  }

  // Disputes lower the score: each dispute -10
  score -= disputeCount * 10;

  // Business verification bonus +5
  if (factors.businessVerified) score += 5;

  score = clamp(Math.round(score), MIN_SCORE, MAX_SCORE);
  const level = levelForScore(score);

  const reasons: string[] = [];
  if (user.emailVerified) reasons.push('email verified');
  if (user.phoneVerified) reasons.push('phone verified');
  if (verificationLevel >= 1) reasons.push(`verification level ${verificationLevel}`);
  if (totalTransactions > 0) reasons.push(`${successfulTransactions}/${totalTransactions} successful transactions`);
  if (disputeCount > 0) reasons.push(`${disputeCount} disputes`);
  if (reasons.length === 0) reasons.push('no significant activity yet');

  const summary = `Score ${score} (${level}). ${reasons.join(', ')}.`;

  // Persist snapshot
  await db.insert(trustScores).values({
    id: newId(),
    userId,
    score,
    level,
    factors: factors as unknown as Record<string, unknown>,
    summary,
    effectiveAt: new Date(),
  });

  return { score, level, factors, summary };
}

export function explainTrustScore(score: number, factorsValue: unknown): string {
  const factors = factorsValue as TrustFactors;
  const parts = [
    `Account active ${factors.accountAgeDays} days`,
    factors.emailVerified ? 'email verified' : 'email not verified',
    factors.phoneVerified ? 'phone verified' : 'phone not verified',
    `Verification level ${factors.verificationLevel}`,
    `${factors.successfulTransactions}/${factors.totalTransactions} successful transactions`,
    `Disputes: ${factors.disputeCount}`,
  ];
  return `Score ${score}. ${parts.join(', ')}.`;
}