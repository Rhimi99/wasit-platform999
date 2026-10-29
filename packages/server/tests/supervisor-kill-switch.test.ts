import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { createAgentTask, setAgentStatus, syncAgentRegistry, SUPERVISOR_KEY } from '../src/modules/ai/runner.js';

const AUDIT = { actorId: 'supervisor-kill-switch-test' };
const createdTaskIds: string[] = [];
const createdUserIds: string[] = [];

async function insertAdmin() {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `sup-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`,
    passwordHash: await argon2.hash('SupPass123!'),
    firstName: 'SUPER_ADMIN',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

const track = (id: string) => { createdTaskIds.push(id); return id; };

async function createSupervisorTask(adminId: string) {
  const task = await createAgentTask(
    db, ['ADMIN'], adminId,
    { agentKey: SUPERVISOR_KEY, taskType: 'supervisor.observe', input: {} }, AUDIT,
  );
  track(task.id);
  return task;
}

beforeAll(async () => {
  await syncAgentRegistry(db);
});

afterAll(async () => {
  await setAgentStatus(db, SUPERVISOR_KEY, 'ACTIVE', 'test cleanup', AUDIT);
  if (createdTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('R1 — supervisor respects the kill switch', () => {
  it('does not run a PAUSED supervisor and records the correct blocked status', async () => {
    const admin = await insertAdmin();
    await setAgentStatus(db, SUPERVISOR_KEY, 'PAUSED', 'r1 test', AUDIT);
    try {
      const task = await createSupervisorTask(admin);
      expect(task.status).toBe('blocked');
      expect(task.status).not.toBe('succeeded');
      expect(task.result).toBeNull();
      expect(String((task.error as { message?: string })?.message ?? '')).toContain('paused');
    } finally {
      await setAgentStatus(db, SUPERVISOR_KEY, 'ACTIVE', 'r1 cleanup', AUDIT);
    }
  });

  it('does not run a DISABLED supervisor', async () => {
    const admin = await insertAdmin();
    await setAgentStatus(db, SUPERVISOR_KEY, 'DISABLED', 'r1 test', AUDIT);
    try {
      const task = await createSupervisorTask(admin);
      expect(task.status).toBe('blocked');
      expect(task.result).toBeNull();
      expect(String((task.error as { message?: string })?.message ?? '')).toContain('disabled');
    } finally {
      await setAgentStatus(db, SUPERVISOR_KEY, 'ACTIVE', 'r1 cleanup', AUDIT);
    }
  });

  it('still runs an ACTIVE supervisor deterministically with unchanged permissions', async () => {
    const admin = await insertAdmin();
    await setAgentStatus(db, SUPERVISOR_KEY, 'ACTIVE', 'r1 test', AUDIT);
    const task = await createSupervisorTask(admin);
    expect(task.status).toBe('succeeded');
    const advice = JSON.parse(String((task.result as { advice: string }).advice)) as {
      deterministic: boolean;
      report: { total: number };
    };
    expect(advice.deterministic).toBe(true);
    expect(typeof advice.report.total).toBe('number');
  });

  it('leaves the kill switch in force for ordinary agents', async () => {
    const adminId = await insertAdmin();
    await setAgentStatus(db, 'operations-agent', 'PAUSED', 'r1 test', AUDIT);
    try {
      const task = await createAgentTask(
        db, ['ADMIN'], adminId,
        { agentKey: 'operations-agent', taskType: 'operations.health_check', input: {} }, AUDIT,
      );
      track(task.id);
      expect(task.status).toBe('blocked');
      expect(String((task.error as { message?: string })?.message ?? '')).toContain('paused');
    } finally {
      await setAgentStatus(db, 'operations-agent', 'ACTIVE', 'r1 cleanup', AUDIT);
    }
  });
});
