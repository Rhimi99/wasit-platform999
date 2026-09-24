import { and, asc, desc, eq, inArray, isNotNull, like, ne, or, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { messages, notifications, threadParticipants, threads } from '../../db/schema/messaging';
import { profiles } from '../../db/schema/trade';
import { users } from '../../db/schema/auth';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { detectOffPlatformSignals } from '../../lib/fee-evasion';
import { recordRiskSignal } from '../risk/service.js';

export type MessageStatus = 'SENT' | 'DELIVERED' | 'READ';

export interface ThreadListItem {
  id: string;
  subject: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  participantCount: number;
  unreadCount: number;
  participants: Array<{ userId: string; displayName: string | null; email: string }>;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    senderName: string;
    status: string;
    createdAt: string;
  } | null;
}

export interface ParticipantInfo {
  userId: string;
  displayName: string | null;
  email: string;
  roles: string[];
  joinedAt: string;
  lastReadAt: string | null;
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
  participants: ParticipantInfo[];
  messages: Array<{
    id: string;
    senderId: string;
    body: string;
    messageType: string;
    status: string;
    readAt: string | null;
    createdAt: string;
    isDeleted: boolean;
  }>;
}

function normalizePage(value: number | undefined, maxSize = 50): { page: number; pageSize: number } {
  const page = Math.max(1, value ?? 1);
  return { page, pageSize: Math.min(maxSize, 50) };
}

async function resolveParticipantDisplay(db: DB, userId: string): Promise<{ displayName: string | null; email: string; roles: string[] }> {
  const userRow = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const profileRow = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return {
    displayName: profileRow[0]?.displayName ?? null,
    email: userRow[0]?.email ?? 'unknown',
    roles: [],
  };
}

/** Fetches all participants of a thread including display names/emails. */
export async function getThreadParticipants(db: DB, threadId: string): Promise<ParticipantInfo[]> {
  const rows = await db
    .select({
      userId: threadParticipants.userId,
      joinedAt: threadParticipants.joinedAt,
      lastReadAt: threadParticipants.lastReadAt,
      displayName: profiles.displayName,
      email: users.email,
    })
    .from(threadParticipants)
    .leftJoin(profiles, eq(profiles.userId, threadParticipants.userId))
    .leftJoin(users, eq(users.id, threadParticipants.userId))
    .where(eq(threadParticipants.threadId, threadId));
  return rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName ?? null,
    email: r.email ?? 'unknown',
    roles: [],
    joinedAt: r.joinedAt.toISOString(),
    lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null,
  }));
}

async function ensureParticipant(db: DB, threadId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.forbidden('You are not a participant of this conversation');
  }
}

