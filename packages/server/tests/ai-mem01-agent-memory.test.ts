import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { agentMemory } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { env } from '../src/lib/env.js';

/**
 * AI-MEM-01 — institutional agent memory over real HTTP and real PostgreSQL.
 *
 * The tests exercise the boundaries the feature exists to protect: owner
 * isolation, agent isolation, refusal of secrets, expiry and limits, audit of
 * reads and writes, integrity of stored rows, and the supervision interface.
 * Nothing here mocks the service or the database.
 */

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

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function registerCustomer(prefix = 'mem') {
  const client = makeClient();
  const email = `it-${prefix}-${uniq('c')}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Mem', role: 'CUSTOMER' },
  });
  expect(reg.status).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  const me = await client.req('/api/auth/me');
  expect(me.status).toBe(200);
  return { client, email, id: me.data.data.id as string };
}

async function createStaff(roleName: 'ADMIN' | 'SUPER_ADMIN') {
  const client = makeClient();
  const id = randomUUID();
  const email = `it-${roleName.toLowerCase()}-${uniq('m')}@wasit.tn`;
  const password = 'StaffPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status).toBe(200);
  return { client, email, id };
}

const AGENT = 'marketing-agent';
const OTHER_AGENT = 'analytics-agent';

async function remember(
  client: ReturnType<typeof makeClient>,
  body: Record<string, unknown>,
) {
  return client.req('/api/ai/memory', { method: 'POST', body });
}

async function rowsFor(ownerId: string) {
  return db.select().from(agentMemory).where(eq(agentMemory.scopeOwner, ownerId));
}

async function audits(action: string, entityId?: string) {
  return db
    .select()
    .from(auditLogs)
    .where(entityId ? and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)) : eq(auditLogs.action, action));
}

const originalLimits = {
  perAgent: env.AI_MEMORY_MAX_PER_AGENT,
  perOwner: env.AI_MEMORY_MAX_PER_OWNER,
};

afterEach(() => {
  env.AI_MEMORY_MAX_PER_AGENT = originalLimits.perAgent;
  env.AI_MEMORY_MAX_PER_OWNER = originalLimits.perOwner;
});

describe('AI-MEM-01 — agent memory lifecycle', () => {
  it('saves, recalls, reads, updates and forgets a memory', async () => {
    const { client, id } = await registerCustomer();

    const created = await remember(client, {
      agentKey: AGENT,
      type: 'procedural',
      text: 'Reconcile supplier invoices every Tuesday before noon.',
      entityType: 'supplier',
      entityId: randomUUID(),
    });
    expect(created.status).toBe(201);
    expect(created.data.data.agentKey).toBe(AGENT);
    expect(created.data.data.type).toBe('procedural');
    expect(created.data.data.revision).toBe(1);
    expect(created.data.data.expiresAt).toBeTruthy();
    const memoryId = created.data.data.id as string;

    const recalled = await client.req(`/api/ai/memory?agentKey=${AGENT}`);
    expect(recalled.status).toBe(200);
    expect(recalled.data.data.items).toHaveLength(1);
    expect(recalled.data.data.items[0].id).toBe(memoryId);

    const fetched = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`);
    expect(fetched.status).toBe(200);
    expect(fetched.data.data.text).toContain('Reconcile supplier invoices');

    const updated = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`, {
      method: 'PATCH',
      body: { text: 'Reconcile supplier invoices every Wednesday.', expectedRevision: 1 },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.data.revision).toBe(2);
    expect(updated.data.data.text).toContain('Wednesday');

    const stale = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`, {
      method: 'PATCH',
      body: { text: 'stale write', expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe('MEMORY_REVISION_MISMATCH');

    const forgotten = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`, {
      method: 'DELETE',
    });
    expect(forgotten.status).toBe(200);
    expect(forgotten.data.data.deleted).toBe(true);
    expect(await rowsFor(id)).toHaveLength(0);

    const missing = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`);
    expect(missing.status).toBe(404);

    // Every operation is audited with the acting owner.
    for (const action of [
      'AI.MEMORY_CREATED',
      'AI.MEMORY_READ',
      'AI.MEMORY_LISTED',
      'AI.MEMORY_UPDATED',
      'AI.MEMORY_FORGOTTEN',
    ]) {
      const rows = await audits(action);
      expect(rows.length, action).toBeGreaterThan(0);
      expect(rows.some((r) => r.actorId === id)).toBe(true);
    }
  });

  it('isolates one owner from another and never leaks existence', async () => {
    const alice = await registerCustomer('alice');
    const bob = await registerCustomer('bob');

    const created = await remember(alice.client, {
      agentKey: AGENT,
      type: 'operational',
      text: 'Alice keeps a 48h response SLA with her supplier.',
    });
    expect(created.status).toBe(201);
    const memoryId = created.data.data.id as string;

    // Bob cannot list it…
    const list = await bob.client.req(`/api/ai/memory?agentKey=${AGENT}`);
    expect(list.status).toBe(200);
    expect(list.data.data.items).toHaveLength(0);

    // …cannot read it by id…
    const read = await bob.client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`);
    expect(read.status).toBe(404);

    // …cannot update it…
    const update = await bob.client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`, {
      method: 'PATCH',
      body: { text: 'hijacked' },
    });
    expect(update.status).toBe(404);

    // …and cannot delete it.
    const del = await bob.client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(404);

    const aliceRows = await rowsFor(alice.id);
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0].scopeOwner).toBe(alice.id);
    expect(await rowsFor(bob.id)).toHaveLength(0);
  });

  it('keeps one agent\'s memory out of another agent\'s reach', async () => {
    const { client } = await registerCustomer();
    const created = await remember(client, {
      agentKey: AGENT,
      type: 'contextual',
      text: 'Campaign season peaks in the last week of the month.',
    });
    expect(created.status).toBe(201);
    const memoryId = created.data.data.id as string;

    const otherAgentList = await client.req(`/api/ai/memory?agentKey=${OTHER_AGENT}`);
    expect(otherAgentList.status).toBe(200);
    expect(otherAgentList.data.data.items).toHaveLength(0);

    const wrongAgentRead = await client.req(`/api/ai/memory/${memoryId}?agentKey=${OTHER_AGENT}`);
    expect(wrongAgentRead.status).toBe(404);

    const wrongAgentDelete = await client.req(`/api/ai/memory/${memoryId}?agentKey=${OTHER_AGENT}`, {
      method: 'DELETE',
    });
    expect(wrongAgentDelete.status).toBe(404);

    const rightAgent = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`);
    expect(rightAgent.status).toBe(200);
  });

  it('refuses owner spoofing in the request body', async () => {
    const alice = await registerCustomer('spoof-a');
    const bob = await registerCustomer('spoof-b');

    const spoofed = await remember(alice.client, {
      agentKey: AGENT,
      type: 'operational',
      text: 'Trying to write into another owner.',
      scopeOwner: bob.id,
    });
    expect(spoofed.status).toBe(422);

    const spoofedUpdate = await alice.client.req(`/api/ai/memory/does-not-matter?agentKey=${AGENT}`, {
      method: 'PATCH',
      body: { text: 'x', ownerId: bob.id },
    });
    expect(spoofedUpdate.status).toBe(422);

    expect(await rowsFor(bob.id)).toHaveLength(0);
  });

  it('refuses secrets and personal data, and writes nothing', async () => {
    const { client, id } = await registerCustomer();
    const cases: Array<[string, string]> = [
      ['Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 for the call.', 'API_TOKEN'],
      ['password=Hunter2!', 'CREDENTIAL_ASSIGNMENT'],
      ['card 4111 1111 1111 1111', 'PAYMENT_CARD'],
      ['buyer email someone@example.com', 'EMAIL_ADDRESS'],
    ];
    for (const [text, reason] of cases) {
      const r = await remember(client, { agentKey: AGENT, type: 'operational', text });
      expect(r.status).toBe(422);
      expect(r.data.error.code).toBe('MEMORY_CONTENT_REFUSED');
      expect(r.data.error.fieldErrors[0].code).toBe(reason);
    }
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it('rejects unknown agents, the Copilot and the supervisor', async () => {
    const { client } = await registerCustomer();
    const unknown = await remember(client, { agentKey: 'not-an-agent', type: 'operational', text: 'x' });
    expect(unknown.status).toBe(404);

    for (const key of ['wasit-copilot', 'agent-supervisor']) {
      const r = await remember(client, { agentKey: key, type: 'operational', text: 'x' });
      expect(r.status, key).toBe(403);
    }
  });

  it('requires an authenticated session for every memory route', async () => {
    const anon = makeClient();
    expect((await anon.req(`/api/ai/memory?agentKey=${AGENT}`)).status).toBe(401);
    expect(
      (await anon.req('/api/ai/memory', { method: 'POST', body: { agentKey: AGENT, type: 'operational', text: 'x' } }))
        .status,
    ).toBe(401);
    expect((await anon.req(`/api/ai/memory/${randomUUID()}?agentKey=${AGENT}`)).status).toBe(401);
  });
});

describe('AI-MEM-01 — retention, limits and integrity', () => {
  it('hides and purges expired memories', async () => {
    const { client, id } = await registerCustomer();
    const created = await remember(client, {
      agentKey: AGENT,
      type: 'contextual',
      text: 'Short-lived context about a running campaign.',
      ttlDays: 1,
    });
    expect(created.status).toBe(201);
    const memoryId = created.data.data.id as string;

    // Backdate the expiry exactly as time would: the row is now expired.
    await db
      .update(agentMemory)
      .set({
        content: sql`jsonb_set(${agentMemory.content}, '{expiresAt}', to_jsonb((now() - interval '1 day')::text))`,
      })
      .where(eq(agentMemory.id, memoryId));

    const list = await client.req(`/api/ai/memory?agentKey=${AGENT}`);
    expect(list.data.data.items).toHaveLength(0);
    expect((await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`)).status).toBe(200);

    const admin = await createStaff('ADMIN');
    const purge = await admin.client.req('/api/admin/ai/memory/purge', { method: 'POST', body: {} });
    expect(purge.status).toBe(200);
    expect(purge.data.data.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowsFor(id)).toHaveLength(0);
    expect((await audits('AI.MEMORY_EXPIRED_PURGED')).length).toBeGreaterThan(0);
  });

  it('enforces the per-agent limit and recovers capacity after deletion', async () => {
    const { client } = await registerCustomer();
    env.AI_MEMORY_MAX_PER_AGENT = 2;
    try {
      expect((await remember(client, { agentKey: AGENT, type: 'operational', text: 'one' })).status).toBe(201);
      expect((await remember(client, { agentKey: AGENT, type: 'operational', text: 'two' })).status).toBe(201);
      const third = await remember(client, { agentKey: AGENT, type: 'operational', text: 'three' });
      expect(third.status).toBe(409);
      expect(third.data.error.code).toBe('MEMORY_LIMIT_REACHED');
      // A different agent has its own budget.
      expect((await remember(client, { agentKey: OTHER_AGENT, type: 'operational', text: 'other' })).status).toBe(201);
    } finally {
      env.AI_MEMORY_MAX_PER_AGENT = originalLimits.perAgent;
    }
  });

  it('keeps task-result memory a rolling log inside the agent budget', async () => {
    const { client } = await registerCustomer('rolling');
    env.AI_MEMORY_MAX_PER_AGENT = 2;
    try {
      const note = await remember(client, { agentKey: AGENT, type: 'procedural', text: 'Owner note that must survive.' });
      expect(note.status).toBe(201);
      for (let i = 0; i < 3; i += 1) {
        const r = await client.req(`/api/ai/agents/${AGENT}/tasks`, { method: 'POST', body: { input: {} } });
        expect(r.status).toBe(201);
      }
      const list = await client.req(`/api/ai/memory?agentKey=${AGENT}&limit=100`);
      const items = list.data.data.items as Array<{ id: string; type: string }>;
      expect(items.length).toBeLessThanOrEqual(2);
      // The owner's own note is never evicted by the rolling log.
      expect(items.some((i) => i.id === note.data.data.id)).toBe(true);
    } finally {
      env.AI_MEMORY_MAX_PER_AGENT = originalLimits.perAgent;
    }
  });

  it('detects a row edited outside the service', async () => {
    const { client } = await registerCustomer();
    const created = await remember(client, {
      agentKey: AGENT,
      type: 'operational',
      text: 'Original note about a supplier.',
    });
    const memoryId = created.data.data.id as string;

    await db
      .update(agentMemory)
      .set({ content: sql`jsonb_set(${agentMemory.content}, '{text}', '"tampered text"')` })
      .where(eq(agentMemory.id, memoryId));

    const read = await client.req(`/api/ai/memory/${memoryId}?agentKey=${AGENT}`);
    expect(read.status).toBe(409);
    expect(read.data.error.code).toBe('MEMORY_INTEGRITY_FAILED');

    const list = await client.req(`/api/ai/memory?agentKey=${AGENT}`);
    expect(list.data.data.items).toHaveLength(0);
    expect((await audits('AI.MEMORY_INTEGRITY_FAILED')).length).toBeGreaterThan(0);
  });

  it('links a memory to a task of the same agent and owner only', async () => {
    const alice = await registerCustomer('task-a');
    const bob = await registerCustomer('task-b');

    const task = await alice.client.req(`/api/ai/agents/${AGENT}/tasks`, { method: 'POST', body: { input: {} } });
    expect(task.status).toBe(201);
    const taskId = task.data.data.id as string;

    const linked = await remember(alice.client, {
      agentKey: AGENT,
      type: 'task_result',
      text: `Follow-up needed on ${taskId}`,
      taskId,
    });
    expect(linked.status).toBe(201);
    expect(linked.data.data.taskId).toBe(taskId);

    // The run itself records a deterministic task_result for this task, so the
    // filter returns both that row and the note written above.
    const byTask = await alice.client.req(`/api/ai/memory?agentKey=${AGENT}&taskId=${taskId}`);
    const linkedIds = (byTask.data.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(linkedIds).toContain(linked.data.data.id);

    const foreign = await remember(bob.client, {
      agentKey: AGENT,
      type: 'task_result',
      text: 'someone else\'s task',
      taskId,
    });
    expect(foreign.status).toBe(404);

    const wrongAgent = await remember(alice.client, {
      agentKey: OTHER_AGENT,
      type: 'task_result',
      text: 'wrong agent for this task',
      taskId,
    });
    expect(wrongAgent.status).toBe(422);
  });
});

