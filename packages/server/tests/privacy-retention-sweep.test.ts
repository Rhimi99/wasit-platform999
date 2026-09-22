import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { dataDeletionRequests } from '../src/db/schema/privacy.js';
import { advanceDueDeletionRetentions } from '../src/modules/privacy/service.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();

afterAll(async () => {
  await resetRateLimitStore();
});

function makeClient(ip = `198.51.100.${Math.floor(Math.random() * 200 + 1)}`) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
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
      return { res, data: data as Record<string, unknown>, status: res.status };
    },
  };
}

/**
 * Seeds a deletion request directly in a chosen stage/deadline. Driving the real
 * request route would only ever produce a future deadline, and time cannot be
 * advanced in-process — so the fixture is inserted, then the real sweep runs.
 */
async function seedRequest(prefix: string, stage: 'DEACTIVATED' | 'RETENTION', deadline: Date) {
  const userId = randomUUID();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash: await argon2.hash('Passw0rd!Secure'),
    firstName: prefix,
    emailVerified: true,
    isActive: false,
  });
  const requestId = randomUUID();
  await db.insert(dataDeletionRequests).values({
    id: requestId,
    userId,
    requestedBy: userId,
    stage,
    retentionUntil: deadline,
    retentionPolicy: { defaultRetentionDays: 90, legalHoldFinanciallyRequired: true, preserves: [] },
  });
  return { userId, requestId, email };
}

async function makeAdminClient() {
  const adminId = randomUUID();
  const adminEmail = `sweep-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id: adminId,
    email: adminEmail,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'Sweep Admin',
    emailVerified: true,
    isActive: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role.id });
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return client;
}

async function stageOf(requestId: string): Promise<string> {
  const [row] = await db
    .select({ stage: dataDeletionRequests.stage })
    .from(dataDeletionRequests)
    .where(eq(dataDeletionRequests.id, requestId))
    .limit(1);
  return row.stage;
}

describe('PHASE 17 — automatic retention-window sweep', () => {
  it('advances DEACTIVATED → RETENTION immediately and RETENTION → ELIGIBLE once the window elapses', async () => {
    const past = new Date(Date.now() - 60_000);
    const deactivated = await seedRequest('sweep-deact', 'DEACTIVATED', past);
    const retaining = await seedRequest('sweep-ret', 'RETENTION', past);

    const result = await advanceDueDeletionRetentions(db);

    expect(result.requestIds).toContain(deactivated.requestId);
    expect(result.requestIds).toContain(retaining.requestId);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    expect(result.eligible).toBeGreaterThanOrEqual(1);
    expect(await stageOf(deactivated.requestId)).toBe('RETENTION');
    expect(await stageOf(retaining.requestId)).toBe('ELIGIBLE');
  });

  it('leaves a RETENTION request with a future window untouched', async () => {
    const future = new Date(Date.now() + 30 * 86400_000);
    const holding = await seedRequest('sweep-future', 'RETENTION', future);

    const result = await advanceDueDeletionRetentions(db);

    expect(result.requestIds).not.toContain(holding.requestId);
    expect(await stageOf(holding.requestId)).toBe('RETENTION');
  });

  it('walks a due request one stage per run and then stops at ELIGIBLE', async () => {
    const past = new Date(Date.now() - 60_000);
    const req = await seedRequest('sweep-converge', 'DEACTIVATED', past);

    const first = await advanceDueDeletionRetentions(db);
    expect(first.requestIds).toContain(req.requestId);
    expect(await stageOf(req.requestId)).toBe('RETENTION');

    const second = await advanceDueDeletionRetentions(db);
    expect(second.requestIds).toContain(req.requestId);
    expect(await stageOf(req.requestId)).toBe('ELIGIBLE');

    // Converged: further runs must not touch it, and never anonymize on their own.
    const third = await advanceDueDeletionRetentions(db);
    expect(third.requestIds).not.toContain(req.requestId);
    expect(await stageOf(req.requestId)).toBe('ELIGIBLE');
  });

  it('does not move the same request twice within a single run', async () => {
    const past = new Date(Date.now() - 60_000);
    const req = await seedRequest('sweep-once', 'DEACTIVATED', past);

    const first = await advanceDueDeletionRetentions(db);
    // Exactly one transition for this request, even though the window is open and
    // the row would satisfy a naive re-scan of the RETENTION branch.
    expect(first.requestIds.filter((id) => id === req.requestId)).toHaveLength(1);
    expect(await stageOf(req.requestId)).toBe('RETENTION');
  });

  it('never anonymizes automatically, and records a system audit entry per moved request', async () => {
    const past = new Date(Date.now() - 60_000);
    const req = await seedRequest('sweep-audit', 'DEACTIVATED', past);

    await advanceDueDeletionRetentions(db);

    const [userRow] = await db
      .select({ email: users.email, isLocked: users.isLocked })
      .from(users)
      .where(eq(users.id, req.userId))
      .limit(1);
    // PII must survive the sweep: it is a stage move, not an erasure.
    expect(userRow.email).toBe(req.email);
    expect(userRow.isLocked).toBe(false);

    const audit = await db
      .select({ actorId: auditLogs.actorId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'PRIVACY.DELETION_STAGE'), eq(auditLogs.entityId, req.userId)));
    expect(audit.length).toBe(1);
    expect(audit[0].actorId).toBeNull();
    expect((audit[0].metadata as { automated?: boolean }).automated).toBe(true);
  });

  it('POST /api/admin/privacy/deletions/retention-sweep runs the job for an admin', async () => {
    const past = new Date(Date.now() - 60_000);
    const req = await seedRequest('sweep-route', 'DEACTIVATED', past);
    const admin = await makeAdminClient();

    const res = await admin.req('/api/admin/privacy/deletions/retention-sweep', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const data = res.data.data as { requestIds: string[]; retained: number; eligible: number };
    expect(data.requestIds).toContain(req.requestId);
    expect(await stageOf(req.requestId)).toBe('RETENTION');
  });

  it('rejects the sweep for a non-admin (RBAC on the route, not just the UI)', async () => {
    const res = await makeClient().req('/api/admin/privacy/deletions/retention-sweep', { method: 'POST' });
    expect([401, 403]).toContain(res.status);
  });
});
