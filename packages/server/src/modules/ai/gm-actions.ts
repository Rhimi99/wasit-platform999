import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentTasks } from '../../db/schema/agents.js';
import { writeAudit } from '../../lib/audit';
import type { AgentDefinition } from '../../lib/ai/types.js';
import { findAgentSpec } from './catalogue.js';
import { createAgentTask, getRegistryAgent, resolveUserRoles, SUPERVISOR_KEY } from './runner.js';
import { getGmRun, type GmProposedAction, type GmRunRecord } from './orchestrator.js';

/**
 * G4 — executing a GM's proposed follow-up action.
 *
 * The GM orchestrator (AI-05.0) *proposes* follow-up actions with `executed:
 * false`; this module is the missing half — it turns one such proposal into a
 * real Agent Task, behind the human-approval gate, when the General Manager asks
 * for it.
 *
 * It is deliberately NOT a second execution engine. Every task is created by
 * {@link createAgentTask} — the platform's single execution gate — so the run
 * inherits, unchanged:
 *   - the caller's REAL roles (resolved from the database, never the request),
 *   - per-agent RBAC and data scope,
 *   - the kill switch (a PAUSED/DISABLED agent is skipped at run time),
 *   - the human-approval gate (sensitive actions queue as `awaiting_approval`),
 *   - the per-run budget guard and the `AI.*` audit trail.
 *
 * It performs no financial or commercial mutation of its own and never
 * fabricates a `SUPER_ADMIN` principal.
 *
 * Idempotency is delegated to `createAgentTask`'s dedupe key (backed by a
 * partial unique index), so a repeated or concurrent request cannot create a
 * second task — even across processes.
 */

/**
 * The proposed actions that may be turned into an Agent Task.
 *
 * This is an explicit allow-list, not "anything the snapshot happens to
 * contain": a run snapshot is persisted data, and only actions wired to a real
 * executor belong here. Each entry names the agent that owns the action and the
 * concrete `taskType` to run (the action is a follow-up *name*, which need not
 * equal the task type the executor handles).
 *
 * An action present in a snapshot but absent from this map is NOT executable —
 * e.g. `catalog.publish_batch` (the Product Agent has no publish capability) and
 * the generic `gm.retry_failed` / `gm.await_approvals` markers, which carry no
 * agent of their own.
 */
export const GM_ACTION_ROUTES: Record<string, { agentKey: string; taskType: string }> = {
  'ads.spend_increase': { agentKey: 'ads-agent', taskType: 'ads.propose_budget' },
  'risk.block_account': { agentKey: 'risk-agent', taskType: 'risk.scan' },
  'compliance.final_ruling': { agentKey: 'compliance-agent', taskType: 'compliance.check' },
  'outreach.send': { agentKey: 'outreach-acquisition-agent', taskType: 'outreach.run_cycle' },
};

/** Why an action cannot be executed from the desk. */
export type GmActionReason =
  | 'UNKNOWN_ACTION'
  | 'NO_AGENT'
  | 'AGENT_UNAVAILABLE'
  | 'NOT_AUTHORIZED'
  | 'AGENT_STOPPED'
  | 'AGENT_NOT_ACTIVE'
  | 'CONFLICT';

/** The real outcome of an execution request. */
export type GmActionStatus = 'task_created' | 'blocked';

export interface GmActionResult {
  runId: string;
  action: string;
  status: GmActionStatus;
  reason: GmActionReason | null;
  agentKey: string | null;
  taskId: string | null;
  taskStatus: string | null;
  requiresApproval: boolean;
  approvalAction: string | null;
  deduplicated: boolean;
  message: string | null;
}

/** One proposed action of a run, annotated with its current executability. */
export interface GmRunActionView {
  action: string;
  description: string;
  descriptionAr: string;
  agentKey: string | null;
  requiresApproval: boolean;
  executable: boolean;
  reason: GmActionReason | null;
  taskId: string | null;
  taskStatus: string | null;
}

/** The dedupe key that makes `(runId, action)` idempotent. */
export function gmActionDedupeKey(runId: string, action: string): string {
  return `gm-action:${runId}:${action}`;
}

function errMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown error';
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : 'unknown error';
}

/**
 * Whether the owning agent is currently runnable, as a *pre-flight* signal.
 *
 * This only informs the desk's "can I click this?" affordance. It is not the
 * authority: the kill switch is re-checked inside the runner at dispatch time,
 * so a race between this check and the actual run can never let a stopped agent
 * execute.
 */
