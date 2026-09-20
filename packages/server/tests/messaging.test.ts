import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { messages, notifications, threadParticipants, threads } from '../src/db/schema/messaging.js';
import { and, eq } from 'drizzle-orm';

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function register(c: ReturnType<typeof makeClient>, email: string, role = 'CUSTOMER') {
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Msg', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return (login.data.data as { id: string }).id;
}

async function createUserPair(prefix: string) {
  const a = makeClient();
  const b = makeClient();
  const ts = Date.now().toString();
  const aId = await register(a, `${prefix}-${ts}-a@wasit.tn`, 'CUSTOMER');
  const bId = await register(b, `${prefix}-${ts}-b@wasit.tn`, 'CUSTOMER');
  return { a, b, aId, bId };
}

describe('Messaging Engine', () => {
  it('sends first message by opening a direct thread, persists in DB, and creates a notification', async () => {
    const { a, b, aId, bId } = await createUserPair('it-msg-open');

    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, subject: 'Hello', body: 'مرحبا، هل المنتج متوفر؟' },
    });
    expect(open.status).toBe(200);
    const threadId = open.data.data.threadId as string;

    const threadRows = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(threadRows.length).toBe(1);
    expect(threadRows[0].participantIds).toEqual([aId, bId]);

    const parts = await db.select().from(threadParticipants).where(eq(threadParticipants.threadId, threadId));
    expect(parts.length).toBe(2);

    const msgRows = await db.select().from(messages).where(eq(messages.threadId, threadId));
    expect(msgRows.length).toBe(1);
    expect(msgRows[0].senderId).toBe(aId);
    expect(msgRows[0].body).toContain('المنتج');

    const notifForB = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, bId), eq(notifications.type, 'MESSAGE.NEW')));
    expect(notifForB.length).toBeGreaterThanOrEqual(1);
  });

  it('lists threads with unread count; reading marks messages READ and updates readAt', async () => {
    const { a, b, aId, bId } = await createUserPair('it-msg-list');

    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, body: 'First message' },
    });
    const threadId = open.data.data.threadId as string;

    // b has 1 unread
    const listB = await b.req('/api/messages');
    expect(listB.status).toBe(200);
    const itemsB = listB.data.data.items as Array<Record<string, unknown>>;
    expect(itemsB.length).toBe(1);
    expect(itemsB[0].unreadCount).toBe(1);
    expect((itemsB[0].lastMessage as { senderId: string }).senderId).toBe(aId);

    // b reads the thread
    const read = await b.req(`/api/messages/${threadId}`);
    expect(read.status).toBe(200);
    const thread = read.data.data as { messages: Array<Record<string, unknown>> };
    expect(thread.messages.length).toBe(1);

    const listB2 = await b.req('/api/messages');
    expect(listB2.data.data.items[0].unreadCount).toBe(0);

    // a replied -> b unread rises again
    await a.req(`/api/messages/${threadId}/messages`, { method: 'POST', body: { body: 'Second message' } });
    const listB3 = await b.req('/api/messages');
    expect(listB3.data.data.items[0].unreadCount).toBe(1);
  });

  it('enforces ownership: a non-participant cannot read or send in another thread (403)', async () => {
    const { a, b } = await createUserPair('it-msg-owner1');
    const third = makeClient();
    const thirdId = await register(third, `it-msg-owner1-${Date.now()}-c@wasit.tn`, 'CUSTOMER');

    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: thirdId, body: 'Hi' },
    });
    const threadId = open.data.data.threadId as string;

    // b (not participant) must be blocked
    const deniedRead = await b.req(`/api/messages/${threadId}`);
    expect(deniedRead.status).toBe(403);

    const deniedSend = await b.req(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: { body: 'hack attempt' },
    });
    expect(deniedSend.status).toBe(403);

    // b cannot see it in listings either
    const listB = await b.req('/api/messages');
    expect(listB.data.data.items.length).toBe(0);
  });

  it('blocks messaging yourself (validation error)', async () => {
    const { a, aId } = await createUserPair('it-msg-self');
    const r = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: aId, body: 'to me' },
    });
    expect(r.status).toBe(422);
  });

  it('prevents messaging a nonexistent user (404)', async () => {
    const { a } = await createUserPair('it-msg-missing');
    const r = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: '00000000-0000-0000-0000-000000000000', body: 'hi' },
    });
    expect(r.status).toBe(404);
  });

  it('rejects empty or oversized messages (validation)', async () => {
    const { a, bId } = await createUserPair('it-msg-valid');
    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, body: 'ok' },
    });
    const threadId = open.data.data.threadId as string;

    const empty = await a.req(`/api/messages/${threadId}/messages`, { method: 'POST', body: { body: '' } });
    expect(empty.status).toBe(422);

    const huge = await a.req(`/api/messages/${threadId}/messages`, {
      method: 'POST',
      body: { body: 'x'.repeat(6000) },
    });
    expect(huge.status).toBe(422);
  });

  it('requires authentication (401 without session)', async () => {
    const anon = makeClient();
    const r = await anon.req('/api/messages');
    expect(r.status).toBe(401);
  });

  it('searches threads and messages by keyword for the participating user only', async () => {
    const { a, b, bId } = await createUserPair('it-msg-search');
    const other = makeClient();
    const otherId = await register(other, `it-msg-search2-${Date.now()}@wasit.tn`, 'CUSTOMER');

    const unique1 = `WidgetPro-${Date.now()}`;
    const open = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, body: `Hello about ${unique1}` },
    });
    const threadId = open.data.data.threadId as string;

    // a second thread with 'other' containing a different keyword
    const open2 = await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: otherId, body: `Sparkle-${Date.now()} irrelevant` },
    });

    const search = await a.req(`/api/messages/search?q=${unique1}`);
    expect(search.status).toBe(200);
    const data = search.data.data as { threads: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> };
    expect(data.messages.length).toBeGreaterThanOrEqual(1);
    const found = data.messages[0] as { threadId: string; body: string };
    expect(found.threadId).toBe(threadId);
    expect(found.body).toContain(unique1);

    // b cannot find a's message in the other thread (ownership)
    const bSearch = await b.req('/api/messages/search?q=Sparkle');
    expect(bSearch.status).toBe(200);
    expect(bSearch.data.data.messages.length).toBe(0);
  });
});