/** Lists threads the user participates in, with last message and unread count. */
export async function listMyThreads(
  db: DB,
  userId: string,
  query: { q?: string; page?: number } = {},
): Promise<{ items: ThreadListItem[]; page: number; pageSize: number; total: number }> {
  const conditions = [eq(threadParticipants.userId, userId)];
  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(sql`(
      ${threads.subject} ilike ${like}
      or ${threads.id} in (
        select m.thread_id from messages m where m.body ilike ${like}
      )
    )`);
  }

  const { page, pageSize } = normalizePage(query.page);

  const bounds = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .innerJoin(threads, eq(threads.id, threadParticipants.threadId))
    .where(and(...conditions))
    .orderBy(desc(threads.updatedAt))
    .limit(pageSize * 4 + 100);

  const threadIds = bounds.map((b) => b.threadId);
  if (threadIds.length === 0) return { items: [], page, pageSize, total: 0 };

  const [{ total }] = await db
    .select({ total: sql<number>`count(distinct ${threadParticipants.threadId})::int` })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.userId, userId), inArray(threadParticipants.threadId, threadIds)));

  const threadRows = await db
    .select()
    .from(threads)
    .where(inArray(threads.id, threadIds))
    .orderBy(desc(threads.updatedAt));

  // Last message per thread
  const lastMessages = await db
    .select()
    .from(messages)
    .where(inArray(messages.threadId, threadIds))
    .orderBy(desc(messages.createdAt))
    .limit(pageSize * 10);

  const lastById = new Map<string, (typeof lastMessages)[number]>();
  for (const m of lastMessages) {
    if (!lastById.has(m.threadId)) lastById.set(m.threadId, m);
  }

  // Unread counts: messages in these threads where sender != me and read_at is null or > my last read
  const myParticipants = await db
    .select({ threadId: threadParticipants.threadId, lastReadAt: threadParticipants.lastReadAt })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.userId, userId), inArray(threadParticipants.threadId, threadIds)));

  const lastReadByThread = new Map<string, Date | null>();
  for (const p of myParticipants) lastReadByThread.set(p.threadId, p.lastReadAt);

  // Participants with display names for all listed threads.
  const allParticipants = await db
    .select({
      threadId: threadParticipants.threadId,
      userId: threadParticipants.userId,
      displayName: profiles.displayName,
      email: users.email,
    })
    .from(threadParticipants)
    .leftJoin(profiles, eq(profiles.userId, threadParticipants.userId))
    .leftJoin(users, eq(users.id, threadParticipants.userId))
    .where(inArray(threadParticipants.threadId, threadIds));

  const participantsByThread = new Map<string, Array<{ userId: string; displayName: string | null; email: string }>>();
  for (const p of allParticipants) {
    const list = participantsByThread.get(p.threadId) ?? [];
    list.push({ userId: p.userId, displayName: p.displayName ?? null, email: p.email ?? 'unknown' });
    participantsByThread.set(p.threadId, list);
  }

  const items: ThreadListItem[] = threadRows.map((t) => {
    const lm = lastById.get(t.id);
    const myLastRead = lastReadByThread.get(t.id) ?? new Date(0);
    // Count messages that are not mine, not deleted, and created after my lastReadAt.
    let unreadCount = 0;
    for (const m of lastMessages) {
      if (m.threadId !== t.id) continue;
      if (m.senderId === userId) continue;
      if (m.isDeleted) continue;
      if (m.createdAt > myLastRead) unreadCount += 1;
    }
    const threadParticipantsList = participantsByThread.get(t.id) ?? [];
    return {
      id: t.id,
      subject: t.subject,
      relatedEntityType: t.relatedEntityType,
      relatedEntityId: t.relatedEntityId,
      isBlocked: t.isBlocked,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      participantCount: threadParticipantsList.length,
      unreadCount: Math.max(0, unreadCount),
      participants: threadParticipantsList,
      lastMessage: lm
        ? {
            id: lm.id,
            body: lm.isDeleted ? '[deleted]' : lm.body,
            senderId: lm.senderId,
            senderName: lm.senderId,
            status: lm.status,
            createdAt: lm.createdAt.toISOString(),
          }
        : null,
    };
  });

  // Resolve lastMessage sender names
  const senderIds = [...new Set(items.flatMap((i) => (i.lastMessage ? [i.lastMessage.senderId] : [])))];
  const senderNames: Record<string, string> = {};
  for (const sid of senderIds) {
    const info = await resolveParticipantDisplay(db, sid);
    senderNames[sid] = info.displayName ?? info.email;
  }
  for (const item of items) {
    if (item.lastMessage) item.lastMessage.senderName = senderNames[item.lastMessage.senderId] ?? item.lastMessage.senderId;
  }

  // Sort by updated desc (threadRows already sorted); slice for page.
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return { items: paged, page, pageSize, total: threadRows.length };
}

/** Finds an existing 1:1 thread between two users, or returns null. */
export async function findDirectThread(db: DB, userA: string, userB: string): Promise<string | null> {
  const rows = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(eq(threadParticipants.userId, userA));
  const ids = [...new Set(rows.map((r) => r.threadId))];
  if (ids.length === 0) return null;
  const withB = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(and(inArray(threadParticipants.threadId, ids), eq(threadParticipants.userId, userB), ne(threadParticipants.userId, userA)));
  if (withB.length === 0) return null;
  return withB[0].threadId;
}

/** Ensures the target user exists and is not ourselves. */
async function assertTargetUser(db: DB, userId: string, targetUserId: string): Promise<void> {
  if (userId === targetUserId) {
    throw ApiError.validation([{ field: 'participantUserId', message: 'Cannot message yourself', code: 'VALIDATION_FAILED' }]);
  }
  const row = await db.select({ id: users.id }).from(users).where(eq(users.id, targetUserId)).limit(1);
  if (row.length === 0) {
    throw ApiError.notFound('Target user');
  }
}