async function preflight(db: DB, action: string): Promise<{ executable: boolean; reason: GmActionReason | null }> {
  const route = GM_ACTION_ROUTES[action];
  // Every action the view sees comes from the run's own snapshot, so a missing
  // route means "proposed but not wired to an agent" — NO_AGENT, not UNKNOWN.
  if (!route) return { executable: false, reason: 'NO_AGENT' };
  const spec = findAgentSpec(route.agentKey);
  if (!spec || spec.isCopilot || spec.isSupervisor || route.agentKey === SUPERVISOR_KEY) {
    return { executable: false, reason: 'NO_AGENT' };
  }
  try {
    const registry = await getRegistryAgent(db, route.agentKey);
    if (registry.status !== 'ACTIVE') return { executable: false, reason: 'AGENT_NOT_ACTIVE' };
  } catch {
    return { executable: false, reason: 'AGENT_UNAVAILABLE' };
  }
  return { executable: true, reason: null };
}

/**
 * Validates one proposed action against the run's snapshot.
 *
 * Returns the resolved action + agent, or a typed block reason — never by
 * guessing an agent or widening scope. The action must be present in the
 * snapshot's `proposedActions` (the immutable record of what the run actually
 * proposed) AND in the allow-list; its agent must exist, be a runnable executor
 * and be currently ACTIVE (fail-closed on the kill switch).
 */
async function resolveAction(
  db: DB,
  run: GmRunRecord,
  action: string,
): Promise<{ ok: true; action: GmProposedAction; spec: AgentDefinition } | { ok: false; reason: GmActionReason; agentKey: string | null }> {
  const proposed = run.proposedActions.find((a) => a.action === action);
  if (!proposed) return { ok: false, reason: 'UNKNOWN_ACTION', agentKey: null };

  const route = GM_ACTION_ROUTES[action];
  if (!route) return { ok: false, reason: 'NO_AGENT', agentKey: proposed.agentKey };
  if (proposed.agentKey && proposed.agentKey !== route.agentKey) {
    // The snapshot's agent and the allow-list disagree — refuse rather than
    // trust persisted data over the code-level allow-list.
    return { ok: false, reason: 'NO_AGENT', agentKey: proposed.agentKey };
  }
  const spec = findAgentSpec(route.agentKey);
  if (!spec || spec.isCopilot || spec.isSupervisor || route.agentKey === SUPERVISOR_KEY) {
    return { ok: false, reason: 'NO_AGENT', agentKey: route.agentKey };
  }
  let registry;
  try {
    registry = await getRegistryAgent(db, route.agentKey);
  } catch {
    return { ok: false, reason: 'AGENT_UNAVAILABLE', agentKey: route.agentKey };
  }
  if (registry.status !== 'ACTIVE') {
    return { ok: false, reason: 'AGENT_NOT_ACTIVE', agentKey: route.agentKey };
  }
  return { ok: true, action: proposed, spec };
}

/**
 * Turns one proposed action of a completed run into an Agent Task.
 *
 * `actorId` is the authenticated GM (a real user id resolved from the session,
 * never the request body). Ownership is enforced by {@link getGmRun} (which
 * answers `404` for a run the caller may not read); the actor's roles are
 * re-resolved from the database so a stale role snapshot cannot widen what the
 * action may do.
 *
 * The task is created through {@link createAgentTask}, so a sensitive action
 * lands in `awaiting_approval` and is never auto-executed. The result reports
 * the real outcome — `task_created` (with the task's real status) or `blocked`
 * (with the reason) — and every attempt is audited.
 */
