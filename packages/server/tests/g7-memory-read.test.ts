import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks, agentMemory, agentMetrics } from '../src/db/schema/agents.js';
import { createAgentTask, getTask, syncAgentRegistry } from '../src/modules/ai/runner.js';
import { deriveScope } from '../src/modules/ai/scope.js';
import { putMemory, listMemoryPage, MAX_MEMORY_LIMIT } from '../src/modules/ai/memory-repo.js';
import { toMemoryView } from '../src/modules/ai/memory-service.js';

/**
 * G7 — the read-only operational-memory surface (`GET /api/admin/agent-ops/memory`).
 *
 * These tests drive the REAL route against the REAL database and pin the
 * properties the surface exists to guarantee:
 *
 *   - RBAC: unauthenticated ⇒ 401, a non-staff role ⇒ 403, staff ⇒ 200.
 *   - Scope is the caller's own owner, resolved server-side — a filter can only
 *     NARROW the caller's own notes. Platform scope grants no cross-owner memory
 *     read, so an admin never sees another owner's note content.
 *   - A `taskId` filter naming a task outside the caller's scope ⇒ 404 (never a
 *     silent empty page, and never another owner's data).
 *   - The response is a bounded projection (no raw content, no `scope_owner`).
 *   - Reads are side-effect free: repeated calls insert nothing.
 *
 * No service is mocked: every assertion reads the effect back from the database.
 */

const AUDIT = { actorId: 'g7-test' };

const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(agentMetrics).where(inArray(agentMetrics.scopeOwner, createdUserIds));
    await db.delete(agentMemory).where(inArray(agentMemory.scopeOwner, createdUserIds));
  }
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

beforeAll(async () => {
  await syncAgentRegistry(db);
});

