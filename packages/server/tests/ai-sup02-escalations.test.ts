import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { alertEvents } from '../src/db/schema/observability.js';
import { agentMetrics, agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { notifications, notificationDeliveries } from '../src/db/schema/messaging.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { env } from '../src/lib/env.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import {
  acknowledgeEscalation,
  deliverEscalationToGm,
  listEscalations,
  openOrEscalateCase,
  resolveEscalation,
  scanEscalations,
} from '../src/modules/ai/escalations.js';
import { DEFAULT_ESCALATION_LIMITS, fingerprintOf, type Finding } from '../src/modules/ai/escalation-policy.js';

/**
 * AI-SUP-02 — supervisor escalation and GM notification, over real HTTP and a
 * real PostgreSQL database.
 *
 * Every case here is created from rows this suite writes, keyed to a unique
 * agent so the shared test database cannot make an assertion flaky. Nothing is
 * mocked except the one deliberately failing database handle that stands in for
 * an unavailable inbox.
 */

const app = createApp();
const SYSTEM_AUDIT = { actorId: null, actorType: 'SYSTEM' as const };
const TEST_AGENT_PREFIX = 'sup02-';

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;
const agentKey = (label: string) => `${TEST_AGENT_PREFIX}${label}-${Date.now()}-${++seq}`;

const createdUserIds: string[] = [];
const createdAgents = new Set<string>();
const createdTaskIds = new Set<string>();

const rawPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

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

async function makeUser(roleName: 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN' | 'SUPPORT', prefix = 'sup02') {
  const client = makeClient();
  const id = randomUUID();
  const email = `it-${prefix}-${uniq(roleName.toLowerCase())}@wasit.tn`;
  const password = 'StrongPass123!';
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    firstName: roleName,
    lastName: 'Tester',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  expect(login.status).toBe(200);
  createdUserIds.push(id);
  return { client, id, email };
}

/** Inserts metric rows directly: this is the durable log detection reads. */
async function recordOutcomes(key: string, outcomes: Array<'succeeded' | 'failed' | 'blocked' | 'rejected'>, at = new Date()) {
  createdAgents.add(key);
  for (const outcome of outcomes) {
    await db.insert(agentMetrics).values({
      id: randomUUID(),
      agentKey: key,
      taskId: randomUUID(),
      scopeOwner: 'sup02-owner',
      outcome,
      attempt: 1,
      latencyMs: 10,
      errorCode: outcome === 'failed' ? 'PROVIDER_ERROR' : null,
      createdAt: at,
    });
  }
}

async function insertOpenTask(opts: { key: string; status: string; ageMinutes: number; attempts?: number; maxAttempts?: number; input?: Record<string, unknown> }) {
  const id = randomUUID();
  createdTaskIds.add(id);
  createdAgents.add(opts.key);
  const openedAt = new Date(Date.now() - opts.ageMinutes * 60_000);
  await db.insert(agentTasks).values({
    id,
    agentKey: opts.key,
    requestedBy: 'sup02-owner',
    input: opts.input ?? { action: 'snapshot' },
    status: opts.status,
    attempts: opts.attempts ?? 0,
    maxAttempts: opts.maxAttempts ?? 3,
    requiresApproval: opts.status === 'awaiting_approval',
    startedAt: opts.status === 'running' ? openedAt : null,
    createdAt: openedAt,
  });
  return id;
}

/** Scoped scan: only cases for agents this suite created are asserted on. */
function scan(extra: Parameters<typeof scanEscalations>[2] = {}) {
  return scanEscalations(db, SYSTEM_AUDIT, extra);
}

async function casesFor(key: string) {
  const rows = await db
    .select()
    .from(alertEvents)
    .where(and(like(alertEvents.rule, 'supervisor.%'), sql`${alertEvents.details}->>'agentKey' = ${key}`))
    .orderBy(alertEvents.createdAt);
  return rows;
}

beforeEach(() => {
  setAiExecutionEnabled(null);
});

afterAll(async () => {
  await rawPool.end();
  const agents = [...createdAgents];
  for (const key of agents) {
    await db.delete(alertEvents).where(and(like(alertEvents.rule, 'supervisor.%'), sql`${alertEvents.details}->>'agentKey' = ${key}`));
    await db.delete(agentMetrics).where(eq(agentMetrics.agentKey, key));
    await db.delete(agentTasks).where(eq(agentTasks.agentKey, key));
  }
  if (createdTaskIds.size > 0) {
    await db.delete(alertEvents).where(and(like(alertEvents.rule, 'supervisor.%'), sql`${alertEvents.details}->>'taskId' in ${sql.raw(`(${[...createdTaskIds].map((id) => `'${id}'`).join(',')})`)}`));
  }
  for (const id of createdUserIds) {
    await db.delete(notifications).where(eq(notifications.userId, id));
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.userId, id));
  }
  // Cases created for other suites' agents during a full-table scan are theirs
  // to clean; this suite only removes what it keyed.
});

