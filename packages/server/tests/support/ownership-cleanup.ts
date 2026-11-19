import { inArray } from 'drizzle-orm';
import type { DB } from '../../src/db/client.js';
import { agentTasks, agentRegistry } from '../../src/db/schema/agents.js';
import { aiRequests, aiUsage, aiBudgets } from '../../src/db/schema/ai.js';
import { agentSchedules } from '../../src/db/schema/agent_schedules.js';
import { users, userRoles } from '../../src/db/schema/auth.js';
import { products, categories } from '../../src/db/schema/products.js';
import { agentRuns, agentRunSteps } from '../../src/db/schema/agent_runs.js';

/**
 * Ownership-scoped teardown for AI integration specs.
 *
 * Every AI spec mints its own users and the rows those users cause — directly,
 * through the scheduler, or through agent-task execution. Those rows are owned
 * by the spec's user ids, which is the only correlation key the schema actually
 * provides (`agent_tasks.requested_by`, `ai_requests.user_id`,
 * `ai_usage.user_id`, `agent_schedules.created_by`, `products.seller_id`).
 *
 * This helper deletes *only* rows reachable from the caller's own ids. It never
 * issues an unqualified `DELETE`, so a spec can never remove another spec's
 * fixtures or any pre-existing data — which is what makes the suite safe under
 * parallel file execution.
 *
 * `agent_runs`/`agent_run_steps` have no user column, so they are removed by the
 * explicit run ids the caller tracked (steps cascade from runs).
 */
export interface OwnedRows {
  /** User ids the spec created. Their dependent rows are removed by owner id. */
  userIds?: string[];
  /** Explicit task ids (covers tasks whose requester is not a spec-owned user). */
  taskIds?: string[];
  /** Explicit run ids (steps cascade from runs). */
  runIds?: string[];
  /** Explicit schedule ids. */
  scheduleIds?: string[];
  /** Explicit budget ids. */
  budgetIds?: string[];
  /** Explicit registry keys inserted by the spec. */
  registryKeys?: string[];
  /** Explicit product ids (products have no user cascade we rely on). */
  productIds?: string[];
  /** Explicit category ids. */
  categoryIds?: string[];
}

function has(list?: string[]): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

/**
 * Removes every row owned by `rows`, in dependency order, scoped strictly by the
 * supplied ids/owners. Idempotent and safe to call when nothing was created.
 */
export async function cleanupOwnedRows(db: DB, rows: OwnedRows): Promise<void> {
  const { userIds, taskIds, runIds, scheduleIds, budgetIds, registryKeys, productIds, categoryIds } = rows;

  // Run steps → runs (FK cascade, but delete explicitly to keep intent clear).
  if (has(runIds)) {
    await db.delete(agentRunSteps).where(inArray(agentRunSteps.runId, runIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  if (has(taskIds)) {
    await db.delete(agentTasks).where(inArray(agentTasks.id, taskIds));
  }
  if (has(userIds)) {
    // Every row the spec's users caused, whether direct, scheduled or executed.
    await db.delete(agentTasks).where(inArray(agentTasks.requestedBy, userIds));
    await db.delete(aiRequests).where(inArray(aiRequests.userId, userIds));
    await db.delete(aiUsage).where(inArray(aiUsage.userId, userIds));
    await db.delete(agentSchedules).where(inArray(agentSchedules.createdBy, userIds));
    await db.delete(aiBudgets).where(inArray(aiBudgets.userId, userIds));
    await db.delete(products).where(inArray(products.sellerId, userIds));
  }
  if (has(scheduleIds)) {
    await db.delete(agentSchedules).where(inArray(agentSchedules.id, scheduleIds));
  }
  if (has(budgetIds)) {
    await db.delete(aiBudgets).where(inArray(aiBudgets.id, budgetIds));
  }
  if (has(productIds)) {
    await db.delete(products).where(inArray(products.id, productIds));
  }
  if (has(categoryIds)) {
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
  if (has(registryKeys)) {
    await db.delete(agentRegistry).where(inArray(agentRegistry.key, registryKeys));
  }
  // Users last: user_roles then the user itself.
  if (has(userIds)) {
    await db.delete(userRoles).where(inArray(userRoles.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}
