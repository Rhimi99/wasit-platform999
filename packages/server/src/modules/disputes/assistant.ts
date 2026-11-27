/**
 * AI-03 — automatic `dispute-assistant` task on dispute assignment.
 *
 * The rule this module implements is narrow and deliberate:
 *
 *  - Opening a dispute records an assistance REQUEST and creates nothing. There
 *    is no reviewer yet, and `agent_tasks.requested_by` is NOT NULL — inventing
 *    an owner (the opener, an admin, a "system" user) would attribute an agent
 *    run to someone who did not ask for it.
 *  - Assigning a *qualified* reviewer creates exactly one task, owned by that
 *    reviewer. The reviewer is the owner because they are the human who will use
 *    the summary; the agent's cost, metrics and audit trail are attributed to a
 *    real person's scope.
 *  - Reassignment starts a new assignment cycle: the new reviewer gets a fresh
 *    task, and any task still waiting for approval from the previous cycle is
 *    superseded so it can never run under the old reviewer's authority.
 *  - Every step is audited, and no step is allowed to break the dispute itself:
 *    a failure here is recorded and surfaced, never rethrown into the caller.
 *
 * The agent stays advisory: nothing in this module decides, changes a status,
 * moves money or grants a permission. The task it creates is gated by the
 * catalogue's `requiresHumanApproval`, so a second authorised approver still has
 * to release the run (separation of duties, AI-02.P0).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { PERMISSIONS, ROLE_PERMISSIONS, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentTasks } from '../../db/schema/agents';
import { disputes } from '../../db/schema/disputes';
import { roles, userRoles, users } from '../../db/schema/auth';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { logger } from '../../lib/observability/logger';
import { PLATFORM_SCOPE_ROLES } from '../ai/catalogue.js';

export const DISPUTE_ASSISTANT_AGENT_KEY = 'dispute-assistant';

/** Where the request came from. Stored in the audit trail, never in the task. */
export type DisputeAssistTrigger = 'DISPUTE_OPENED' | 'REVIEWER_ASSIGNED' | 'MANUAL_RETRY';

/**
 * - `CLOSED_CASE`: the dispute is terminal; no assistance is requested.
 * - `PENDING_NO_REVIEWER`: requested, waiting for a human reviewer.
 * - `PENDING_REVIEWER_NOT_QUALIFIED`: a reviewer is assigned but cannot run this
 *   agent (not platform-scope, or missing `dispute:read`); nothing was created.
 * - `PENDING_TASK`: a qualified reviewer is assigned and no task exists yet.
 * - `TASK_CREATED` / `TASK_EXISTS`: a task exists for the current cycle.
 * - `TASK_FAILED`: the attempt failed; the dispute is untouched and a retry is safe.
 */
export type DisputeAssistantState =
  | 'CLOSED_CASE'
  | 'PENDING_NO_REVIEWER'
  | 'PENDING_REVIEWER_NOT_QUALIFIED'
  | 'PENDING_TASK'
  | 'TASK_CREATED'
  | 'TASK_EXISTS'
  | 'TASK_FAILED';

export interface DisputeAssistantSummaryView {
  disputeNumber: string | null;
  status: string | null;
  recommendation: { action: string; confidence: number; rationale: string } | null;
  gaps: string[];
  evidenceCount: number | null;
  messages: number | null;
  deadlines: Record<string, unknown> | null;
}

export interface DisputeAssistantTaskView {
  id: string;
  status: string;
  requestedBy: string;
  reviewerEmail: string | null;
  createdAt: string;
  completedAt: string | null;
  requiresApproval: boolean;
  summary: DisputeAssistantSummaryView | null;
  error: string | null;
}

export interface DisputeAssistantView {
  disputeId: string;
  state: DisputeAssistantState;
  reason: string | null;
  assignmentCycle: string | null;
  reviewer: { id: string; email: string | null; qualified: boolean; qualificationReason: string | null } | null;
  task: DisputeAssistantTaskView | null;
  supersededTaskCount: number;
}

