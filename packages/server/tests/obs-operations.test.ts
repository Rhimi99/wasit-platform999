import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, like } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { alertEvents } from '../src/db/schema/observability.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { evaluateAlerts, resetAlertState, firingAlerts, type AlertRule } from '../src/lib/observability/alerts.js';
import {
  recordJobRun,
  resetJobRegistry,
  schedulerInfo,
  trackJob,
} from '../src/lib/observability/job-registry.js';

/**
 * OBS-OPS-01 — the GM operational snapshot, and the two human decisions it
 * exposes (acknowledge / resolve a platform alert).
 *
 * These are integration tests: real HTTP through `createApp`, real Postgres,
 * real audit writes. Nothing is mocked — the point of the surface is that its
 * numbers come from the systems that actually run.
 */

const app = createApp();

const PREFIX = 'obsops';
const RULES = {
  ack: `${PREFIX}_ack`,
  resolved: `${PREFIX}_resolved`,
  supervisor: `supervisor.${PREFIX}_case`,
  scopePlatform: `${PREFIX}_scope_platform`,
  guard: `${PREFIX}_guard`,
};

async function createUser(role: 'ADMIN' | 'CUSTOMER'): Promise<string> {
  const id = randomUUID();
  const email = `${PREFIX}-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 10000)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('ObsPass123!'),
    firstName: 'Obs Ops',
    isActive: true,
    emailVerified: true,
  });
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow.id });
  return email;
}

function makeClient() {
  let cookie = '';
  return {
    async req(
      path: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
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
    async login(email: string) {
      const res = await this.req('/api/auth/login', {
        method: 'POST',
        body: { email, password: 'ObsPass123!', allowUnverifiedEmail: true },
      });
      expect(res.status).toBe(200);
      return this;
    },
  };
}

async function insertAlert(row: {
  rule: string;
  status: 'FIRING' | 'RESOLVED' | 'OPEN';
  details?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(alertEvents).values({
    id,
    rule: row.rule,
    severity: 'CRITICAL',
    status: row.status,
    summary: `test row ${row.rule}`,
    details: row.details ?? { test: true },
    startedAt: new Date(),
  });
  return id;
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  return rows.map((r) => r.action);
}

let adminEmail = '';
let customerEmail = '';

beforeAll(async () => {
  adminEmail = await createUser('ADMIN');
  customerEmail = await createUser('CUSTOMER');
});

beforeEach(async () => {
  resetAlertState();
  await db.delete(alertEvents).where(like(alertEvents.rule, `${PREFIX}%`));
  await db.delete(alertEvents).where(like(alertEvents.rule, `supervisor.${PREFIX}%`));
  await db.delete(agentTasks).where(like(agentTasks.agentKey, `${PREFIX}%`));
});

afterAll(async () => {
  await db.delete(alertEvents).where(like(alertEvents.rule, `${PREFIX}%`));
  await db.delete(alertEvents).where(like(alertEvents.rule, `supervisor.${PREFIX}%`));
  await db.delete(agentTasks).where(like(agentTasks.agentKey, `${PREFIX}%`));
  resetAlertState();
  resetJobRegistry();
  await closeDb();
});

describe('Job registry', () => {
  beforeEach(() => resetJobRegistry());

  it('records outcomes, durations, and consecutive failures that reset on success', async () => {
    // Each job run reads the clock twice: start, then end.
    const ticks = [100, 160, 200, 260];
    const fakeNow = () => ticks.shift() ?? 300;
    await trackJob('job.a', async () => 'ok', fakeNow)();
    await trackJob('job.a', async () => 'ok', fakeNow)();
    let status = schedulerInfo().jobs.find((j) => j.name === 'job.a')!;
    expect(status.lastOutcome).toBe('ok');
    expect(status.lastDurationMs).toBe(60);
    expect(status.totalRuns).toBe(2);
    expect(status.consecutiveFailures).toBe(0);

    await trackJob('job.a', async () => {
      throw new Error('boom');
    })();
    status = schedulerInfo().jobs.find((j) => j.name === 'job.a')!;
    expect(status.lastOutcome).toBe('failed');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toBe('boom');
    expect(status.totalFailures).toBe(1);

    await trackJob('job.a', async () => 'skipped')();
    status = schedulerInfo().jobs.find((j) => j.name === 'job.a')!;
    expect(status.lastOutcome).toBe('skipped');
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastError).toBeNull();
  });

  it('reports the scheduler as not running until it is marked started', () => {
    expect(schedulerInfo().running).toBe(false);
    recordJobRun('job.b', { outcome: 'ok', durationMs: 1 });
    expect(schedulerInfo().jobs.map((j) => j.name)).toContain('job.b');
  });
});

describe('Operational snapshot — access control', () => {
  it('rejects anonymous and non-admin callers', async () => {
    const anon = makeClient();
    expect((await anon.req('/api/admin/observability/operations')).status).toBe(401);

    const customer = await makeClient().login(customerEmail);
    expect((await customer.req('/api/admin/observability/operations')).status).toBe(403);
  });
});

describe('Operational snapshot — content', () => {
  it('reports real platform, agent and alert state in one read', async () => {
    const admin = await makeClient().login(adminEmail);
    const res = await admin.req('/api/admin/observability/operations');
    expect(res.status).toBe(200);
    const snap = res.data.data;

    expect(snap.platform.db.status).toBe('up');
    expect(typeof snap.platform.db.latencyMs).toBe('number');
    // This very request is counted, so the counter can never be zero.
    expect(snap.platform.http.requests).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(snap.platform.http.topErrorRoutes)).toBe(true);
    expect(typeof snap.platform.killSwitch.enabled).toBe('boolean');
    expect(snap.platform.backup).toHaveProperty('ageHours');

    // Catalogue is code-owned: the eleven declared agents plus the Copilot.
    expect(snap.agents.catalogue.total).toBeGreaterThanOrEqual(11);
    expect(snap.agents.catalogue.copilot).toBe(true);
    expect(snap.agents.catalogue.executable).toBeGreaterThan(0);

    expect(Array.isArray(snap.alerts.firing)).toBe(true);
    expect(snap.alerts.notifier.notifier).toBeTruthy();
    expect(Array.isArray(snap.notifications.recentFailures)).toBe(true);
    expect(Array.isArray(snap.unavailable)).toBe(true);
    expect(Array.isArray(snap.recentEvents)).toBe(true);
    expect(snap.generatedAt).toBeTruthy();
    expect(snap.window.from < snap.window.to).toBe(true);
  });

  it('surfaces a stalled agent task and an open escalation instead of hiding them', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
    await db.insert(agentTasks).values({
      id: randomUUID(),
      agentKey: `${PREFIX}-agent`,
      requestedBy: randomUUID(),
      input: { goal: 'stalled' },
      status: 'running',
      createdAt: threeHoursAgo,
    });
    await insertAlert({ rule: RULES.supervisor, status: 'OPEN' });

    const admin = await makeClient().login(adminEmail);
    const snap = (await admin.req('/api/admin/observability/operations')).data.data;

    expect(snap.agents.tasks.stalled.count).toBeGreaterThanOrEqual(1);
    expect(snap.agents.tasks.stalled.thresholdMinutes).toBeGreaterThan(0);
    expect(snap.agents.escalations.open).toBeGreaterThanOrEqual(1);
  });
});

describe('Alert scope filter', () => {
  it('separates platform alerts from supervisor escalation cases', async () => {
    await insertAlert({ rule: RULES.scopePlatform, status: 'FIRING' });
    await insertAlert({ rule: RULES.supervisor, status: 'OPEN' });

    const admin = await makeClient().login(adminEmail);

    const platform = (await admin.req('/api/admin/observability/alerts?scope=platform&limit=200')).data.data;
    expect(platform.some((r: { rule: string }) => r.rule === RULES.scopePlatform)).toBe(true);
    expect(platform.some((r: { rule: string }) => r.rule.startsWith('supervisor.'))).toBe(false);

    const supervisor = (await admin.req('/api/admin/observability/alerts?scope=supervisor&limit=200')).data.data;
    expect(supervisor.length).toBeGreaterThanOrEqual(1);
    expect(supervisor.every((r: { rule: string }) => r.rule.startsWith('supervisor.'))).toBe(true);
  });
});

describe('Alert acknowledgement', () => {
  it('marks attention without pretending the incident is over, and audits it', async () => {
    const id = await insertAlert({ rule: RULES.ack, status: 'FIRING' });
    const admin = await makeClient().login(adminEmail);

    const res = await admin.req(`/api/admin/observability/alerts/${id}/acknowledge`, {
      method: 'POST',
      body: { note: 'looking into it' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('FIRING');
    expect(res.data.data.details.ack.note).toBe('looking into it');
    expect(res.data.data.details.ack.by).toBeTruthy();

    expect(await auditActions(id)).toContain('OBSERVABILITY.ALERT_ACKNOWLEDGED');
  });

  it('refuses to acknowledge a resolved row or a supervisor case', async () => {
    const resolvedId = await insertAlert({ rule: RULES.resolved, status: 'RESOLVED' });
    const supervisorId = await insertAlert({ rule: RULES.supervisor, status: 'OPEN' });
    const admin = await makeClient().login(adminEmail);

    const resolved = await admin.req(`/api/admin/observability/alerts/${resolvedId}/acknowledge`, {
      method: 'POST',
      body: {},
    });
    expect(resolved.status).toBe(409);

    const supervisor = await admin.req(`/api/admin/observability/alerts/${supervisorId}/acknowledge`, {
      method: 'POST',
      body: {},
    });
    expect(supervisor.status).toBe(409);
    expect(String(supervisor.data.error.message)).toMatch(/escalations/i);
  });

  it('returns 404 for an unknown alert id', async () => {
    const admin = await makeClient().login(adminEmail);
    const res = await admin.req(`/api/admin/observability/alerts/${randomUUID()}/acknowledge`, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(404);
  });
});

describe('Alert resolution', () => {
  it('requires a reason and closes a stale row, auditing who and why', async () => {
    const id = await insertAlert({ rule: RULES.resolved, status: 'FIRING' });
    const admin = await makeClient().login(adminEmail);

    const noReason = await admin.req(`/api/admin/observability/alerts/${id}/resolve`, {
      method: 'POST',
      body: {},
    });
    expect(noReason.status).toBe(422);

    const res = await admin.req(`/api/admin/observability/alerts/${id}/resolve`, {
      method: 'POST',
      body: { note: 'left over from the pre-restart run' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('RESOLVED');
    expect(res.data.data.resolvedAt).toBeTruthy();
    expect(res.data.data.details.resolution.manual).toBe(true);
    expect(await auditActions(id)).toContain('OBSERVABILITY.ALERT_RESOLVED_MANUALLY');

    const again = await admin.req(`/api/admin/observability/alerts/${id}/resolve`, {
      method: 'POST',
      body: { note: 'second attempt' },
    });
    expect(again.status).toBe(409);
  });

  it('refuses to close a rule that is still firing', async () => {
    const alwaysFiring: AlertRule = {
      name: RULES.guard,
      severity: 'CRITICAL',
      summary: 'guard rule for the manual-resolve test',
      evaluate: async () => ({ probe: 'still broken' }),
    };
    await evaluateAlerts(db, [alwaysFiring]);
    expect(firingAlerts().some((a) => a.rule === RULES.guard)).toBe(true);

    const [row] = await db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.rule, RULES.guard), eq(alertEvents.status, 'FIRING')))
      .limit(1);
    expect(row).toBeTruthy();

    const admin = await makeClient().login(adminEmail);
    const res = await admin.req(`/api/admin/observability/alerts/${row.id}/resolve`, {
      method: 'POST',
      body: { note: 'trying to mute a live incident' },
    });
    expect(res.status).toBe(409);
    expect(String(res.data.error.message)).toMatch(/still firing/i);

    // The row is untouched: a refused mute must not close anything.
    const [after] = await db.select().from(alertEvents).where(eq(alertEvents.id, row.id)).limit(1);
    expect(after.status).toBe('FIRING');
  });
});