export async function executeGmAction(
  db: DB,
  correlationId: string,
  action: string,
  actor: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<GmActionResult> {
  const run = await getGmRun(db, correlationId, actor.actorId);
  const auditCtx = { actorId: actor.actorId, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
  // `audit_logs.entity_id` is varchar(36); a run+action pair is longer, so the
  // run id (36 chars) is the entity id and the action is carried in `metadata`.
  const entityId = correlationId;

  await writeAudit(db, auditCtx, {
    action: 'AI.GM_ACTION_REQUESTED',
    entityType: 'GM_ACTION',
    entityId,
    metadata: { runId: correlationId, action, proposedBy: run.requestedBy },
  });

  const block = async (reason: GmActionReason, agentKey: string | null, message: string | null): Promise<GmActionResult> => {
    await writeAudit(db, auditCtx, {
      action: 'AI.GM_ACTION_BLOCKED',
      entityType: 'GM_ACTION',
      entityId,
      metadata: { runId: correlationId, action, agentKey, reason, message },
    });
    return {
      runId: correlationId, action, status: 'blocked', reason, agentKey,
      taskId: null, taskStatus: null, requiresApproval: false, approvalAction: null,
      deduplicated: false, message,
    };
  };

  const resolved = await resolveAction(db, run, action);
  if (!resolved.ok) return block(resolved.reason, resolved.agentKey, null);
  const { action: proposed, spec } = resolved;

  const roles: UserRole[] = await resolveUserRoles(db, actor.actorId);
  const dedupeKey = gmActionDedupeKey(correlationId, action);
  // Advisory only: lets the response report whether this call reused an existing
  // open task. The authoritative uniqueness is the partial index inside
  // createAgentTask, so a concurrent double-submit still yields exactly one task.
  const existing = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.requestedBy, actor.actorId), eq(agentTasks.dedupeKey, dedupeKey), sql`${agentTasks.status} not in ('succeeded', 'failed', 'rejected', 'blocked')`))
    .limit(1);

  let task;
  try {
    task = await createAgentTask(
      db,
      roles,
      actor.actorId,
      {
        agentKey: spec.key,
        taskType: GM_ACTION_ROUTES[action]!.taskType,
        input: { gmRunId: correlationId, gmAction: action },
        correlationId,
        // `triggered_by` is varchar(64) and a run+action pair can exceed it, so
        // it carries the coarse trigger label while the full identity lives in
        // the dedupe key (varchar(200)) and in `input`.
        triggeredBy: 'gm-action',
        dedupeKey,
        priority: 60,
      },
      auditCtx,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const reason: GmActionReason = err.code === 'CONFLICT' ? 'CONFLICT' : err.code === 'NOT_FOUND' ? 'AGENT_UNAVAILABLE' : 'NOT_AUTHORIZED';
      return block(reason, spec.key, errMessage(err));
    }
    // An unexpected failure: audit it honestly, then surface it. Never report a
    // success we cannot back with a created task.
    await writeAudit(db, auditCtx, {
      action: 'AI.GM_ACTION_BLOCKED',
      entityType: 'GM_ACTION',
      entityId,
      metadata: { runId: correlationId, action, agentKey: spec.key, reason: 'ERROR', message: errMessage(err) },
    });
    throw err;
  }

  // The advisory pre-read tells us whether the task we got back is a row we
  // adopted rather than inserted; the id comparison rules out a different owner's
  // task. This never gates correctness — only the `deduplicated` flag.
  const deduplicated = existing.length > 0 && existing[0]!.id === task.id;
  await writeAudit(db, auditCtx, {
    action: 'AI.GM_ACTION_EXECUTED',
    entityType: 'GM_ACTION',
    entityId,
    metadata: {
      runId: correlationId, action, agentKey: spec.key, taskId: task.id,
      taskStatus: task.status, requiresApproval: task.requiresApproval, deduplicated,
    },
  });

  return {
    runId: correlationId,
    action,
    status: 'task_created',
    reason: null,
    agentKey: spec.key,
    taskId: task.id,
    taskStatus: task.status,
    requiresApproval: task.requiresApproval,
    approvalAction: task.approvalAction,
    deduplicated,
    message: proposed.description,
  };
}

/**
 * The proposed actions of a run, annotated for the desk UI.
 *
 * Read-only and never writes. `taskId`/`taskStatus` reflect a task already
 * created for `(runId, action)` (an open one, or the most recent terminal one),
 * so the desk shows the real lifecycle — not a guess.
 */
export async function listGmRunActions(
  db: DB,
  correlationId: string,
  actorId: string,
): Promise<GmRunActionView[]> {
  const run = await getGmRun(db, correlationId, actorId);

  const keys = run.proposedActions.map((a) => gmActionDedupeKey(correlationId, a.action));
  const rows = keys.length
    ? await db
        .select({ id: agentTasks.id, dedupeKey: agentTasks.dedupeKey, status: agentTasks.status, createdAt: agentTasks.createdAt })
        .from(agentTasks)
        .where(and(eq(agentTasks.requestedBy, actorId), inArray(agentTasks.dedupeKey, keys)))
        .orderBy(agentTasks.createdAt)
    : [];

  const byKey = new Map<string, { id: string; status: string }>();
  for (const r of rows) {
    if (r.dedupeKey) byKey.set(r.dedupeKey, { id: r.id, status: r.status });
  }

  return Promise.all(
    run.proposedActions.map(async (a): Promise<GmRunActionView> => {
      const pf = await preflight(db, a.action);
      const task = byKey.get(gmActionDedupeKey(correlationId, a.action));
      return {
        action: a.action,
        description: a.description,
        descriptionAr: a.descriptionAr,
        agentKey: a.agentKey,
        requiresApproval: a.requiresApproval,
        executable: pf.executable,
        reason: pf.reason,
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? null,
      };
    }),
  );
}