export interface DisputeAssistResult {
  disputeId: string;
  state: DisputeAssistantState;
  reason: string | null;
  taskId: string | null;
  assignmentCycle: string | null;
}

const TERMINAL_DISPUTE_STATUSES = new Set(['DECIDED', 'CLOSED', 'ARCHIVED']);

/**
 * Assignment cycle identity. `assigned_at` is rewritten on every assignment, so
 * `reviewer@timestamp` names exactly one reviewer/assignment pair: a duplicate
 * event for the same assignment maps to the same cycle, and a reassignment (even
 * back to the same person) maps to a new one.
 */
export function assignmentCycleOf(assignedToId: string | null, assignedAt: Date | null): string | null {
  if (!assignedToId) return null;
  return `${assignedToId}@${assignedAt ? assignedAt.getTime() : 0}`;
}

export function disputeAssistDedupeKey(disputeId: string, cycle: string): string {
  return `dispute-assist:${disputeId}:${cycle}`;
}

interface Qualification {
  qualified: boolean;
  reason: string | null;
  roles: UserRole[];
  email: string | null;
  active: boolean;
}

/**
 * A reviewer may own an agent task only if they could have run the agent
 * themselves: the agent declares `requiresPlatformScope` (ADMIN/SUPER_ADMIN) and
 * `dispute:read`. Checking the declared requirements here — instead of assuming
 * the assigner checked — is what keeps an assignment from silently becoming a
 * privilege grant.
 */
