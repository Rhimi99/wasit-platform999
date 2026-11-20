import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { agentSchedules } from '../src/db/schema/agent_schedules.js';
import { aiRequests } from '../src/db/schema/ai.js';
import { ensureAgentRegistrySeeded } from '../src/modules/ai/agents.js';
import {
  createAgentSchedule,
  runDueAgentSchedules,
  MIN_SCHEDULE_INTERVAL_MINUTES,
} from '../src/modules/ai/scheduling.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-01.8 — ownership of Scheduler-created AI requests.
 *
 * The scheduler creates an agent task and executes it, which records an
 * `ai_requests` row attributed to the schedule's creator. That row is *not*
 * returned to the caller, so an id-only cleanup never sees it. This spec proves
 * the ownership rule the suite now relies on:
 *   - a scheduler-created request is discoverable by its owner (the creator),
 *   - cleanup removes it,
 *   - rows owned by other specs (or pre-existing rows) are never touched.
 */

const ownedUserIds: string[] = [];
const foreignRequestIds: string[] = [];
const foreignTaskIds: string[] = [];

async function insertUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-ai018-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: 'x',
    firstName: 'IT',
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  ownedUserIds.push(id);
  return id;
}

beforeAll(async () => {
  await ensureAgentRegistrySeeded(db);
});

afterAll(async () => {
  // Only what this spec owns; foreign rows are removed by their explicit ids.
  await cleanupOwnedRows(db, { userIds: ownedUserIds });
  if (foreignRequestIds.length) await db.delete(aiRequests).where(inArray(aiRequests.id, foreignRequestIds));
  if (foreignTaskIds.length) await db.delete(agentTasks).where(inArray(agentTasks.id, foreignTaskIds));
  await closeDb();
});

describe('AI-01.8 — scheduler-created AI request ownership', () => {
  it('records an AI request owned by the schedule creator when a due schedule runs', async () => {
    const admin = await insertUser('SUPER_ADMIN');
    const schedule = await createAgentSchedule(
      db,
      admin,
      { agentKey: 'marketing-agent', input: { action: 'recommend_campaign' }, intervalMinutes: MIN_SCHEDULE_INTERVAL_MINUTES, isActive: true },
      {},
    );
    await db
      .update(agentSchedules)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(agentSchedules.id, schedule.id));

    const result = await runDueAgentSchedules(db, 'ai018-sweeper', { leaseSeconds: 60 });
    expect(result.created).toBeGreaterThanOrEqual(1);

    // The request the scheduler caused is discoverable by the owner id — the
    // correlation the id-only cleanup could not see.
    const requests = await db.select().from(aiRequests).where(eq(aiRequests.userId, admin));
    const agentRequest = requests.find((r) => r.requestType === 'AGENT:marketing-agent');
    expect(agentRequest).toBeDefined();
    expect(agentRequest!.userId).toBe(admin);
  });

  it('cleanup removes owned rows and never touches rows owned by others', async () => {
    const owner = await insertUser('SUPER_ADMIN');
    const ownedRequestId = randomUUID();
    await db.insert(aiRequests).values({
      id: ownedRequestId,
      userId: owner,
      requestType: 'CHAT',
      model: 'x',
      tokensInput: 0,
      tokensOutput: 0,
      cost: '0',
      currencyCode: 'USD',
      status: 'SUCCESS',
    });

    // Rows owned by "another spec" — must survive this spec's cleanup.
    const foreignUserId = randomUUID();
    const foreignRequestId = randomUUID();
    const foreignTaskId = randomUUID();
    foreignRequestIds.push(foreignRequestId);
    foreignTaskIds.push(foreignTaskId);
    await db.insert(aiRequests).values({
      id: foreignRequestId,
      userId: foreignUserId,
      requestType: 'CHAT',
      model: 'x',
      tokensInput: 0,
      tokensOutput: 0,
      cost: '0',
      currencyCode: 'USD',
      status: 'SUCCESS',
    });
    await db.insert(agentTasks).values({
      id: foreignTaskId,
      agentKey: 'marketing-agent',
      requestedBy: foreignUserId,
      input: {},
      status: 'queued',
    });

    await cleanupOwnedRows(db, { userIds: ownedUserIds });

    // Owned rows removed.
    const ownedLeft = await db.select().from(aiRequests).where(eq(aiRequests.id, ownedRequestId));
    expect(ownedLeft.length).toBe(0);

    // Foreign rows untouched.
    const foreignRequestLeft = await db.select().from(aiRequests).where(eq(aiRequests.id, foreignRequestId));
    expect(foreignRequestLeft.length).toBe(1);
    const foreignTaskLeft = await db.select().from(agentTasks).where(eq(agentTasks.id, foreignTaskId));
    expect(foreignTaskLeft.length).toBe(1);
  });
});