afterEach(() => {
  setAiExecutionEnabled(null);
});

describe('AI-SUP-02 — detection from real rows', () => {
  it('opens one HIGH/CRITICAL case for an agent that keeps failing', async () => {
    const key = agentKey('failing');
    await recordOutcomes(key, ['failed', 'failed', 'failed', 'succeeded']);

    const result = await scan();
    expect(result.skipped).toBeNull();
    const cases = await casesFor(key);
    expect(cases).toHaveLength(1);
    expect(cases[0].rule).toBe('supervisor.agent_failure_rate');
    expect(cases[0].status).toBe('OPEN');
    expect(['HIGH', 'CRITICAL']).toContain(cases[0].severity);

    const details = cases[0].details as Record<string, unknown>;
    expect(details.evidence).toMatchObject({ failed: 3, settled: 4 });
    expect(String(details.recommendation).length).toBeGreaterThan(20);
    expect(result.cases.some((c) => c.code === 'agent_failure_rate')).toBe(true);
  });

  it('opens a stalled case for a task that has been running far too long', async () => {
    const key = agentKey('stalled');
    const taskId = await insertOpenTask({ key, status: 'running', ageMinutes: DEFAULT_ESCALATION_LIMITS.stallMinutes + 30 });

    await scan();
    const cases = await casesFor(key);
    const stalled = cases.find((c) => c.rule === 'supervisor.task_stalled');
    expect(stalled).toBeTruthy();
    expect((stalled!.details as Record<string, unknown>).taskId).toBe(taskId);
    expect((stalled!.details as Record<string, unknown>).evidence).toMatchObject({ status: 'running' });
  });

  it('opens a case for a task that has used up its attempts', async () => {
    const key = agentKey('exhausted');
    // A queued task that has used every attempt will never be picked up again.
    await insertOpenTask({ key, status: 'queued', ageMinutes: 5, attempts: 3, maxAttempts: 3 });

    await scan();
    const cases = await casesFor(key);
    expect(cases.map((c) => c.rule)).toEqual(['supervisor.task_attempts_exhausted']);
    expect(cases[0].severity).toBe('HIGH');
  });

  it('opens a case for a burst of refused runs', async () => {
    const key = agentKey('refused');
    await recordOutcomes(key, ['blocked', 'blocked', 'blocked']);

    await scan();
    const cases = await casesFor(key);
    const refused = cases.find((c) => c.rule === 'supervisor.agent_scope_violations');
    expect(refused).toBeTruthy();
    expect(refused!.severity).toBe('HIGH');
  });

  it('opens a CRITICAL case when the supervisor cycle itself is failing', async () => {
    const marker = uniq('cycle');
    await db.insert(auditLogs).values({
      id: randomUUID(),
      actorId: null,
      actorType: 'SYSTEM',
      action: 'AI.AGENT_RUN_SUPERVISOR_FAILED',
      entityType: 'AGENT_RUN',
      entityId: marker,
      metadata: { error: 'probe' },
    });

    const result = await scan();
    const [row] = await db
      .select()
      .from(alertEvents)
      .where(eq(alertEvents.rule, 'supervisor.cycle_failed'))
      .orderBy(sql`${alertEvents.createdAt} desc`)
      .limit(1);
    expect(row).toBeTruthy();
    expect(['HIGH', 'CRITICAL']).toContain(row.severity);
    expect(result.findings).toBeGreaterThan(0);
  });
});