/** Creates a 1:1 thread and sends the first message. */
export async function openDirectThread(
  db: DB,
  userId: string,
  input: { participantUserId: string; subject?: string; body: string },
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ threadId: string; messageId: string }> {
  await assertTargetUser(db, userId, input.participantUserId);
  const existing = await findDirectThread(db, userId, input.participantUserId);
  let threadId = existing;
  if (!threadId) {
    threadId = newId();
    await db.insert(threads).values({
      id: threadId,
      participantIds: [userId, input.participantUserId],
      subject: input.subject ?? null,
      relatedEntityType: null,
      relatedEntityId: null,
      isBlocked: false,
    });
    await db.insert(threadParticipants).values([
      { id: newId(), threadId, userId, lastReadAt: null, isMuted: false },
      { id: newId(), threadId, userId: input.participantUserId, lastReadAt: null, isMuted: false },
    ]);
  }

  const messageId = newId();
  await db.insert(messages).values({
    id: messageId,
    threadId,
    senderId: userId,
    body: input.body,
    messageType: 'TEXT',
    status: 'SENT',
    readAt: null,
    attachments: null,
  });
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));

  await db.insert(notifications).values({
    id: newId(),
    userId: input.participantUserId,
    type: 'MESSAGE.NEW',
    title: 'New message',
    body: input.body.slice(0, 200),
    data: { threadId, senderId: userId },
  });

  await writeAudit(db, { actorId: userId, ipAddress: audit.ipAddress, userAgent: audit.userAgent }, {
    action: 'MESSAGING.THREAD_CREATE',
    entityType: 'THREAD',
    entityId: threadId,
    metadata: { participant: input.participantUserId },
  });

  await scanMessageForFeeEvasion(db, { userId, threadId, messageId, body: input.body, audit });

  return { threadId, messageId };
}

/** Gets a thread the user participates in, with messages. Marks the thread read. */
export async function getThread(
  db: DB,
  userId: string,
  threadId: string,
  opts: { markRead?: boolean } = {},
): Promise<ThreadDetail> {
  const thread = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  if (thread.length === 0) throw ApiError.notFound('Thread');
  await ensureParticipant(db, threadId, userId);

  const participants = await getThreadParticipants(db, threadId);
  const msgRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId)))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  if (opts.markRead) {
    await markThreadRead(db, userId, threadId);
  }

  return {
    id: thread[0].id,
    subject: thread[0].subject,
    relatedEntityType: thread[0].relatedEntityType,
    relatedEntityId: thread[0].relatedEntityId,
    isBlocked: thread[0].isBlocked,
    createdAt: thread[0].createdAt.toISOString(),
    updatedAt: thread[0].updatedAt.toISOString(),
    participants,
    messages: msgRows.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      body: m.isDeleted ? '[deleted]' : m.body,
      messageType: m.messageType,
      status: m.status,
      readAt: m.readAt ? m.readAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
      isDeleted: m.isDeleted,
    })),
  };
}

/** Sends a message to a thread. Creates notification for other participants. */
export async function sendMessage(
  db: DB,
  userId: string,
  threadId: string,
  input: { body: string; messageType?: string },
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string; createdAt: string; status: string }> {
  const thread = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  if (thread.length === 0) throw ApiError.notFound('Thread');
  if (thread[0].isBlocked) {
    throw ApiError.forbidden('This conversation is blocked');
  }
  await ensureParticipant(db, threadId, userId);

  const messageId = newId();
  await db.insert(messages).values({
    id: messageId,
    threadId,
    senderId: userId,
    body: input.body,
    messageType: input.messageType ?? 'TEXT',
    status: 'SENT',
    readAt: null,
    attachments: null,
  });
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));

  const otherParticipants = await db
    .select({ userId: threadParticipants.userId, lastReadAt: threadParticipants.lastReadAt })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.threadId, threadId), ne(threadParticipants.userId, userId)));

  for (const p of otherParticipants) {
    await db.insert(notifications).values({
      id: newId(),
      userId: p.userId,
      type: 'MESSAGE.NEW',
      title: 'New message',
      body: input.body.slice(0, 200),
      data: { threadId, senderId: userId },
    });
  }

  await writeAudit(db, { actorId: userId, ipAddress: audit.ipAddress, userAgent: audit.userAgent }, {
    action: 'MESSAGING.MESSAGE_SEND',
    entityType: 'THREAD',
    entityId: threadId,
    metadata: { messageId, senderId: userId },
  });

  await scanMessageForFeeEvasion(db, { userId, threadId, messageId, body: input.body, audit });

  return { id: messageId, createdAt: new Date().toISOString(), status: 'SENT' };
}