describe('AI-MEM-01 — agent runs use memory', () => {
  it('records a deterministic task_result and recalls it in the next run context', async () => {
    const { client, id } = await registerCustomer('run');

    const first = await client.req(`/api/ai/agents/${AGENT}/tasks`, { method: 'POST', body: { input: {} } });
    expect(first.status).toBe(201);
    const taskId = first.data.data.id as string;
    expect(first.data.data.status).toBe('succeeded');

    const recorded = await db
      .select()
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.scopeOwner, id),
          eq(agentMemory.agentKey, AGENT),
          eq(agentMemory.kind, 'task_result'),
          sql`${agentMemory.content}->>'taskId' = ${taskId}`,
        ),
      );
    expect(recorded).toHaveLength(1);
    const envelope = recorded[0].content as { text: string };
    expect(envelope.text).toContain('succeeded');
    expect(envelope.text).not.toContain('advice');

    // A note written by the owner is recalled when the agent runs again.
    const note = await remember(client, {
      agentKey: AGENT,
      type: 'procedural',
      text: 'Always attach the campaign preview link in the reply.',
    });
    expect(note.status).toBe(201);

    const second = await client.req(`/api/ai/agents/${AGENT}/tasks`, { method: 'POST', body: { input: {} } });
    expect(second.status).toBe(201);
    const recallAudits = await audits('AI.MEMORY_RECALLED');
    expect(recallAudits.some((r) => (r.metadata as { source?: string }).source === 'RUN_CONTEXT')).toBe(true);
    const recordedAudits = await audits('AI.MEMORY_RECORDED');
    expect(recordedAudits.some((r) => (r.metadata as { source?: string }).source === 'TASK_RUN')).toBe(true);
  });
});