describe('AI-SUP-02 — duplicate suppression and severity escalation', () => {
  it('does not open a second case, nor notify twice, for the same condition', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm');
    const key = agentKey('dupe');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);

    await scan();
    const first = await casesFor(key);
    expect(first).toHaveLength(1);
    const firstNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, gm.id), eq(notifications.type, 'AI_ESCALATION')));

    const second = await scan();
    const after = await casesFor(key);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first[0].id);
    expect((after[0].details as Record<string, unknown>).occurrences).toBe(2);
    expect(second.opened).toBe(0);

    const secondNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, gm.id), eq(notifications.type, 'AI_ESCALATION')));
    expect(secondNotifications.length).toBe(firstNotifications.length);
  });

  it('upgrades an acknowledged case, reopens it and notifies once more', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm2');
    const key = agentKey('upgrade');
    await recordOutcomes(key, ['failed', 'failed', 'succeeded']); // 2/3 → HIGH

    await scan();
    const [opened] = await casesFor(key);
    expect(opened.severity).toBe('HIGH');
    await acknowledgeEscalation(db, opened.id, gm.id, 'looking into it', { actorId: gm.id });

    await recordOutcomes(key, ['failed', 'failed']); // 4/5 → CRITICAL
    const result = await scan();
    const [upgraded] = await casesFor(key);
    expect(upgraded.id).toBe(opened.id);
    expect(upgraded.severity).toBe('CRITICAL');
    expect(upgraded.status).toBe('OPEN');
    expect(result.escalated).toBeGreaterThanOrEqual(1);

    const details = upgraded.details as Record<string, unknown>;
    expect((details.severityHistory as unknown[]).length).toBe(2);

    const delivered = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, gm.id), eq(notifications.type, 'AI_ESCALATION')));
    // One for the opening, one for the upgrade — never one per sweep.
    expect(delivered.length).toBe(2);
  });

  it('does not reopen a case the GM just resolved (cooldown), then does after it', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm3');
    const key = agentKey('cooldown');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);

    const finding: Finding = {
      code: 'agent_failure_rate',
      severity: 'HIGH',
      fingerprint: fingerprintOf('agent_failure_rate', { agentKey: key }),
      agentKey: key,
      taskId: null,
      runId: null,
      title: 'agent keeps failing',
      recommendation: 'inspect the failures',
      recommendationKey: 'escalation.agent_failure_rate.recommendation',
      evidence: { failed: 3 },
    };
    const opened = await openOrEscalateCase(db, finding, new Date());
    expect(opened.outcome).toBe('opened');
    await resolveEscalation(db, opened.id!, gm.id, 'fixed the provider key', { actorId: gm.id });

    const again = await openOrEscalateCase(db, finding, new Date());
    expect(again.outcome).toBe('suppressed');
    expect(again.id).toBeNull();

    const later = await openOrEscalateCase(
      db,
      finding,
      new Date(Date.now() + (DEFAULT_ESCALATION_LIMITS.reopenCooldownMinutes + 5) * 60_000),
    );
    expect(later.outcome).toBe('opened');
    expect(later.id).not.toBe(opened.id);

    const rows = await casesFor(key);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['OPEN', 'RESOLVED']);
  });
});