describe('Notifications', () => {
  it('lists notifications with unread counts and marks them read', async () => {
    const { a, b, bId } = await createUserPair('it-notif');
    await a.req('/api/messages', {
      method: 'POST',
      body: { participantUserId: bId, body: 'نحن بانتظارك' },
    });

    const list = await b.req('/api/notifications');
    expect(list.status).toBe(200);
    const data = list.data.data as { items: Array<Record<string, unknown>>; unreadCount: number };
    expect(data.unreadCount).toBeGreaterThanOrEqual(1);
    const messageNotif = data.items.find((n) => n.type === 'MESSAGE.NEW');
    expect(messageNotif).toBeDefined();

    const countRes = await b.req('/api/notifications/unread-count');
    expect(countRes.data.data.count).toBe(data.unreadCount);

    await b.req('/api/notifications/read-all', { method: 'POST' });
    const after = await b.req('/api/notifications/unread-count');
    expect(after.data.data.count).toBe(0);
  });

  it('denies listing another user notifications (ownership via auth+queries)', async () => {
    const { a, b, bId } = await createUserPair('it-notif-owner');
    const c = makeClient();
    const cId = await register(c, `it-notif-owner-${Date.now()}@wasit.tn`, 'CUSTOMER');
    await a.req('/api/messages', { method: 'POST', body: { participantUserId: bId, body: 'for b only' } });

    // c sees 0 notifications (no leak)
    const cList = await c.req('/api/notifications');
    expect(cList.status).toBe(200);
    expect(cList.data.data.items.length).toBe(0);
    expect(cId).toBeDefined();
  });
});