async function insertUser(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const id = randomUUID();
  const email = `g7-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: await argon2.hash('G7Pass123!'), firstName: roleName, isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return { id, email };
}

/** Runs a read-only support task for an existing user; it executes inline, so its
 * memory note is owned by `ownerId` by the time this resolves. */
async function ranSupportTaskFor(ownerId: string, roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const created = await createAgentTask(
    db, [roleName], ownerId,
    { agentKey: 'support-agent', taskType: 'support.triage_ticket', input: {} },
    AUDIT,
  );
  createdTaskIds.push(created.id);
  const after = await getTask(db, created.id);
  expect(after.status).toBe('succeeded');
  return created.id;
}

/** Seeds one memory note directly under `ownerId` (no task reference). */
async function seedNote(ownerId: string, agentKey: string, content: Record<string, unknown>) {
  return putMemory(db, deriveScope({ userId: ownerId }), { agentKey, kind: 'summary', content });
}

async function memoryCount(ownerId: string): Promise<number> {
  const rows = await db.select({ v: sql<number>`count(*)::int` }).from(agentMemory).where(eq(agentMemory.scopeOwner, ownerId));
  return Number(rows[0]?.v ?? 0);
}

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
      try { data = await res.json(); } catch { data = null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function loginAs(roleName: 'SUPER_ADMIN' | 'ADMIN' | 'MERCHANT' | 'CUSTOMER') {
  const { id, email } = await insertUser(roleName);
  const client = makeClient();
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password: 'G7Pass123!', allowUnverifiedEmail: true } });
  expect(login.status).toBe(200);
  return { client, userId: id };
}

// ---------------------------------------------------------------------------
// Pure projection — the read shape is bounded.
// ---------------------------------------------------------------------------

describe('G7 — memory projection (pure)', () => {
  it('surfaces only the allow-listed fields, never raw content or owner', () => {
    const row = {
      id: 'mem-1',
      agentKey: 'support-agent',
      scopeOwner: 'owner-secret',
      kind: 'summary',
      content: {
        taskId: '11111111-1111-1111-1111-111111111111',
        source: 'task',
        tags: ['support', 'operations'],
        metrics: { outcome: 'succeeded', latencyMs: 12, errorCode: 'NO_SCOPE' },
        // A field that is not part of the allow-list must never be projected.
        unexpected: 'should-not-appear',
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const view = toMemoryView(row as never);
    expect(view).toEqual({
      id: 'mem-1',
      agentKey: 'support-agent',
      kind: 'summary',
      taskId: '11111111-1111-1111-1111-111111111111',
      source: 'task',
      tags: ['support', 'operations'],
      outcome: 'succeeded',
      latencyMs: 12,
      errorCode: 'NO_SCOPE',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(Object.keys(view).sort()).toEqual(
      ['agentKey', 'createdAt', 'errorCode', 'id', 'kind', 'latencyMs', 'outcome', 'source', 'tags', 'taskId'],
    );
    expect(view).not.toHaveProperty('scopeOwner');
    expect(view).not.toHaveProperty('unexpected');
  });

  it('tolerates a malformed content object without inventing values', () => {
    const view = toMemoryView({ id: 'm', agentKey: 'a', scopeOwner: 'o', kind: 'note', content: null, createdAt: new Date('2026-01-01T00:00:00.000Z') } as never);
    expect(view.taskId).toBeNull();
    expect(view.source).toBeNull();
    expect(view.tags).toEqual([]);
    expect(view.outcome).toBeNull();
    expect(view.latencyMs).toBeNull();
    expect(view.errorCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RBAC.
// ---------------------------------------------------------------------------

describe('G7 — memory route RBAC', () => {
  it('refuses an unauthenticated caller (401)', async () => {
    const res = await app.request('/api/admin/agent-ops/memory');
    expect(res.status).toBe(401);
  });

  it('refuses a non-staff role (403)', async () => {
    const { client } = await loginAs('MERCHANT');
    const { status } = await client.req('/api/admin/agent-ops/memory');
    expect(status).toBe(403);
  });

  it('serves the caller to an admin (200)', async () => {
    const { client } = await loginAs('ADMIN');
    const { status, data } = await client.req('/api/admin/agent-ops/memory');
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data.items)).toBe(true);
    expect(typeof data.data.total).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Scope isolation — the core property.
// ---------------------------------------------------------------------------

describe('G7 — memory scope isolation', () => {
  it('an admin sees only their OWN notes, never another owner\'s (platform grants no cross-owner memory)', async () => {
    const customer = await insertUser('CUSTOMER');
    const admin = await insertUser('ADMIN');
    // A note owned by the customer and one owned by the admin.
    await ranSupportTaskFor(customer.id, 'CUSTOMER');
    const adminTaskId = await ranSupportTaskFor(admin.id, 'ADMIN');

    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: admin.email, password: 'G7Pass123!', allowUnverifiedEmail: true } });
    expect(login.status).toBe(200);

    const { status, data } = await client.req('/api/admin/agent-ops/memory');
    expect(status).toBe(200);
    const taskIds = (data.data.items as Array<{ taskId: string | null }>).map((r) => r.taskId);
    expect(taskIds).toContain(adminTaskId);

    // No returned row may be a note the customer owns — nothing crossed owners.
    const customerNoteIds = (
      await db.select({ id: agentMemory.id }).from(agentMemory).where(eq(agentMemory.scopeOwner, customer.id))
    ).map((r) => r.id);
    expect(customerNoteIds.length).toBeGreaterThan(0);
    for (const item of data.data.items as Array<{ id: string }>) {
      expect(customerNoteIds).not.toContain(item.id);
    }
  });

  it('two distinct owners never share a note', async () => {
    const a = await insertUser('ADMIN');
    const b = await insertUser('ADMIN');
    const noteA = await seedNote(a.id, 'support-agent', { tags: ['support'] });
    const noteB = await seedNote(b.id, 'support-agent', { tags: ['support'] });

    const pageA = await listMemoryPage(db, deriveScope({ userId: a.id }), {});
    const pageB = await listMemoryPage(db, deriveScope({ userId: b.id }), {});
    expect(pageA.items.map((r) => r.id)).toContain(noteA);
    expect(pageA.items.map((r) => r.id)).not.toContain(noteB);
    expect(pageB.items.map((r) => r.id)).toContain(noteB);
    expect(pageB.items.map((r) => r.id)).not.toContain(noteA);
  });

  it('a taskId outside the caller\'s scope is refused with 404 (never a silent empty page)', async () => {
    const customer = await insertUser('CUSTOMER');
    const foreignTaskId = await ranSupportTaskFor(customer.id, 'CUSTOMER');
    const { client } = await loginAs('ADMIN');
    const { status } = await client.req(`/api/admin/agent-ops/memory?taskId=${foreignTaskId}`);
    expect(status).toBe(404);
  });

  it('scope cannot be widened through query parameters', async () => {
    const customer = await insertUser('CUSTOMER');
    await ranSupportTaskFor(customer.id, 'CUSTOMER');
    const admin = await loginAs('ADMIN');
    // Attempts to name another owner or claim platform scope are simply ignored:
    // the scope is the session's owner, and these are not part of the query.
    const { status, data } = await admin.client.req(
      `/api/admin/agent-ops/memory?owner=${customer.id}&scope=platform&isPlatform=true&userId=${customer.id}`,
    );
    expect(status).toBe(200);
    const items = data.data.items as Array<{ id: string }>;
    const customerNotes = await db.select({ id: agentMemory.id }).from(agentMemory).where(eq(agentMemory.scopeOwner, customer.id));
    const customerNoteIds = customerNotes.map((r) => r.id);
    for (const item of items) expect(customerNoteIds).not.toContain(item.id);
  });
});

// ---------------------------------------------------------------------------
// Read integrity — validation + no writes.
// ---------------------------------------------------------------------------

describe('G7 — memory read integrity', () => {
  it('rejects an invalid limit and an over-maximum limit (422)', async () => {
    const { client } = await loginAs('ADMIN');
    for (const bad of ['0', '-1', String(MAX_MEMORY_LIMIT + 1), 'abc']) {
      const { status } = await client.req(`/api/admin/agent-ops/memory?limit=${bad}`);
      expect(status, `limit=${bad}`).toBe(422);
    }
  });

  it('rejects a non-UUID taskId (422)', async () => {
    const { client } = await loginAs('ADMIN');
    const { status } = await client.req('/api/admin/agent-ops/memory?taskId=not-a-uuid');
    expect(status).toBe(422);
  });

  it('repeated reads create no rows and mutate nothing', async () => {
    const admin = await insertUser('ADMIN');
    await ranSupportTaskFor(admin.id, 'ADMIN');
    const before = await memoryCount(admin.id);

    const c = makeClient();
    await c.req('/api/auth/login', { method: 'POST', body: { email: admin.email, password: 'G7Pass123!', allowUnverifiedEmail: true } });
    for (let i = 0; i < 3; i++) {
      const { status } = await c.req('/api/admin/agent-ops/memory?limit=10');
      expect(status).toBe(200);
    }
    expect(await memoryCount(admin.id)).toBe(before);
  });

  it('returns a bounded projection with no raw content or owner columns', async () => {
    const admin = await insertUser('ADMIN');
    await ranSupportTaskFor(admin.id, 'ADMIN');
    const c = makeClient();
    await c.req('/api/auth/login', { method: 'POST', body: { email: admin.email, password: 'G7Pass123!', allowUnverifiedEmail: true } });
    const { data } = await c.req('/api/admin/agent-ops/memory');
    expect((data.data.items as unknown[]).length).toBeGreaterThan(0);
    for (const item of data.data.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('scopeOwner');
      expect(item).not.toHaveProperty('content');
      expect(Object.keys(item).sort()).toEqual(
        ['agentKey', 'createdAt', 'errorCode', 'id', 'kind', 'latencyMs', 'outcome', 'source', 'tags', 'taskId'],
      );
    }
  });

  it('paginates stably with a deterministic order', async () => {
    const owner = await insertUser('ADMIN');
    const scope = deriveScope({ userId: owner.id });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedNote(owner.id, 'support-agent', { tags: ['support'] }));

    const first = await listMemoryPage(db, scope, { limit: 2, offset: 0 });
    const second = await listMemoryPage(db, scope, { limit: 2, offset: 2 });
    const third = await listMemoryPage(db, scope, { limit: 2, offset: 4 });
    const again = await listMemoryPage(db, scope, { limit: 2, offset: 0 });
    expect(first.total).toBeGreaterThanOrEqual(5);

    // The same page is returned for the same offset: the order is deterministic.
    expect(first.items.map((r) => r.id)).toEqual(again.items.map((r) => r.id));

    // No id appears on two pages.
    const seen = [...first.items, ...second.items, ...third.items].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);

    // Every note seeded is reachable across the pages.
    for (const id of ids) expect(seen).toContain(id);
  });
});
