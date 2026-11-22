import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { threads, messages } from '../src/db/schema/messaging.js';
import { createAgentTask } from '../src/modules/ai/agents.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * Support Agent — row filtering for non-staff requesters.
 *
 * The executor used to return the newest unread messages platform-wide, so a
 * customer holding `ai:use` could read other users' message bodies. It now
 * scopes threads and messages to the requester's participation unless the
 * requester is a support desk (ADMIN / SUPER_ADMIN / SUPPORT).
 */

const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdThreadIds: string[] = [];
const createdMessageIds: string[] = [];
const AUDIT = { actorId: 'it-support-scope', ipAddress: null, userAgent: null };

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-support-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

async function createThread(participants: string[], body: string, senderId: string): Promise<{ threadId: string; messageId: string }> {
  const threadId = randomUUID();
  await db.insert(threads).values({ id: threadId, participantIds: participants, subject: 'IT support thread' });
  createdThreadIds.push(threadId);
  const messageId = randomUUID();
  await db.insert(messages).values({ id: messageId, threadId, senderId, body, status: 'SENT', readAt: null });
  createdMessageIds.push(messageId);
  return { threadId, messageId };
}

async function runSupport(requesterId: string, rolesOf: string[]) {
  const task = await createAgentTask(
    db,
    rolesOf as never,
    requesterId,
    { agentKey: 'support-agent', requestedBy: requesterId, input: { limit: 50 } },
    AUDIT,
  );
  createdTaskIds.push(task.id);
  expect(task.status).toBe('succeeded');
  const advice = JSON.parse((task.result as { advice: string }).advice);
  return advice as {
    dataScope: string;
    snapshot: {
      activeThreads: number;
      unreadMessages: number;
      activeUsers: number | null;
      recentUnread: Array<{ id: string; body: string }>;
    };
  };
}

afterAll(async () => {
  if (createdMessageIds.length > 0) await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  if (createdThreadIds.length > 0) await db.delete(threads).where(inArray(threads.id, createdThreadIds));
  await cleanupOwnedRows(db, { userIds: createdUserIds, taskIds: createdTaskIds });
  await closeDb();
});

describe('AI — Support Agent data scope', () => {
  it('shows a customer only the threads they take part in', async () => {
    const a = await createUser('CUSTOMER');
    const b = await createUser('CUSTOMER');
    const c = await createUser('CUSTOMER');
    const mine = await createThread([a, b], 'message between A and B', b);
    const foreign = await createThread([b, c], 'message between B and C', c);

    const advice = await runSupport(a, ['CUSTOMER']);

    expect(advice.dataScope).toBe('own');
    const ids = advice.snapshot.recentUnread.map((m) => m.id);
    expect(ids).toContain(mine.messageId);
    expect(ids).not.toContain(foreign.messageId);
    expect(advice.snapshot.recentUnread.every((m) => !m.body.includes('B and C'))).toBe(true);
    expect(advice.snapshot.activeThreads).toBe(1);
    expect(advice.snapshot.unreadMessages).toBe(1);
    // Platform-wide user counts are staff information.
    expect(advice.snapshot.activeUsers).toBeNull();
  });

  it('shows a support desk every thread and the platform counts', async () => {
    const a = await createUser('CUSTOMER');
    const b = await createUser('CUSTOMER');
    const c = await createUser('CUSTOMER');
    const mine = await createThread([a, b], 'message between A and B', b);
    const other = await createThread([b, c], 'message between B and C', c);
    const staff = await createUser('SUPPORT');

    const advice = await runSupport(staff, ['SUPPORT']);

    expect(advice.dataScope).toBe('platform');
    const ids = advice.snapshot.recentUnread.map((m) => m.id);
    expect(ids).toContain(mine.messageId);
    expect(ids).toContain(other.messageId);
    expect(advice.snapshot.activeUsers).toBeGreaterThanOrEqual(3);
  });

  it('never leaks another tenant through the unread counter', async () => {
    const a = await createUser('CUSTOMER');
    const b = await createUser('CUSTOMER');
    await createThread([b], 'private to B', b);

    const advice = await runSupport(a, ['CUSTOMER']);
    expect(advice.snapshot.unreadMessages).toBe(0);
    expect(advice.snapshot.recentUnread).toEqual([]);
  });
});
