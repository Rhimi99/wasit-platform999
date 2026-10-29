import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentRegistry, agentTasks, agentSchedules } from '../src/db/schema/agents.js';
import { suppliers } from '../src/db/schema/trade.js';
import { AGENT_CATALOGUE, COPILOT_CATALOGUE } from '../src/modules/ai/catalogue.js';
import {
  syncAgentRegistry,
  createAgentTask,
  decideAgentTask,
  getTask,
  setAgentStatus,
  executeDueTasks,
  reapStaleTasks,
  agentTaskSummary,
} from '../src/modules/ai/runner.js';
import { routeEvents, ensureSchedules, dispatchDueSchedules, summarizeRun, EVENT_ROUTING, DEFAULT_SCHEDULES } from '../src/modules/ai/copilot.js';
import { supervise } from '../src/modules/ai/supervisor.js';

const AUDIT = { actorId: 'test' };

async function insertStaff(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'RISK' | 'DISPUTE' | 'MERCHANT' | 'CUSTOMER' = 'ADMIN') {
  const id = randomUUID();
  const email = `p19-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  const passwordHash = await argon2.hash('Phase19Pass123!');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

describe('Phase 19 — agent layer integration', () => {
  it('catalogue declares exactly 20 specialised agents plus the Copilot', () => {
    expect(AGENT_CATALOGUE).toHaveLength(20);
    expect(COPILOT_CATALOGUE.isCopilot).toBe(true);
    expect(COPILOT_CATALOGUE.key).toBe('wasit-copilot');
    // The Copilot is not counted among the 20.
    expect(AGENT_CATALOGUE.find((a) => a.key === COPILOT_CATALOGUE.key)).toBeUndefined();
  });

  it('includes the Agent Supervisor as agent #20 with oversight scope', () => {
    const sup = AGENT_CATALOGUE.find((a) => a.key === 'agent-supervisor');
    expect(sup).toBeTruthy();
    expect(sup?.isSupervisor).toBe(true);
    expect(sup?.taskTypes).toContain('supervisor.observe');
    expect(sup?.permissionsRequired).toContain('ai:manage');
    // The supervisor may never approve; it is bounded to observation.
    expect(sup?.approvalActions).toEqual([]);
  });

  it('every agent is bounded: has tools, limits and task types', () => {
    for (const a of AGENT_CATALOGUE) {
      expect(a.allowedTools.length, `${a.key} tools`).toBeGreaterThan(0);
      expect(a.taskTypes.length, `${a.key} task types`).toBeGreaterThan(0);
      expect(Object.keys(a.limits).length, `${a.key} limits`).toBeGreaterThan(0);
    }
  });

  it('does not create a Security Guardian / Cyber Defense agent', () => {
    const keys = AGENT_CATALOGUE.map((a) => a.key.toLowerCase());
    expect(keys.some((k) => k.includes('security-guardian') || k.includes('cyber'))).toBe(false);
  });

  it('syncAgentRegistry is idempotent and preserves operator status', async () => {
    await syncAgentRegistry(db);
    await syncAgentRegistry(db);
    const rows = await db.select().from(agentRegistry);
    expect(rows.length).toBe(21); // 20 + copilot
    const sales = rows.find((r) => r.key === 'sales-agent')!;
    await setAgentStatus(db, 'sales-agent', 'PAUSED', 'test', AUDIT);
    await syncAgentRegistry(db);
    const again = await db.select().from(agentRegistry).where(eq(agentRegistry.key, 'sales-agent')).limit(1);
    expect(again[0].status).toBe('PAUSED'); // re-seed must not clobber lifecycle state
    expect(sales.key).toBe('sales-agent');
    await setAgentStatus(db, 'sales-agent', 'ACTIVE', null, AUDIT);
  });

  it('sensitive actions are queued for approval; approval is recorded separately from execution', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {} },
      AUDIT,
    );
    expect(task.status).toBe('awaiting_approval');
    expect(task.requiresApproval).toBe(true);
    expect(task.approvalAction).toBe('finance.payout');

    const approved = await decideAgentTask(db, task.id, admin.id, 'APPROVE', 'ok', AUDIT);
    // Granting approval records the decision only; it is not execution.
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(admin.id);

    // The scheduler dispatches the approved task and records the real outcome.
    await executeDueTasks(db);
    const done = await getTask(db, task.id);
    expect(['succeeded', 'failed', 'blocked']).toContain(done.status);
  });

  it('rejecting a task never runs it', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'risk-agent', taskType: 'risk.scan', input: {} },
      AUDIT,
    );
    const decided = await decideAgentTask(db, task.id, admin.id, 'REJECT', 'no', AUDIT);
    expect(decided.status).toBe('rejected');
    expect(decided.result).toBeNull();
  });

  it('read-only agents run immediately without approval', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'analytics-agent', taskType: 'analytics.report', input: {} },
      AUDIT,
    );
    expect(task.requiresApproval).toBe(false);
    expect(['succeeded', 'failed']).toContain(task.status);
  });

  it('dedupe key returns the same open task instead of creating a second', async () => {
    const admin = await insertStaff('ADMIN');
    const key = `dedupe-${randomUUID()}`;
    // A gated (open, awaiting_approval) task is the state dedupe protects. A
    // non-gated task runs to a terminal status inline, so it is not "open".
    const a = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT);
    const b = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT);
    expect(b.id).toBe(a.id);
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.dedupeKey, key));
    expect(rows.length).toBe(1);
  });

  it('dedupe key creates a new task when the key differs', async () => {
    const admin = await insertStaff('ADMIN');
    const a = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: `dedupe-${randomUUID()}` }, AUDIT);
    const b = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: `dedupe-${randomUUID()}` }, AUDIT);
    expect(b.id).not.toBe(a.id);
  });

  it('dedupe key is scoped to its owner: a second owner reusing the key gets their own task', async () => {
    const owner = await insertStaff('ADMIN');
    const other = await insertStaff('ADMIN');
    const key = `dedupe-shared-${randomUUID()}`;
    const a = await createAgentTask(db, ['ADMIN'], owner.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: { seed: 'owner' }, dedupeKey: key }, AUDIT);
    // The other owner must NOT receive the first owner's open task...
    const b = await createAgentTask(db, ['ADMIN'], other.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: { seed: 'other' }, dedupeKey: key }, AUDIT);
    expect(b.id).not.toBe(a.id);
    expect(b.requestedBy).toBe(other.id);
    expect((b.input as { seed?: string }).seed).toBe('other');
    // ...and the owner still gets their original task on a re-submit.
    const again = await createAgentTask(db, ['ADMIN'], owner.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT);
    expect(again.id).toBe(a.id);
    // Exactly one open task per owner for this key (the partial unique index).
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.dedupeKey, key));
    expect(rows).toHaveLength(2);
  });

  it('dedupe key is reusable after the previous task reaches a terminal status', async () => {
    const admin = await insertStaff('ADMIN');
    const key = `dedupe-reuse-${randomUUID()}`;
    const a = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT);
    expect(a.status).toBe('awaiting_approval');
    await decideAgentTask(db, a.id, admin.id, 'REJECT', 'not now', AUDIT);
    const b = await createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT);
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('awaiting_approval');
  });

  it('concurrent double-submit with the same key yields exactly one open task', async () => {
    const admin = await insertStaff('ADMIN');
    const key = `dedupe-race-${randomUUID()}`;
    const [a, b] = await Promise.all([
      createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT),
      createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {}, dedupeKey: key }, AUDIT),
    ]);
    expect(a.id).toBe(b.id);
    const rows = await db.select().from(agentTasks).where(eq(agentTasks.dedupeKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('awaiting_approval');
  });

  it('RBAC: a role lacking the required permission cannot create a task', async () => {
    const merchant = await insertStaff('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchant.id, { agentKey: 'risk-agent', taskType: 'risk.scan', input: {} }, AUDIT),
    ).rejects.toBeTruthy();
  });

  it('kill switch: a DISABLED agent blocks its approved task when the scheduler dispatches it', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'finance-agent', taskType: 'finance.reconcile', input: {} },
      AUDIT,
    );
    await setAgentStatus(db, 'finance-agent', 'DISABLED', 'test', AUDIT);
    const approved = await decideAgentTask(db, task.id, admin.id, 'APPROVE', null, AUDIT);
    expect(approved.status).toBe('approved');
    await executeDueTasks(db);
    const after = await getTask(db, task.id);
    expect(after.status).toBe('blocked');
    await setAgentStatus(db, 'finance-agent', 'ACTIVE', null, AUDIT);
  });

  it('isolation: supplier agent exposes a supplier only to its owner', async () => {
    const owner = await insertStaff('MERCHANT');
    const other = await insertStaff('MERCHANT');
    const ownedSupplierId = randomUUID();
    await db.insert(suppliers).values({ id: ownedSupplierId, userId: owner.id, companyName: 'Owned Co', slug: `owned-${randomUUID()}` });
    const unownedSupplierId = randomUUID();
    await db.insert(suppliers).values({ id: unownedSupplierId, userId: other.id, companyName: 'Other Co', slug: `other-${randomUUID()}` });

    // A requested id the caller does not own yields an empty scope.
    const unowned = await createAgentTask(
      db,
      ['ADMIN'],
      owner.id,
      { agentKey: 'supplier-agent', taskType: 'supplier.onboard', input: { supplierId: unownedSupplierId } },
      AUDIT,
    );
    const uAdvice = JSON.parse(String((unowned.result as { advice: string }).advice)) as { suppliers: { id: string }[] };
    expect(uAdvice.suppliers).toHaveLength(0);

    // The caller's own supplier is returned.
    const owned = await createAgentTask(
      db,
      ['ADMIN'],
      owner.id,
      { agentKey: 'supplier-agent', taskType: 'supplier.onboard', input: { supplierId: ownedSupplierId } },
      AUDIT,
    );
    const oAdvice = JSON.parse(String((owned.result as { advice: string }).advice)) as { suppliers: { id: string }[] };
    expect(oAdvice.suppliers).toHaveLength(1);
    expect(oAdvice.suppliers[0].id).toBe(ownedSupplierId);
  });

  it('outreach agent drafts only and never sends externally', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'outreach-acquisition-agent', taskType: 'outreach.run_cycle', input: {} },
      AUDIT,
    );
    expect(task.status).toBe('awaiting_approval');
    expect(task.approvalAction).toBe('outreach.send');
  });

  it('isolation: outreach agent never surfaces another tenant\'s identity rows', async () => {
    const owner = await insertStaff('MERCHANT');
    const other = await insertStaff('MERCHANT');
    const secretName = `Secret Co ${randomUUID()}`;
    await db.insert(suppliers).values({
      id: randomUUID(),
      userId: other.id,
      companyName: secretName,
      slug: `secret-${randomUUID()}`,
      verified: true,
      isActive: true,
    });

    const task = await createAgentTask(
      db,
      ['ADMIN'],
      owner.id,
      { agentKey: 'outreach-acquisition-agent', taskType: 'outreach.run_cycle', input: {} },
      AUDIT,
    );
    const approved = await decideAgentTask(db, task.id, owner.id, 'APPROVE', null, AUDIT);
    expect(approved.status).toBe('approved');
    await executeDueTasks(db);
    const decided = await getTask(db, task.id);
    const advice = JSON.parse(String((decided.result as { advice: string }).advice)) as {
      scopedToOwned: boolean;
      candidates: { id: string; name: string }[];
      platformCounts: { suppliers: number };
    };
    // Raw identity rows are scoped to the caller: the other tenant's supplier
    // name must never appear, even though it is counted platform-wide.
    expect(advice.scopedToOwned).toBe(true);
    expect(advice.candidates.some((c) => c.name === secretName)).toBe(false);
    expect(typeof advice.platformCounts.suppliers).toBe('number');
  });

  it('copilot routes an event to its owning agent with a shared correlation id', async () => {
    const admin = await insertStaff('ADMIN');
    const result = await routeEvents(db, [{ event: 'dispute.opened', payload: {} }], admin.id, ['ADMIN'], AUDIT);
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0].agentKey).toBe(EVENT_ROUTING['dispute.opened'].agentKey);
    const summary = await summarizeRun(db, result.correlationId);
    expect(summary.total).toBeGreaterThanOrEqual(1);
  });

  it('copilot does not escalate a caller lacking the target agents: no risk/dispute/payment tasks', async () => {
    // A CUSTOMER holds only `ai:use`, not `risk:read`/`dispute:read`/`order:read`.
    // The Copilot must not forge SUPER_ADMIN: routing an event to an agent the
    // caller cannot use must be skipped and must not create a runnable task
    // that would leak that agent's platform-wide data.
    const customer = await insertStaff('CUSTOMER');
    const result = await routeEvents(
      db,
      [{ event: 'risk.flagged' }, { event: 'dispute.opened' }, { event: 'order.paid' }],
      customer.id,
      ['CUSTOMER'],
      AUDIT,
    );
    expect(result.routed).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    for (const agentKey of ['risk-agent', 'dispute-assistant', 'payment-settlement-agent']) {
      const rows = await db
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(and(eq(agentTasks.requestedBy, customer.id), eq(agentTasks.agentKey, agentKey)));
      expect(rows, `${agentKey} task must not exist`).toHaveLength(0);
    }
    // An ADMIN (holds risk:read/dispute:read/order:read) still routes normally.
    const admin = await insertStaff('ADMIN');
    const adminRun = await routeEvents(db, [{ event: 'risk.flagged' }], admin.id, ['ADMIN'], AUDIT);
    expect(adminRun.routed).toHaveLength(1);
    expect(adminRun.routed[0].agentKey).toBe('risk-agent');
  });

  it('copilot caps fan-out and de-duplicates a repeated event in one batch', async () => {
    const admin = await insertStaff('ADMIN');
    const result = await routeEvents(
      db,
      [{ event: 'order.placed' }, { event: 'order.placed' }],
      admin.id,
      ['ADMIN'],
      AUDIT,
    );
    expect(result.routed).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason.includes('duplicate'))).toBe(true);
  });

  it('copilot schedules the supervisor observation and dispatches idempotently', async () => {
    expect(DEFAULT_SCHEDULES.some((s) => s.agentKey === 'agent-supervisor' && s.taskType === 'supervisor.observe')).toBe(true);
    const first = await ensureSchedules(db);
    const second = await ensureSchedules(db);
    expect(second).toBe(0);
    const rows = await db.select().from(agentSchedules);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Force a due window and dispatch once.
    await db.update(agentSchedules).set({ nextRunAt: new Date(Date.now() - 1000), enabled: true });
    const { dispatched } = await dispatchDueSchedules(db);
    expect(dispatched).toBeGreaterThanOrEqual(1);
    const again = await dispatchDueSchedules(db);
    expect(again.dispatched).toBe(0);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it('watchdog fails a task stuck in running', async () => {
    const admin = await insertStaff('ADMIN');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'analytics-agent',
      requestedBy: admin.id,
      input: {} as never,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const reaped = await reapStaleTasks(db, 300);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
    expect(row[0].status).toBe('failed');
  });

  it('executeDueTasks runs queued tasks', async () => {
    const admin = await insertStaff('ADMIN');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'operations-agent',
      requestedBy: admin.id,
      taskType: 'operations.health_check',
      input: {} as never,
      status: 'queued',
      scheduledFor: new Date(Date.now() - 1000),
    });
    const res = await executeDueTasks(db, 50);
    expect(res.ran).toBeGreaterThanOrEqual(1);
  });

  it('supervisor flags a stuck running task as failed', async () => {
    const admin = await insertStaff('ADMIN');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'analytics-agent',
      requestedBy: admin.id,
      input: {} as never,
      status: 'running',
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const report = await supervise(db);
    const row = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
    expect(row[0].status).toBe('failed');
    expect(report.interventions.some((i) => i.taskId === id)).toBe(true);
  });

  it('supervisor contains a retry loop at the attempt ceiling', async () => {
    const admin = await insertStaff('ADMIN');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'marketing-agent',
      requestedBy: admin.id,
      input: {} as never,
      status: 'queued',
      attempts: 3,
      maxAttempts: 3,
    });
    const report = await supervise(db);
    const row = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
    expect(row[0].status).toBe('failed');
    expect(report.loopDetected).toBe(true);
    expect(row[0].error).toMatchObject({ supervisor: true });
  });

  it('supervisor blocks a task that breached the per-run budget', async () => {
    const admin = await insertStaff('ADMIN');
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      agentKey: 'finance-agent',
      requestedBy: admin.id,
      input: {} as never,
      status: 'running',
      startedAt: new Date(),
      cost: '9.99',
    });
    await supervise(db);
    const row = await db.select().from(agentTasks).where(eq(agentTasks.id, id)).limit(1);
    expect(row[0].status).toBe('blocked');
  });

  it('supervisor agent runs deterministically without an approval gate', async () => {
    const admin = await insertStaff('ADMIN');
    const task = await createAgentTask(
      db,
      ['ADMIN'],
      admin.id,
      { agentKey: 'agent-supervisor', taskType: 'supervisor.observe', input: {} },
      AUDIT,
    );
    expect(task.requiresApproval).toBe(false);
    expect(task.status).toBe('succeeded');
    const advice = JSON.parse(String((task.result as { advice: string }).advice)) as {
      deterministic: boolean;
      report: { total: number };
    };
    expect(advice.deterministic).toBe(true);
    expect(typeof advice.report.total).toBe('number');
  });

  it('capability boundary: an unknown task type is refused', async () => {
    const admin = await insertStaff('ADMIN');
    await expect(
      createAgentTask(db, ['ADMIN'], admin.id, { agentKey: 'sales-agent', taskType: 'finance.payout', input: {} }, AUDIT),
    ).rejects.toBeTruthy();
  });

  it('summary reports task counts for the admin desk', async () => {
    const summary = await agentTaskSummary(db);
    expect(typeof summary.total).toBe('number');
    expect(summary.total).toBeGreaterThanOrEqual(0);
  });
});