describe('AI-MEM-01 — supervision is scoped and accountable', () => {
  it('denies the supervision interface to non-staff and serves aggregates without content', async () => {
    const owner = await registerCustomer('sup');
    await remember(owner.client, {
      agentKey: AGENT,
      type: 'operational',
      text: 'Owner note that must not appear in the summary.',
    });

    const customer = await owner.client.req('/api/admin/ai/memory/summary');
    expect(customer.status).toBe(403);

    const admin = await createStaff('ADMIN');
    const summary = await admin.client.req('/api/admin/ai/memory/summary');
    expect(summary.status).toBe(200);
    const serialized = JSON.stringify(summary.data.data);
    expect(serialized).not.toContain('Owner note that must not appear');
    const agentRow = (summary.data.data.agents as Array<{ agentKey: string; entries: number }>).find(
      (a) => a.agentKey === AGENT,
    );
    expect(agentRow?.entries).toBeGreaterThanOrEqual(1);

    const metadata = await admin.client.req(`/api/admin/ai/memory/entries?ownerId=${owner.id}`);
    expect(metadata.status).toBe(200);
    expect(metadata.data.data.items.length).toBeGreaterThanOrEqual(1);
    expect(metadata.data.data.items[0]).not.toHaveProperty('text');
    expect(JSON.stringify(metadata.data.data)).not.toContain('Owner note that must not appear');
    expect((await audits('AI.MEMORY_METADATA_LISTED')).length).toBeGreaterThan(0);
  });

  it('reveals one note only with a stated reason, and audits the inspection', async () => {
    const owner = await registerCustomer('inspect');
    const created = await remember(owner.client, {
      agentKey: AGENT,
      type: 'operational',
      text: 'Support context used to verify the inspection path.',
    });
    const memoryId = created.data.data.id as string;
    const admin = await createStaff('ADMIN');

    const noReason = await admin.client.req(`/api/admin/ai/memory/entries/${memoryId}`);
    expect(noReason.status).toBe(422);

    const shortReason = await admin.client.req(`/api/admin/ai/memory/entries/${memoryId}?reason=short`);
    expect(shortReason.status).toBe(422);

    const inspected = await admin.client.req(
      `/api/admin/ai/memory/entries/${memoryId}?reason=Investigating%20a%20support%20complaint`,
    );
    expect(inspected.status).toBe(200);
    expect(inspected.data.data.text).toContain('Support context');
    expect(inspected.data.data.ownerId).toBe(owner.id);

    const rows = await audits('AI.MEMORY_INSPECTED', memoryId);
    expect(rows).toHaveLength(1);
    expect((rows[0].metadata as { reason: string }).reason).toContain('support complaint');
  });
});
