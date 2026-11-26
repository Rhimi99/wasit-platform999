import { eq, inArray } from 'drizzle-orm';
import { ApiError, ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRuns, agentRunSteps } from '../../db/schema/agent_runs';
import { agentRegistry } from '../../db/schema/agents';
import { users, userRoles, roles } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { isBudgetExhausted } from '../../lib/ai/cost-control';
import { assertAiExecutionEnabled } from '../../lib/ai/kill-switch';
import { env } from '../../lib/env';
import { assertValidDependencies, type StepDependency } from './run-state-machine.js';
import { agentRunRefusal, findAgentSpec } from './catalogue.js';

/**
 * AI-02.2 — Planning & Dependency Resolution.
 *
 * Turns a General-Manager goal plus a set of proposed steps into a persisted,
 * validated orchestration plan: one `agent_runs` row in `PLANNING` status and one
 * `agent_run_steps` row per step, ordered by a deterministic topological sort.
 *
 * This layer is PLANNING ONLY. It never executes an agent, never calls an
 * executor, and never advances the run past `PLANNING` — dispatching and running
 * are later phases (AI-02.3+). Creating a plan is deliberately NOT an approval to
 * execute it: steps that need human approval are recorded as such and left in
 * `PENDING`, awaiting a separate decision.
 *
 * There is no LLM "goal understanding" here. The caller supplies the steps; the
 * service validates and orders them. If a goal were to be decomposed
 * automatically, that would be a future, explicitly-provided planner — this code
 * does not pretend to have one.
 */

/** Hard ceiling on a single plan. A runaway planner must not flood the DB. */
export const MAX_PLAN_STEPS = 25;
/** A goal title is a short label, not a document. */
export const MAX_TITLE_LENGTH = 300;
export const MAX_STEP_KEY_LENGTH = 64;
/** Bound on the serialised per-step input, so a plan cannot smuggle a payload. */
export const MAX_INPUT_BYTES = 16_384;

/** A step proposed by the caller, before validation. */
export interface ProposedStep {
  stepKey: string;
  agentKey: string;
  input: Record<string, unknown>;
  priority?: number;
  dependsOn?: string[];
}

/** The caller's planning request. */
export interface PlanAgentRunInput {
  runKey?: string;
  title: string;
  description?: string | null;
  steps: ProposedStep[];
}

/** The persisted plan returned to the caller. */
export interface PersistedPlan {
  runId: string;
  runKey: string;
  status: string;
  steps: Array<{
    id: string;
    stepKey: string;
    agentKey: string;
    status: string;
    priority: number;
    dependsOn: string[];
    requiresApproval: boolean;
    executionOrder: number;
  }>;
}

/** A step after validation, carrying everything needed to persist it. */
export interface ValidatedStep {
  stepKey: string;
  agentKey: string;
  input: Record<string, unknown>;
  priority: number;
  dependsOn: string[];
  requiresApproval: boolean;
  /** Deterministic position in the execution order (0-based). */
  executionOrder: number;
}

function validationError(field: string, message: string, code: string): ApiError {
  return ApiError.validation([{ field, message, code }]);
}

/**
 * Deterministic topological sort. A step becomes ready only once all its
 * dependencies are ordered. Among ready steps, higher `priority` wins; ties are
 * broken by `stepKey` so the SAME input always yields the SAME order. Priority
 * never overrides a dependency: a high-priority step still waits for its deps.
 *
 * Assumes `steps` is non-empty and `assertValidDependencies` has already passed
 * (no unknown deps, no self-deps, no cycles, no duplicate keys).
 */
