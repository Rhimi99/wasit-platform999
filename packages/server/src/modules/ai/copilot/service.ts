import Decimal from 'decimal.js';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../../db/client';
import type { AuditContext } from '../../../lib/audit';
import { writeAudit } from '../../../lib/audit';
import { newId } from '../../../lib/ids';
import { assertAiExecutionEnabled } from '../../../lib/ai/kill-switch';
import { agentRunSteps, agentRuns } from '../../../db/schema/agent_runs';
import { agentTasks } from '../../../db/schema/agents';
import { roles, userRoles } from '../../../db/schema/auth';
import { planAgentRun } from '../planner';
import { dispatchStep, reconcileRun } from '../dispatcher';
import { findAgentSpec } from '../catalogue';
import { clarificationQuestionFor, parseIntent } from './intent';
import { proposePlan } from './planner';
import type {
  CopilotEscalation,
  CopilotLocale,
  CopilotReport,
  CopilotReportStep,
  CopilotRequestView,
} from './types';

/**
 * WASIT-COPILOT-01 — coordination service.
 *
 * It adds no execution path of its own: a request becomes an `agent_run` through
 * the existing planning service, and every step is delegated through the existing
 * dispatcher (which itself creates agent tasks through `createAgentTask`). That is
 * what keeps the Copilot inside RBAC, the kill switch, the supervisor, the spend
 * guard and the audit trail — it has nothing else to call.
 */

const MAX_REQUEST_CHARS = 2000;
const MIN_REQUEST_CHARS = 8;
/** Bound on dispatches per advance call, so one request cannot fan out forever. */
const MAX_DISPATCH_PER_ADVANCE = 8;
const DISPATCHABLE = new Set(['PLANNING', 'DISPATCHING', 'RUNNING', 'PAUSED']);

export interface CreateCopilotRequestInput {
  request: string;
  locale?: CopilotLocale;
  /**
   * Caller-supplied idempotency key. Re-submitting the same key returns the
   * existing run instead of creating a second one (and a second set of tasks).
   */
  requestId?: string;
  /** Defaults to true: a plan is delegated as soon as it is valid. */
  autoAdvance?: boolean;
}

async function rolesOf(db: DB, userId: string): Promise<UserRole[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.name as UserRole);
}

function runKeyFor(requestId: string): string {
  return `copilot:${requestId}`.slice(0, 128);
}

async function findRunByKey(db: DB, runKey: string) {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.runKey, runKey)).limit(1);
  return rows[0] ?? null;
}