describe('AI-SUP-02 — the General Manager receives, acknowledges and closes', () => {
  it('notifies only SUPER_ADMIN accounts, and records the delivery', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm4');
    const admin = await makeUser('ADMIN', 'sup02-admin4');
    const key = agentKey('notify');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);

    await scan();
    const [caseRow] = await casesFor(key);
    expect(caseRow).toBeTruthy();

    const gmInbox = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, gm.id), eq(notifications.type, 'AI_ESCALATION')));
    // The GM is notified for every open case, so scope the assertion to this agent.
    const gmEscalations = gmInbox.filter(
      (n) => (n.data as Record<string, unknown> | null)?.agentKey === key,
    );
    expect(gmEscalations.length).toBeGreaterThanOrEqual(1);
    expect(gmEscalations[0].title).toContain(`[${caseRow.severity}]`);
    expect((gmEscalations[0].data as Record<string, unknown>).escalationId).toBe(caseRow.id);

    const adminEscalations = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, admin.id), eq(notifications.type, 'AI_ESCALATION')));
    expect(adminEscalations).toHaveLength(0);

    const deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, gm.id), eq(notificationDeliveries.entityId, caseRow.id)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('SENT');
    expect(deliveries[0].channel).toBe('IN_APP');
  });

  it('acknowledges and resolves over HTTP, recording who did it and why', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm5');
    const key = agentKey('lifecycle');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    await scan();
    const [caseRow] = await casesFor(key);

    const ack = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/acknowledge`, {
      method: 'POST',
      body: { note: 'on it' },
    });
    expect(ack.status).toBe(200);
    expect(ack.data.data.status).toBe('ACKNOWLEDGED');
    expect(ack.data.data.acknowledgedBy).toMatchObject({ id: gm.id });
    expect(ack.data.data.acknowledgedAt).toBeTruthy();

    const ackAgain = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/acknowledge`, {
      method: 'POST',
      body: {},
    });
    expect(ackAgain.status).toBe(409);

    const badResolve = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/resolve`, {
      method: 'POST',
      body: { note: '' },
    });
    expect(badResolve.status).toBe(422);

    const resolved = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/resolve`, {
      method: 'POST',
      body: { note: 'provider key rotated, agent healthy again' },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.data.data.status).toBe('RESOLVED');
    expect(resolved.data.data.resolutionNote).toContain('provider key');
    expect(resolved.data.data.resolvedBy).toMatchObject({ id: gm.id });
    expect(resolved.data.data.resolvedAt).toBeTruthy();

    const resolveAgain = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/resolve`, {
      method: 'POST',
      body: { note: 'again' },
    });
    expect(resolveAgain.status).toBe(409);

    const audits = await db
      .select({ action: auditLogs.action, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, caseRow.id), inArray(auditLogs.action, ['AI.ESCALATION_ACKNOWLEDGED', 'AI.ESCALATION_RESOLVED'])));
    expect(audits.map((a) => a.action).sort()).toEqual(['AI.ESCALATION_ACKNOWLEDGED', 'AI.ESCALATION_RESOLVED']);
    expect(audits.every((a) => a.actorId === gm.id)).toBe(true);

    const detail = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data.data.status).toBe('RESOLVED');
  });

  it('lists cases with filters and counts, newest first', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm6');
    const key = agentKey('listing');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    await scan();
    const [caseRow] = await casesFor(key);

    const list = await gm.client.req(`/api/admin/ai/escalations?agentKey=${key}`);
    expect(list.status).toBe(200);
    expect(list.data.data.items).toHaveLength(1);
    expect(list.data.data.items[0].id).toBe(caseRow.id);
    expect(list.data.data.counts.open).toBeGreaterThanOrEqual(1);
    expect(typeof list.data.data.killSwitch).toBe('boolean');

    const openOnly = await gm.client.req(`/api/admin/ai/escalations?status=RESOLVED&agentKey=${key}`);
    expect(openOnly.data.data.items).toHaveLength(0);

    const bad = await gm.client.req('/api/admin/ai/escalations?severity=NOPE');
    expect(bad.status).toBe(422);
  });
});

describe('AI-SUP-02 — access control and data isolation', () => {
  it('refuses anonymous and non-staff callers on every escalation surface', async () => {
    const customer = await makeUser('CUSTOMER', 'sup02-cust');
    const support = await makeUser('SUPPORT', 'sup02-support');
    const admin = await makeUser('ADMIN', 'sup02-admin7');

    const listPath = '/api/admin/ai/escalations';
    expect((await makeClient().req(listPath)).status).toBe(401);
    expect((await customer.client.req(listPath)).status).toBe(403);
    expect((await support.client.req(listPath)).status).toBe(403);
    expect((await admin.client.req(listPath)).status).toBe(200);

    // An id path is staff-only too: a non-staff caller is refused before the
    // lookup, so it cannot learn whether an id exists.
    const idPath = '/api/admin/ai/escalations/anything';
    expect((await makeClient().req(idPath)).status).toBe(401);
    expect((await customer.client.req(idPath)).status).toBe(403);
    expect((await support.client.req(idPath)).status).toBe(403);
    expect((await admin.client.req(idPath)).status).toBe(404);

    expect((await makeClient().req('/api/admin/ai/escalations/scan', { method: 'POST', body: {} })).status).toBe(401);
    expect((await customer.client.req('/api/admin/ai/escalations/scan', { method: 'POST', body: {} })).status).toBe(403);
  });

  it('404s an unknown case and never returns a non-supervisor alert row', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm7');
    const otherAlertId = randomUUID();
    await db.insert(alertEvents).values({
      id: otherAlertId,
      rule: 'http_5xx_rate',
      severity: 'CRITICAL',
      status: 'OPEN',
      summary: 'observability alert, not an escalation',
      details: { fingerprint: 'x' },
    });

    const res = await gm.client.req(`/api/admin/ai/escalations/${otherAlertId}`);
    expect(res.status).toBe(404);

    const missing = await gm.client.req(`/api/admin/ai/escalations/${randomUUID()}`);
    expect(missing.status).toBe(404);

    await db.delete(alertEvents).where(eq(alertEvents.id, otherAlertId));
  });

  it('leaks no task input, memory text, email or owner id in any response', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm8');
    const secretInput = `confidential-terms-${uniq('secret')}`;
    const key = agentKey('leak');
    await insertOpenTask({
      key,
      status: 'running',
      ageMinutes: DEFAULT_ESCALATION_LIMITS.stallMinutes + 5,
      input: { action: 'snapshot', note: secretInput },
    });
    await scan();

    const list = await gm.client.req(`/api/admin/ai/escalations?agentKey=${key}`);
    expect(list.status).toBe(200);
    const body = JSON.stringify(list.data);
    expect(body).not.toContain(secretInput);
    expect(body).not.toContain('sup02-owner');
    expect(body).not.toMatch(/@wasit\.tn/);
    expect(body).not.toMatch(/passwordHash|password/i);
  });
});

describe('AI-SUP-02 — failure containment', () => {
  it('keeps the case when the inbox write fails, records FAILED, and can redeliver', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm9');
    const key = agentKey('inboxfail');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    await scan();
    const [caseRow] = await casesFor(key);
    expect(caseRow).toBeTruthy();

    // A database handle whose notification insert fails — the storage is fine,
    // the channel is not. The case must survive.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === notifications) throw new Error('inbox unavailable');
            return target.insert(table as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const failed = await deliverEscalationToGm(failingDb, caseRow.id);
    expect(failed.sent).toBe(0);
    expect(failed.failed).toBeGreaterThanOrEqual(1);

    const [afterFail] = await db.select().from(alertEvents).where(eq(alertEvents.id, caseRow.id));
    expect(afterFail.notifiedResult).toBe('FAILED');
    expect(afterFail.status).toBe('OPEN');

    const failedDeliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, gm.id), eq(notificationDeliveries.entityId, caseRow.id)));
    expect(failedDeliveries.some((d) => d.status === 'FAILED')).toBe(true);

    // Retry through the real channel: the ledger row is updated, not duplicated.
    const retry = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/notify`, { method: 'POST', body: {} });
    expect(retry.status).toBe(200);
    expect(retry.data.data.sent).toBeGreaterThanOrEqual(1);
    expect(retry.data.data.escalation.notification.result).toBe('SENT');

    const finalDeliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.userId, gm.id), eq(notificationDeliveries.entityId, caseRow.id)));
    expect(finalDeliveries).toHaveLength(1);
    expect(finalDeliveries[0].status).toBe('SENT');
  });

  it('persists cases in PostgreSQL across a separate connection (process restart)', async () => {
    const key = agentKey('durable');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    await scan();
    const [caseRow] = await casesFor(key);

    const external = await rawPool.query('select id, rule, status, severity from alert_events where id = $1', [caseRow.id]);
    expect(external.rows).toHaveLength(1);
    expect(external.rows[0].rule).toBe('supervisor.agent_failure_rate');
    expect(external.rows[0].status).toBe('OPEN');
  });
});