export function topologicalOrder(
  steps: Array<{ stepKey: string; dependsOn: string[]; priority: number }>,
): string[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const remaining = new Map(steps.map((s) => [s.stepKey, s.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const s of steps) dependents.set(s.stepKey, []);
  for (const s of steps) {
    for (const dep of s.dependsOn) dependents.get(dep)!.push(s.stepKey);
  }

  const ready = steps
    .filter((s) => remaining.get(s.stepKey) === 0)
    .map((s) => s.stepKey);
  const order: string[] = [];

  while (ready.length > 0) {
    // Pick the highest priority; break ties by key for reproducibility.
    ready.sort((a, b) => {
      const pa = byKey.get(a)!.priority;
      const pb = byKey.get(b)!.priority;
      if (pa !== pb) return pb - pa;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const next = ready.shift()!;
    order.push(next);
    for (const dependent of dependents.get(next)!) {
      const left = remaining.get(dependent)! - 1;
      remaining.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }

  // A complete topological order visits every node; anything left means a cycle.
  if (order.length !== steps.length) {
    throw validationError('dependsOn', 'Dependency cycle detected among steps', 'CYCLE');
  }
  return order;
}

/**
 * Validates a proposed plan against the live agent registry and RBAC, without
 * touching the database beyond reading the registry and the requester's roles.
 *
 * Rejects: unknown/inactive agents, missing/duplicate/invalid step keys, missing
 * inputs, invalid priorities, unknown/self/cyclic dependencies, over-limit plans,
 * and steps whose required permissions the requester lacks.
 *
 * Dependencies are re-checked on EVERY call — a previously valid plan is not
 * trusted.
 */
export async function validatePlan(
  db: DB,
  requesterId: string,
  steps: ProposedStep[],
): Promise<ValidatedStep[]> {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw validationError('steps', 'A plan must contain at least one step', 'REQUIRED');
  }
  if (steps.length > MAX_PLAN_STEPS) {
    throw validationError(
      'steps',
      `A plan may not exceed ${MAX_PLAN_STEPS} steps (got ${steps.length})`,
      'MAX_STEPS_EXCEEDED',
    );
  }

  // 1. Structural validation of each step, collecting keys for the graph check.
  const seen = new Set<string>();
  for (const step of steps) {
    if (typeof step.stepKey !== 'string' || step.stepKey.trim() === '') {
      throw validationError('stepKey', 'Every step needs a non-empty stepKey', 'REQUIRED');
    }
    if (step.stepKey.length > MAX_STEP_KEY_LENGTH) {
      throw validationError('stepKey', `stepKey must be <= ${MAX_STEP_KEY_LENGTH} chars`, 'TOO_LONG');
    }
    if (seen.has(step.stepKey)) {
      throw validationError('stepKey', `Duplicate stepKey "${step.stepKey}"`, 'DUPLICATE');
    }
    seen.add(step.stepKey);

    if (typeof step.agentKey !== 'string' || step.agentKey.trim() === '') {
      throw validationError('agentKey', `Step "${step.stepKey}" needs an agentKey`, 'REQUIRED');
    }
    if (step.input === null || typeof step.input !== 'object' || Array.isArray(step.input)) {
      throw validationError('input', `Step "${step.stepKey}" needs an object input`, 'INVALID');
    }
    if (JSON.stringify(step.input).length > MAX_INPUT_BYTES) {
      throw validationError('input', `Step "${step.stepKey}" input is too large`, 'TOO_LARGE');
    }
    const priority = step.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0) {
      throw validationError('priority', `Step "${step.stepKey}" priority must be a non-negative integer`, 'INVALID');
    }
    if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
      throw validationError('dependsOn', `Step "${step.stepKey}" dependsOn must be an array`, 'INVALID');
    }
    const deps = step.dependsOn ?? [];
    if (new Set(deps).size !== deps.length) {
      throw validationError('dependsOn', `Step "${step.stepKey}" has duplicate dependencies`, 'DUPLICATE_DEPENDENCY');
    }
  }

  // 2. Dependency graph: unknown refs, self-deps and cycles — reusing the
  //    AI-02.1 helper so there is one dependency contract, not two.
  const graph: StepDependency[] = steps.map((s) => ({ stepKey: s.stepKey, dependsOn: s.dependsOn ?? [] }));
  assertValidDependencies(graph);

  // 3. Agents must exist in the live registry, be active, AND be runnable.
  //    Runnability is a code property (`executable`), so a plan can never queue a
  //    step for the Copilot, the Supervisor, or a declared-only agent that has no
  //    executor — the refusal happens here, before any run or step row is written,
  //    instead of surfacing later at dispatch time.
  const agentKeys = [...new Set(steps.map((s) => s.agentKey))];
  const registryRows = await db
    .select()
    .from(agentRegistry)
    .where(inArray(agentRegistry.key, agentKeys));
  const registry = new Map(registryRows.map((r) => [r.key, r]));
  for (const step of steps) {
    const agent = registry.get(step.agentKey);
    if (!agent) {
      throw validationError('agentKey', `Step "${step.stepKey}" references unknown agent "${step.agentKey}"`, 'UNKNOWN_AGENT');
    }
    if (!agent.isActive) {
      throw validationError('agentKey', `Agent "${step.agentKey}" is not active`, 'INACTIVE_AGENT');
    }
    const refusal = agentRunRefusal(findAgentSpec(step.agentKey));
    if (refusal) {
      throw validationError(
        'agentKey',
        `Step "${step.stepKey}" cannot target "${step.agentKey}": ${refusal.message}`,
        refusal.code,
      );
    }
  }

  // 4. The requester must hold every permission each chosen agent requires. A
  //    plan can never grant a capability its author does not have.
  const requesterRoles = await rolesOf(db, requesterId);
  const isAdmin = requesterRoles.includes('ADMIN') || requesterRoles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    for (const step of steps) {
      const required = (registry.get(step.agentKey)!.permissionsRequired ?? []) as string[];
      const missing = required.filter((p) => !hasPermission(requesterRoles, p));
      if (missing.length > 0) {
        throw ApiError.forbidden(
          `Step "${step.stepKey}" requires permission(s) you do not hold: ${missing.join(', ')}`,
        );
      }
    }
  }

  // 5. Deterministic execution order.
  const order = topologicalOrder(
    steps.map((s) => ({ stepKey: s.stepKey, dependsOn: s.dependsOn ?? [], priority: s.priority ?? 0 })),
  );
  const orderIndex = new Map(order.map((key, i) => [key, i]));

  return steps.map((s) => ({
    stepKey: s.stepKey,
    agentKey: s.agentKey,
    input: s.input,
    priority: s.priority ?? 0,
    dependsOn: s.dependsOn ?? [],
    // A sensitive agent always carries its approval requirement into the plan.
    requiresApproval: registry.get(s.agentKey)!.requiresHumanApproval,
    executionOrder: orderIndex.get(s.stepKey)!,
  }));
}

async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleName as UserRole);
}