/** Merges coordinator metadata without dropping what the planner wrote. */
async function patchRunMetadata(db: DB, runId: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      metadata: sql`coalesce(${agentRuns.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
}

/**
 * Creates one coordination request: understand → plan → validate → persist →
 * (optionally) delegate.
 *
 * Nothing is written before the plan passes `validatePlan` (live registry,
 * runnability, requester permissions, dependency graph, size), and no approval is
 * ever granted here — a gated step stays `AWAITING_APPROVAL` for a human.
 */
export async function createCopilotRequest(
  db: DB,
  requesterId: string,
  input: CreateCopilotRequestInput,
  audit: AuditContext,
): Promise<CopilotRequestView> {
  assertAiExecutionEnabled();

  const text = typeof input.request === 'string' ? input.request.trim() : '';
  if (text.length < MIN_REQUEST_CHARS) {
    throw ApiError.validation(
      [{ field: 'request', code: 'REQUIRED', message: `Describe the goal in at least ${MIN_REQUEST_CHARS} characters` }],
      'A coordination request needs a goal',
    );
  }
  if (text.length > MAX_REQUEST_CHARS) {
    throw ApiError.validation(
      [{ field: 'request', code: 'TOO_LONG', message: `At most ${MAX_REQUEST_CHARS} characters` }],
      'The request is too long',
    );
  }

  const requestId = input.requestId && input.requestId.trim() !== '' ? input.requestId.trim() : newId();
  const runKey = runKeyFor(requestId);

  // Idempotency first: a repeated submission is the same request, not a new one.
  const existing = await findRunByKey(db, runKey);
  if (existing) {
    const intent = parseIntent(text, input.locale);
    return {
      needsClarification: false,
      clarificationQuestion: null,
      intent,
      report: await buildCopilotReport(db, existing.id, requesterId),
    };
  }

  const intent = parseIntent(text, input.locale);
  if (intent.needsClarification) {
    await writeAudit(db, audit, {
      action: 'AI.COPILOT_CLARIFICATION_REQUESTED',
      entityType: 'AGENT_RUN',
      entityId: null,
      metadata: { requestId, signals: intent.signals, locale: intent.locale },
    });
    return {
      needsClarification: true,
      clarificationQuestion: intent.clarificationQuestion,
      intent,
      report: null,
    };
  }

  const requesterRoles = await rolesOf(db, requesterId);
  const plan = await proposePlan(db, { requesterId, roles: requesterRoles, intent, request: text });

  if (plan.steps.length === 0) {
    // Recognised nothing it can delegate: ask, do not invent an agent.
    return {
      needsClarification: true,
      clarificationQuestion: intent.clarificationQuestion ?? clarificationQuestionFor(intent.locale),
      intent,
      report: null,
    };
  }

  const title = (intent.goal || text).slice(0, 300);
  const persisted = await planAgentRun(
    db,
    requesterId,
    {
      runKey,
      title,
      description: text,
      steps: plan.steps.map((s) => ({
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        input: s.input,
        dependsOn: s.dependsOn,
        priority: 0,
      })),
    },
    audit,
  );

  const reasons = Object.fromEntries(plan.steps.map((s) => [s.stepKey, s.reason]));
  await patchRunMetadata(db, persisted.runId, {
    copilot: {
      requestId,
      locale: intent.locale,
      signals: intent.signals,
      constraints: plan.constraints,
      expectedOutputs: plan.expectedOutputs,
      source: plan.source,
      fallbackReason: plan.fallbackReason,
      promptVersion: plan.promptVersion,
      injectionSuspected: plan.injectionSuspected,
      reasons,
      planning: plan.meta,
    },
  });

  await writeAudit(db, audit, {
    action: 'AI.COPILOT_REQUEST_PLANNED',
    entityType: 'AGENT_RUN',
    entityId: persisted.runId,
    metadata: {
      requestId,
      source: plan.source,
      fallbackReason: plan.fallbackReason,
      agents: plan.steps.map((s) => s.agentKey),
      steps: plan.steps.length,
    },
  });

  if (input.autoAdvance !== false) {
    await advanceCopilotRun(db, persisted.runId, audit);
  }

  return {
    needsClarification: false,
    clarificationQuestion: null,
    intent,
    report: await buildCopilotReport(db, persisted.runId, requesterId),
  };
}

/**
 * Delegates every step that is ready, in dependency order, and settles the run.
 *
 * Bounded and idempotent: a step is dispatched at most once because the
 * dispatcher refuses a step that already has a task, and a gated step is never
 * dispatched here (it has no approval yet). Nothing is retried onto a different
 * agent — a refusal is reported, never routed around.
 */
export async function advanceCopilotRun(
  db: DB,
  runId: string,
  audit: AuditContext,
): Promise<{ dispatched: string[]; blocked: string[]; status: string }> {
  assertAiExecutionEnabled();
  const dispatched: string[] = [];
  const blocked: string[] = [];

  for (let i = 0; i < MAX_DISPATCH_PER_ADVANCE; i += 1) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (!run) throw ApiError.notFound('Coordination request');
    if (!DISPATCHABLE.has(run.status)) break;

    const steps = await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId));
    const byKey = new Map(steps.map((s) => [s.stepKey, s]));
    const ready = steps
      .filter((s) => ['PENDING', 'READY', 'RETRYING'].includes(s.status))
      .filter((s) => (s.dependsOn as string[]).every((d) => byKey.get(d)?.status === 'SUCCEEDED'))
      .filter((s) => !s.requiresApproval || (s.status === 'READY' && s.approvedBy !== null))
      .sort((a, b) => a.priority - b.priority || a.stepKey.localeCompare(b.stepKey));

    if (ready.length === 0) break;

    let progressed = false;
    for (const step of ready) {
      try {
        await dispatchStep(db, runId, step.stepKey, audit);
        dispatched.push(step.stepKey);
        progressed = true;
        break;
      } catch (err) {
        // A step that cannot be dispatched is reported, never silently skipped.
        blocked.push(`${step.stepKey}:${err instanceof Error ? err.message : 'dispatch failed'}`);
      }
    }
    if (!progressed) break;
  }

  // Settle the run when every step reached a terminal state.
  const status = await reconcileRun(db, runId, audit);
  return { dispatched, blocked, status };
}

function safeParse(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Digests what an agent returned WITHOUT trusting it as proof of success.
 * `refused`/`error` are read from the executor's own payload; the step's status
 * always comes from the database.
 */
function digestAdvice(result: unknown): { outcome: string | null; refused: boolean } {
  const row = safeParse(result);
  if (!row) return { outcome: null, refused: false };
  const advice = safeParse(row.advice) ?? row;
  const refused = advice.refused === true || (typeof advice.error === 'string' && advice.error.length > 0);
  const candidate =
    (typeof advice.summary === 'string' && advice.summary) ||
    (typeof advice.headline === 'string' && advice.headline) ||
    (typeof advice.text === 'string' && advice.text) ||
    (typeof advice.recommendation === 'string' && advice.recommendation) ||
    (typeof advice.code === 'string' && advice.code) ||
    null;
  const outcome = candidate ? candidate.slice(0, 240) : Object.keys(advice).slice(0, 8).join(', ');
  return { outcome: outcome || null, refused };
}

/**
 * Builds the unified report from the database: run, plan provenance, steps,
 * task statuses, costs, and what needs a human decision.
 */
export async function buildCopilotReport(db: DB, runId: string, viewerId: string): Promise<CopilotReport> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) throw ApiError.notFound('Coordination request');

  const viewerRoles = await rolesOf(db, viewerId);
  const isStaff = viewerRoles.includes('ADMIN') || viewerRoles.includes('SUPER_ADMIN');
  if (!isStaff && run.requestedBy !== viewerId) {
    // Existence of another owner's request is itself commercial information.
    throw ApiError.notFound('Coordination request');
  }

  const steps = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.priority), asc(agentRunSteps.stepKey));

  const taskIds = steps
    .map((s) => safeParse(s.result)?.taskId)
    .filter((v): v is string => typeof v === 'string');
  const tasks = taskIds.length
    ? await db.select().from(agentTasks).where(inArray(agentTasks.id, taskIds))
    : [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const meta = safeParse(run.metadata) ?? {};
  const copilot = (safeParse(meta.copilot) ?? {}) as Record<string, unknown>;
  const reasons = (safeParse(copilot.reasons) ?? {}) as Record<string, string>;
  const planning = (safeParse(copilot.planning) ?? {}) as Record<string, unknown>;

  const reportSteps: CopilotReportStep[] = steps.map((s) => {
    const stored = safeParse(s.result);
    const taskId = typeof stored?.taskId === 'string' ? stored.taskId : null;
    const task = taskId ? taskById.get(taskId) : undefined;
    const digest = digestAdvice(stored?.result);
    return {
      stepKey: s.stepKey,
      agentKey: s.agentKey,
      agentName: findAgentSpec(s.agentKey)?.name ?? s.agentKey,
      reason: reasons[s.stepKey] ?? '',
      status: s.status,
      requiresApproval: s.requiresApproval,
      approvedBy: s.approvedBy ?? null,
      taskId,
      taskStatus: typeof stored?.taskStatus === 'string' ? stored.taskStatus : (task?.status ?? null),
      attempts: s.attemptCount,
      outcome: digest.outcome,
      refused: digest.refused,
      costUsd: task ? task.cost : null,
      error: safeParse(s.error)?.message ? String(safeParse(s.error)!.message) : null,
    };
  });

  const count = (predicate: (s: CopilotReportStep) => boolean) => reportSteps.filter(predicate).length;
  const succeeded = count((s) => s.status === 'SUCCEEDED' && !s.refused);
  const refusedSteps = count((s) => s.status === 'SUCCEEDED' && s.refused);
  const failed = count((s) => s.status === 'FAILED');
  const skipped = count((s) => s.status === 'SKIPPED' || s.status === 'CANCELLED');
  const awaiting = count(
    (s) => s.status === 'AWAITING_APPROVAL' || (s.requiresApproval && s.approvedBy === null && s.status === 'PENDING'),
  );
  const running = count((s) => s.status === 'RUNNING');
  const pending = count(
    (s) =>
      (s.status === 'PENDING' || s.status === 'READY' || s.status === 'BLOCKED' || s.status === 'RETRYING') &&
      !(s.requiresApproval && s.approvedBy === null),
  );

  const escalations: CopilotEscalation[] = [];
  for (const s of reportSteps) {
    if (s.requiresApproval && s.approvedBy === null && (s.status === 'PENDING' || s.status === 'AWAITING_APPROVAL')) {
      escalations.push({
        kind: 'approval',
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        message: 'Sensitive agent: a different authorised approver must approve this step before it runs.',
      });
    } else if (s.status === 'FAILED') {
      escalations.push({
        kind: 'failure',
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        message: s.error ?? 'The agent failed; the coordinator does not retry onto another agent.',
      });
    } else if (s.refused) {
      escalations.push({
        kind: 'failure',
        stepKey: s.stepKey,
        agentKey: s.agentKey,
        message: `The agent refused: ${s.outcome ?? 'no reason recorded'}`,
      });
    }
  }
  if (run.status === 'RUNNING' && running === 0 && pending === 0 && awaiting === 0) {
    escalations.push({
      kind: 'stalled',
      stepKey: '',
      agentKey: '',
      message: 'The run is open but nothing is in flight; it needs a supervisor pass or a human decision.',
    });
  }

  const executionUsd = tasks.reduce((acc, t) => acc.plus(new Decimal(t.cost || '0')), new Decimal(0));
  const planningUsd = new Decimal(typeof planning.cost === 'string' ? planning.cost : '0');
  const costComplete = reportSteps.every((s) => s.taskId === null || s.costUsd !== null);

  return {
    runId: run.id,
    goal: run.title,
    request: run.description,
    status: run.status,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    plan: {
      source: copilot.source === 'llm' ? 'llm' : 'heuristic',
      fallbackReason: typeof copilot.fallbackReason === 'string' ? copilot.fallbackReason : null,
      promptVersion: typeof copilot.promptVersion === 'string' ? copilot.promptVersion : null,
      injectionSuspected: copilot.injectionSuspected === true,
      constraints: Array.isArray(copilot.constraints) ? (copilot.constraints as string[]) : [],
      expectedOutputs: Array.isArray(copilot.expectedOutputs) ? (copilot.expectedOutputs as string[]) : [],
      model: typeof planning.model === 'string' ? planning.model : null,
      costUsd: planningUsd.toFixed(6),
    },
    steps: reportSteps,
    progress: {
      total: reportSteps.length,
      succeeded,
      failed: failed + refusedSteps,
      skipped,
      awaitingApproval: awaiting,
      pending,
      running,
    },
    outcomes: {
      completed: reportSteps.filter((s) => s.status === 'SUCCEEDED' && !s.refused).map((s) => s.stepKey),
      partial: reportSteps.filter((s) => s.status === 'SUCCEEDED' && s.refused).map((s) => s.stepKey),
      stalled: reportSteps.filter((s) => s.status === 'FAILED' || s.status === 'AWAITING_APPROVAL').map((s) => s.stepKey),
    },
    escalations,
    cost: {
      totalUsd: planningUsd.plus(executionUsd).toFixed(6),
      planningUsd: planningUsd.toFixed(6),
      executionUsd: executionUsd.toFixed(6),
      complete: costComplete,
    },
    governance: {
      approvalsRequired: awaiting,
      selfApproval: false,
      dispatchable: DISPATCHABLE.has(run.status),
    },
  };
}

/** The General Manager's request list (own requests; staff see all). */
export async function listCopilotRequests(db: DB, viewerId: string): Promise<CopilotReport[]> {
  const viewerRoles = await rolesOf(db, viewerId);
  const isStaff = viewerRoles.includes('ADMIN') || viewerRoles.includes('SUPER_ADMIN');
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      isStaff
        ? sql`${agentRuns.runKey} like 'copilot:%'`
        : and(sql`${agentRuns.runKey} like 'copilot:%'`, eq(agentRuns.requestedBy, viewerId)),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
  const reports: CopilotReport[] = [];
  for (const row of rows) reports.push(await buildCopilotReport(db, row.id, viewerId));
  return reports;
}