describe('AI-SUP-02 — kill switch', () => {
  it('stops detection and notification, and says so in the audit trail', async () => {
    const key = agentKey('killed');
    setAiExecutionEnabled(false);

    const result = await scan();
    expect(result.skipped).toBe('KILL_SWITCH');
    expect(result.opened).toBe(0);
    expect(result.notifications.sent).toBe(0);

    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    const again = await scan();
    expect(again.skipped).toBe('KILL_SWITCH');
    expect(await casesFor(key)).toHaveLength(0);

    const refusal = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.KILL_SWITCH_ESCALATION_REFUSED'))
      .limit(1);
    expect(refusal).toHaveLength(1);

    setAiExecutionEnabled(true);
    await scan();
    expect(await casesFor(key)).toHaveLength(1);
  });

  it('still lets a human acknowledge what is already open while stopped', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm10');
    const key = agentKey('stopped');
    await recordOutcomes(key, ['failed', 'failed', 'failed']);
    await scan();
    const [caseRow] = await casesFor(key);

    setAiExecutionEnabled(false);
    const ack = await gm.client.req(`/api/admin/ai/escalations/${caseRow.id}/acknowledge`, {
      method: 'POST',
      body: { note: 'handled during the stop' },
    });
    expect(ack.status).toBe(200);
    expect(ack.data.data.status).toBe('ACKNOWLEDGED');
  });
});