function hasPermission(userRoleList: UserRole[], permission: string): boolean {
  return userRoleList.some((r) => ROLE_PERMISSIONS[r]?.has(permission as never));
}

/**
 * Plans and persists an agent run.
 *
 * Preconditions, all fail-closed:
 * - the requester exists (an unknown `requestedBy` is rejected);
 * - the plan passes `validatePlan` (agents, keys, deps, permissions, limits);
 * - the requester's AI budget is not already exhausted (a plan is work that will
 *   later consume budget, so we refuse to open one with no headroom).
 *
 * The run is written in `PLANNING` status and is NEVER advanced here. Creating a
 * plan is not an approval and does not dispatch anything.
 */
export async function planAgentRun(
  db: DB,
  requesterId: string,
  input: PlanAgentRunInput,
  audit: AuditContext,
): Promise<PersistedPlan> {
  // Central AI Kill Switch (A1): planning creates a new run, so a global disable
  // refuses it up front — no run or step row is written while disabled.
  await assertAiExecutionEnabled(db);
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw validationError('title', 'A run needs a title', 'REQUIRED');
  }
  if (input.title.length > MAX_TITLE_LENGTH) {
    throw validationError('title', `Title must be <= ${MAX_TITLE_LENGTH} chars`, 'TOO_LONG');
  }

  const requesterRows = await db.select({ id: users.id }).from(users).where(eq(users.id, requesterId)).limit(1);
  if (requesterRows.length === 0) {
    throw validationError('requestedBy', 'Requester does not exist', 'UNKNOWN_REQUESTER');
  }

  const validated = await validatePlan(db, requesterId, input.steps);

  const requesterRoles = await rolesOf(db, requesterId);
  const budget = await isBudgetExhausted(db, requesterId, requesterRoles, 'MONTHLY', env.AI_BUDGET_MONTHLY_USD);
  if (budget.exhausted) {
    throw ApiError.tooManyRequests(`AI budget exhausted (${budget.reason ?? 'budget'}); cannot plan a new run`);
  }

  const runId = newId();
  const runKey = input.runKey && input.runKey.trim() !== '' ? input.runKey : newId();

  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.runKey, runKey)).limit(1);
    if (existing.length > 0) {
      throw ApiError.conflict(`A run with key "${runKey}" already exists`);
    }

    await tx.insert(agentRuns).values({
      id: runId,
      runKey,
      title: input.title,
      description: input.description ?? null,
      status: 'PLANNING',
      requestedBy: requesterId,
      metadata: { plannedSteps: validated.length },
    });

    await tx.insert(agentRunSteps).values(
      validated.map((s) => ({
        id: newId(),
        runId,
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        status: 'PENDING' as const,
        input: s.input as never,
        priority: s.priority,
        dependsOn: s.dependsOn as never,
        requiresApproval: s.requiresApproval,
        maxAttempts: 1,
      })),
    );
  });

  await writeAudit(db, audit, {
    action: 'AI.AGENT_RUN_PLANNED',
    entityType: 'AGENT_RUN',
    entityId: runId,
    metadata: { runKey, steps: validated.length },
  });

  const persisted = await loadPlan(db, runId);
  return persisted;
}

