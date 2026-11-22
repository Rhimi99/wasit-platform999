import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/client';
import { sessions } from '../db/schema/auth';

/**
 * Revokes every live session of one account.
 *
 * Used by the operator recovery tool when a factor is removed: any session
 * issued while the old factor was in force must not survive its removal. The
 * account then has to authenticate again from scratch.
 */
export async function revokeAllSessionsForUser(db: DB, userId: string): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}