/**
 * Anti-fee-evasion scan shared by every message-writing path.
 *
 * Both {@link sendMessage} and {@link openDirectThread} are "the user sent a
 * message" events, so both must run the detector — scanning only replies would
 * let a thread's very first message (the natural place to propose taking the
 * deal off-platform) bypass the Risk engine entirely. Only signal codes are
 * persisted (see lib/fee-evasion.ts); the message text is never stored here.
 */
async function scanMessageForFeeEvasion(
  db: DB,
  input: {
    userId: string;
    threadId: string;
    messageId: string;
    body: string;
    audit: { ipAddress?: string | null; userAgent?: string | null };
  },
): Promise<void> {
  const signals = detectOffPlatformSignals(input.body);
  if (signals.length === 0) return;
  const reasonCode = signals.map((s) => s.code).join('|');
  const weight = Math.min(30, signals.reduce((sum, s) => sum + s.weight, 0));
  await recordRiskSignal(db, {
    userId: input.userId,
    eventType: 'FEE_EVASION_SIGNAL',
    reasonCode,
    weight,
    severity: weight >= 25 ? 'HIGH' : 'MEDIUM',
    recommendedAction: 'REVIEW',
    details: { threadId: input.threadId, messageId: input.messageId, signalCodes: signals.map((s) => s.code) },
  });
  await writeAudit(db, { actorId: input.userId, ipAddress: input.audit.ipAddress, userAgent: input.audit.userAgent }, {
    action: 'MESSAGING.FEE_EVASION_SIGNAL',
    entityType: 'USER',
    entityId: input.userId,
    metadata: {
      threadId: input.threadId,
      messageId: input.messageId,
      signalCodes: signals.map((s) => s.code),
      weight,
    },
  });
}

/** Marks a thread as read: updates participant lastReadAt and message readAt. */
export async function markThreadRead(db: DB, userId: string, threadId: string): Promise<void> {
  const thread = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  if (thread.length === 0) throw ApiError.notFound('Thread');
  await ensureParticipant(db, threadId, userId);

  const now = new Date();
  await db
    .update(threadParticipants)
    .set({ lastReadAt: now })
    .where(and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.userId, userId)));

  // Mark messages from others as READ.
  await db
    .update(messages)
    .set({ status: 'READ', readAt: now })
    .where(and(
      eq(messages.threadId, threadId),
      ne(messages.senderId, userId),
      isNotNull(messages.id),
    ));
}

/** Searches messages the user participates in. */
export async function searchThreads(
  db: DB,
  userId: string,
  q: string,
  page = 1,
): Promise<{ items: ThreadListItem[]; page: number; pageSize: number; total: number }> {
  return listMyThreads(db, userId, { q, page });
}

export async function searchMessages(
  db: DB,
  userId: string,
  q: string,
  page = 1,
): Promise<{
  page: number;
  pageSize: number;
  total: number;
  items: Array<{ id: string; threadId: string; senderId: string; body: string; createdAt: string; status: string }>;
}> {
  const { pageSize } = normalizePage(page);

  const myThreadIds = await db
    .select({ threadId: threadParticipants.threadId })
    .from(threadParticipants)
    .where(eq(threadParticipants.userId, userId));
  const ids = [...new Set(myThreadIds.map((r) => r.threadId))];
  if (ids.length === 0) return { items: [], page, pageSize, total: 0 };

  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      senderId: messages.senderId,
      body: messages.body,
      createdAt: messages.createdAt,
      status: messages.status,
    })
    .from(messages)
    .where(and(inArray(messages.threadId, ids), like(messages.body, `%${q}%`), eq(messages.isDeleted, false)))
    .orderBy(desc(messages.createdAt))
    .limit(pageSize * 5);

  return {
    items: rows.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      senderId: r.senderId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
    })),
    page,
    pageSize,
    total: rows.length,
  };
}

export type MessagingSearchResult =
  | { type: 'threads'; items: ThreadListItem[] }
  | { type: 'messages'; items: Array<Record<string, unknown>> };

export async function searchMessaging(
  db: DB,
  userId: string,
  q: string,
): Promise<{ threads: ThreadListItem[]; messages: Array<Record<string, unknown>> }> {
  const [threadsRes, messagesRes] = await Promise.all([
    listMyThreads(db, userId, { q }),
    searchMessages(db, userId, q),
  ]);
  return {
    threads: threadsRes.items.slice(0, 10),
    messages: messagesRes.items as unknown as Array<Record<string, unknown>>,
  };
}