/**
 * Reads a persisted plan back and re-verifies it: every step belongs to the run,
 * every agent still exists, and the dependency graph is still acyclic. A stored
 * plan is not trusted just because it was written.
 */
export async function loadPlan(db: DB, runId: string): Promise<PersistedPlan> {
  const runRows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (runRows.length === 0) throw ApiError.notFound('Agent run');
  const run = runRows[0];

  const stepRows = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
  const steps = stepRows.map((r) => ({
    id: r.id,
    stepKey: r.stepKey,
    agentKey: r.agentKey,
    status: r.status as string,
    priority: r.priority,
    dependsOn: (r.dependsOn ?? []) as string[],
    requiresApproval: r.requiresApproval,
  }));

  // Re-verify the graph on read; a corrupted plan must not look valid.
  assertValidDependencies(steps.map((s) => ({ stepKey: s.stepKey, dependsOn: s.dependsOn })));

  const agentKeys = [...new Set(steps.map((s) => s.agentKey))];
  if (agentKeys.length > 0) {
    const registryRows = await db
      .select({ key: agentRegistry.key })
      .from(agentRegistry)
      .where(inArray(agentRegistry.key, agentKeys));
    const known = new Set(registryRows.map((r) => r.key));
    for (const s of steps) {
      if (!known.has(s.agentKey)) {
        throw validationError('agentKey', `Stored step "${s.stepKey}" references unknown agent "${s.agentKey}"`, 'UNKNOWN_AGENT');
      }
    }
  }

  const order = topologicalOrder(steps.map((s) => ({ stepKey: s.stepKey, dependsOn: s.dependsOn, priority: s.priority })));
  const orderIndex = new Map(order.map((key, i) => [key, i]));

  return {
    runId: run.id,
    runKey: run.runKey,
    status: run.status,
    steps: steps
      .map((s) => ({ ...s, executionOrder: orderIndex.get(s.stepKey)! }))
      .sort((a, b) => a.executionOrder - b.executionOrder),
  };
}