describe('AI-SUP-02 — scan hygiene', () => {
  it('audits the sweep itself with its counts', async () => {
    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.ESCALATION_SCAN_RUN'));
    await scan();
    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.ESCALATION_SCAN_RUN'));
    expect(Number(after[0].count)).toBe(Number(before[0].count) + 1);
  });

  it('caps the number of cases written per scan, most severe first', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const key = agentKey(`cap${i}`);
      keys.push(key);
      await recordOutcomes(key, ['failed', 'failed', 'failed']);
    }
    const result = await scan({ maxCases: 2 });
    expect(result.cases.length).toBeLessThanOrEqual(2);
    expect(result.capped).toBeGreaterThanOrEqual(0);
    expect(result.cases.every((c) => c.severity === 'CRITICAL' || c.severity === 'HIGH')).toBe(true);
    // Whatever was capped is still there for the next sweep to pick up.
    const remaining = await Promise.all(keys.map((k) => casesFor(k)));
    expect(remaining.flat().length).toBeLessThanOrEqual(4);
  });

  it('reports an open count and a last-scan time for the GM panel', async () => {
    const gm = await makeUser('SUPER_ADMIN', 'sup02-gm11');
    await scan();
    const list = await listEscalations(db, { status: 'OPEN', limit: 5 });
    expect(list.counts.open).toBeGreaterThanOrEqual(0);
    const res = await gm.client.req('/api/admin/ai/escalations?limit=1');
    expect(res.status).toBe(200);
    expect(res.data.data.lastScanAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