async function qualifyReviewer(db: DB, userId: string): Promise<Qualification> {
  const [row] = await db
    .select({ email: users.email, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const roleRows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  const userRoleNames = roleRows.map((r) => r.name as UserRole);

  if (!row) return { qualified: false, reason: 'REVIEWER_NOT_FOUND', roles: [], email: null, active: false };
  if (!row.isActive) return { qualified: false, reason: 'REVIEWER_INACTIVE', roles: userRoleNames, email: row.email, active: false };
  if (!userRoleNames.some((r) => PLATFORM_SCOPE_ROLES.includes(r))) {
    return { qualified: false, reason: 'REVIEWER_NOT_PLATFORM_SCOPE', roles: userRoleNames, email: row.email, active: true };
  }
  const hasDisputeRead = userRoleNames.some((r) =>
    (ROLE_PERMISSIONS[r] as ReadonlySet<string> | undefined)?.has(PERMISSIONS.DISPUTE_READ),
  );
  if (!hasDisputeRead) {
    return { qualified: false, reason: 'REVIEWER_MISSING_DISPUTE_READ', roles: userRoleNames, email: row.email, active: true };
  }
  return { qualified: true, reason: null, roles: userRoleNames, email: row.email, active: true };
}

function auditCtxFor(trigger: DisputeAssistTrigger, actorId: string | null, ctx?: { ipAddress?: string | null; userAgent?: string | null }): AuditContext {
  // Creation is performed by the platform automation, so the row is attributed
  // to SYSTEM; the human who triggered it is recorded in `metadata.triggeredBy`.
  // Attributing the insert to the human would claim they created a task for
  // themselves that they did not request.
  return {
    actorId: trigger === 'MANUAL_RETRY' ? actorId : null,
    actorType: trigger === 'MANUAL_RETRY' ? 'USER' : 'SYSTEM',
    ipAddress: ctx?.ipAddress ?? null,
    userAgent: ctx?.userAgent ?? null,
  };
}

async function loadDispute(db: DB, disputeId: string) {
  const [row] = await db
    .select({
      id: disputes.id,
      disputeNumber: disputes.disputeNumber,
      status: disputes.status,
      assignedToId: disputes.assignedToId,
      assignedAt: disputes.assignedAt,
    })
    .from(disputes)
    .where(eq(disputes.id, disputeId))
    .limit(1);
  return row ?? null;
}

async function findCycleTask(db: DB, disputeId: string, cycle: string) {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(
      sql`${agentTasks.agentKey} = ${DISPUTE_ASSISTANT_AGENT_KEY}
          and ${agentTasks.input}->>'__disputeId' = ${disputeId}
          and ${agentTasks.input}->>'__disputeCycle' = ${cycle}`,
    )
    .orderBy(desc(agentTasks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

function readSummary(result: unknown): DisputeAssistantSummaryView | null {
  if (!result || typeof result !== 'object') return null;
  const advice = (result as { advice?: unknown }).advice;
  if (typeof advice !== 'string') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(advice) as Record<string, unknown>;
  } catch {
    return null;
  }
  const dispute = parsed.dispute as Record<string, unknown> | undefined;
  const recommendation = parsed.recommendation as Record<string, unknown> | undefined;
  const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];
  const evidence = parsed.evidence as Record<string, unknown> | undefined;
  const conversation = parsed.conversation as Record<string, unknown> | undefined;
  return {
    disputeNumber: typeof dispute?.disputeNumber === 'string' ? dispute.disputeNumber : null,
    status: typeof dispute?.status === 'string' ? dispute.status : null,
    recommendation:
      recommendation && typeof recommendation.action === 'string'
        ? {
            action: recommendation.action,
            confidence: typeof recommendation.confidence === 'number' ? recommendation.confidence : 0,
            rationale: typeof recommendation.rationale === 'string' ? recommendation.rationale : '',
          }
        : null,
    gaps: gaps
      .map((g) => (g && typeof g === 'object' ? (g as Record<string, unknown>).code : null))
      .filter((c): c is string => typeof c === 'string'),
    evidenceCount: typeof evidence?.count === 'number' ? evidence.count : null,
    messages: typeof conversation?.messages === 'number' ? conversation.messages : null,
    deadlines: (parsed.deadlines as Record<string, unknown> | undefined) ?? null,
  };
}

function toTaskView(row: typeof agentTasks.$inferSelect, reviewerEmail: string | null): DisputeAssistantTaskView {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requestedBy,
    reviewerEmail,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    requiresApproval: row.requiresApproval,
    summary: readSummary(row.result),
    error: row.error && typeof row.error === 'object' ? String((row.error as { message?: unknown }).message ?? '') || null : null,
  };
}

/**
 * Read-only view of the assistance state for one dispute. Used by the admin UI;
 * it never writes and never creates a task.
 */
export async function readDisputeAssistant(db: DB, disputeId: string): Promise<DisputeAssistantView> {
  const dispute = await loadDispute(db, disputeId);
  if (!dispute) {
    return {
      disputeId,
      state: 'PENDING_TASK',
      reason: 'DISPUTE_NOT_FOUND',
      assignmentCycle: null,
      reviewer: null,
      task: null,
      supersededTaskCount: 0,
    };
  }

  const cycle = assignmentCycleOf(dispute.assignedToId, dispute.assignedAt);
  const supersededRows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      sql`${agentTasks.agentKey} = ${DISPUTE_ASSISTANT_AGENT_KEY}
          and ${agentTasks.input}->>'__disputeId' = ${disputeId}
          and ${agentTasks.status} = 'rejected'
          and coalesce(${agentTasks.rejectionReason}, '') like 'Superseded:%'`,
    );
  const base = { disputeId, assignmentCycle: cycle, supersededTaskCount: supersededRows.length };

  if (TERMINAL_DISPUTE_STATUSES.has(dispute.status)) {
    const task = cycle ? await findCycleTask(db, disputeId, cycle) : null;
    const reviewer = dispute.assignedToId ? await qualifyReviewer(db, dispute.assignedToId) : null;
    return {
      ...base,
      state: 'CLOSED_CASE',
      reason: `DISPUTE_${dispute.status}`,
      reviewer: reviewer
        ? { id: dispute.assignedToId!, email: reviewer.email, qualified: reviewer.qualified, qualificationReason: reviewer.reason }
        : null,
      task: task ? toTaskView(task, reviewer?.email ?? null) : null,
    };
  }

  if (!dispute.assignedToId || !cycle) {
    return { ...base, state: 'PENDING_NO_REVIEWER', reason: 'NO_REVIEWER', reviewer: null, task: null };
  }

  const qualification = await qualifyReviewer(db, dispute.assignedToId);
  const reviewer = {
    id: dispute.assignedToId,
    email: qualification.email,
    qualified: qualification.qualified,
    qualificationReason: qualification.reason,
  };
  if (!qualification.qualified) {
    return { ...base, state: 'PENDING_REVIEWER_NOT_QUALIFIED', reason: qualification.reason, reviewer, task: null };
  }

  const task = await findCycleTask(db, disputeId, cycle);
  return {
    ...base,
    state: task ? 'TASK_EXISTS' : 'PENDING_TASK',
    reason: task ? null : 'TASK_NOT_CREATED',
    reviewer,
    task: task ? toTaskView(task, qualification.email) : null,
  };
}

/**
 * Record the request and, when a qualified reviewer is assigned, create the
 * task. Idempotent per assignment cycle and safe to retry: the insert is guarded
 * by a row lock on the dispute, an any-status lookup of the cycle's task, and the
 * `agent_tasks_dedupe_open_uidx` partial unique index on (owner, dedupe key).
 *
 * Never throws for a domain reason — the caller is the dispute flow, which must
 * not fail because an assistant could not be scheduled.
 */
export async function requestDisputeAssistant(
  db: DB,
  input: {
    disputeId: string;
    trigger: DisputeAssistTrigger;
    actorId: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<DisputeAssistResult> {
  const audit = auditCtxFor(input.trigger, input.actorId, { ipAddress: input.ipAddress, userAgent: input.userAgent });
  const base = { disputeId: input.disputeId, assignmentCycle: null as string | null, taskId: null as string | null };

  try {
    const dispute = await loadDispute(db, input.disputeId);
    if (!dispute) return { ...base, state: 'PENDING_TASK', reason: 'DISPUTE_NOT_FOUND' };

    const cycle = assignmentCycleOf(dispute.assignedToId, dispute.assignedAt);
    base.assignmentCycle = cycle;

    if (TERMINAL_DISPUTE_STATUSES.has(dispute.status)) {
      await writeAudit(db, audit, {
        action: 'DISPUTE.AI_ASSIST_SKIPPED',
        entityType: 'DISPUTE',
        entityId: dispute.id,
        metadata: { trigger: input.trigger, reason: `DISPUTE_${dispute.status}`, triggeredBy: input.actorId },
      });
      return { ...base, state: 'CLOSED_CASE', reason: `DISPUTE_${dispute.status}` };
    }

    if (!dispute.assignedToId || !cycle) {
      await writeAudit(db, audit, {
        action: 'DISPUTE.AI_ASSIST_REQUESTED',
        entityType: 'DISPUTE',
        entityId: dispute.id,
        metadata: { trigger: input.trigger, state: 'PENDING_NO_REVIEWER', triggeredBy: input.actorId },
      });
      return { ...base, state: 'PENDING_NO_REVIEWER', reason: 'NO_REVIEWER' };
    }

    const qualification = await qualifyReviewer(db, dispute.assignedToId);
    if (!qualification.qualified) {
      await writeAudit(db, audit, {
        action: 'DISPUTE.AI_ASSIST_BLOCKED',
        entityType: 'DISPUTE',
        entityId: dispute.id,
        metadata: {
          trigger: input.trigger,
          reason: qualification.reason,
          reviewerUserId: dispute.assignedToId,
          triggeredBy: input.actorId,
        },
      });
      return { ...base, state: 'PENDING_REVIEWER_NOT_QUALIFIED', reason: qualification.reason };
    }

    const reviewerId = dispute.assignedToId;
    const dedupeKey = disputeAssistDedupeKey(dispute.id, cycle);

    const existingBefore = await findCycleTask(db, dispute.id, cycle);
    if (existingBefore) {
      if (input.trigger === 'MANUAL_RETRY') {
        await writeAudit(db, audit, {
          action: 'DISPUTE.AI_ASSIST_RETRY_NOOP',
          entityType: 'DISPUTE',
          entityId: dispute.id,
          metadata: { trigger: input.trigger, taskId: existingBefore.id, status: existingBefore.status, triggeredBy: input.actorId },
        });
      }
      return { ...base, state: 'TASK_EXISTS', taskId: existingBefore.id, reason: null };
    }

    // Supersede tasks left open by an earlier assignment cycle: after a
    // reassignment they may never be approved and run under the previous
    // reviewer's authority.
    const superseded = await db
      .update(agentTasks)
      .set({
        status: 'rejected',
        rejectionReason: 'Superseded: dispute reassigned to another reviewer',
        approvedAt: new Date(),
      })
      .where(
        and(
          sql`${agentTasks.agentKey} = ${DISPUTE_ASSISTANT_AGENT_KEY}`,
          sql`${agentTasks.input}->>'__disputeId' = ${dispute.id}`,
          sql`coalesce(${agentTasks.input}->>'__disputeCycle', '') <> ${cycle}`,
          sql`${agentTasks.status} in ('queued', 'awaiting_approval')`,
        ),
      )
      .returning({ id: agentTasks.id, requestedBy: agentTasks.requestedBy });
    if (superseded.length > 0) {
      await writeAudit(db, audit, {
        action: 'DISPUTE.AI_ASSIST_SUPERSEDED',
        entityType: 'DISPUTE',
        entityId: dispute.id,
        metadata: {
          trigger: input.trigger,
          cycle,
          taskIds: superseded.map((t) => t.id),
          previousOwners: superseded.map((t) => t.requestedBy),
        },
      });
    }

    // The task is created through the one AI entry point so the kill switch,
    // capability refusal, per-user cap, policy snapshot, audit and metrics all
    // apply exactly as they do for a hand-made request. The dispute link is
    // passed as trusted origin metadata, never through `input`.
    const { createAgentTask } = await import('../ai/agents.js');
    const created = await createAgentTask(
      db,
      qualification.roles,
      reviewerId,
      {
        agentKey: DISPUTE_ASSISTANT_AGENT_KEY,
        requestedBy: reviewerId,
        input: { disputeId: dispute.id, action: 'summarize_dispute', taskType: 'dispute.summarize' },
      },
      audit,
      undefined,
      {
        dedupeKey,
        triggeredBy: 'dispute-assignment',
        disputeLink: { disputeId: dispute.id, cycle },
      },
    );

    await writeAudit(db, audit, {
      action: 'DISPUTE.AI_ASSIST_TASK_CREATED',
      entityType: 'DISPUTE',
      entityId: dispute.id,
      after: { taskId: created.id, status: created.status, reviewerUserId: reviewerId },
      metadata: { trigger: input.trigger, cycle, requiresApproval: created.requiresApproval, triggeredBy: input.actorId },
    });

    return { ...base, state: 'TASK_CREATED', taskId: created.id, reason: null };
  } catch (err) {
    // A failed assistant must never fail the dispute. Record it, surface it, and
    // let an operator retry once the cause is fixed.
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn('dispute assistant request failed', { disputeId: input.disputeId, trigger: input.trigger, error: message });
    try {
      await writeAudit(db, audit, {
        action: 'DISPUTE.AI_ASSIST_FAILED',
        entityType: 'DISPUTE',
        entityId: input.disputeId,
        metadata: { trigger: input.trigger, error: message, triggeredBy: input.actorId },
      });
    } catch (auditErr) {
      logger.error('dispute assistant failure could not be audited', {
        disputeId: input.disputeId,
        error: auditErr instanceof Error ? auditErr.message : 'Unknown error',
      });
    }
    return { ...base, state: 'TASK_FAILED', reason: message };
  }
}
