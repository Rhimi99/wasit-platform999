import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '@wasit/shared';
import type { DB } from '../../../db/client.js';
import { pingDb } from '../../../db/client.js';
import { agentTasks } from '../../../db/schema/agents.js';
import { agentRuns, agentRunSteps } from '../../../db/schema/agent_runs.js';
import { auditLogs } from '../../../db/schema/audit.js';
import { aiRequests } from '../../../db/schema/ai.js';
import { roles, userRoles, users } from '../../../db/schema/auth.js';
import { alertEvents } from '../../../db/schema/observability.js';
import { env } from '../../../lib/env.js';
import { logger } from '../../../lib/observability/logger.js';
import { alertStatus } from '../../../lib/observability/resolve-notifier.js';
import { firingAlerts, lastAlertEvaluationAt } from '../../../lib/observability/alerts.js';
import { rateLimitStoreStatus } from '../../../lib/rate-limit/resolve.js';
import { checkRateLimitStoreReadiness } from '../../../lib/rate-limit/readiness.js';
import { describeMediaProviders } from '../../../lib/media/resolve.js';
import { catalogHeartbeat } from '../../../lib/ai/routing.js';
import { getAiExecutionSwitchState } from '../../../lib/ai/kill-switch.js';
import { spendGuardState } from '../../../lib/ai/spend-guard.js';
import { spendOverview } from '../../../lib/ai/spend-limits.js';
import {
  configEnvironment,
  keyState,
  listProviderRows,
  maskProvider,
  type ProviderRow,
} from '../../../lib/ai/provider-config.js';
import { secretStorageStatus } from '../../../lib/ai/secret-box.js';
import { AGENT_GENERATIVE_CAPABILITY } from '../../../lib/ai/llm/contract.js';
import { buildCompanyMetricsForAdmin } from '../../ai/agent-metrics.js';
import { derivePlatformScope } from '../../ai/scope.js';
import { agentLayerSummary, listAgents } from '../../ai/agents.js';
import { buildSupervisorOverview } from '../../ai/supervisor.js';
import { listCopilotRequests } from '../../ai/copilot/service.js';
import { backupStatus } from '../../health/routes.js';
import type {
  ApprovalItem,
  GmAgentRow,
  GmAgentsData,
  GmApprovalsData,
  GmAuditData,
  GmAuditRow,
  GmCopilotData,
  GmHealthData,
  GmOverview,
  GmPlatformData,
  GmProvidersData,
  GmSpendingData,
  GmSupervisorData,
  GmTaskRow,
  GmTasksData,
  HealthCheck,
  HealthState,
  Section,
} from './types.js';

/**
 * The GM command center (WASIT-GM-DASHBOARD-01).
 *
 * This module owns NO write path. Every number is read from the service that
 * already owns it — agent metrics, the Supervisor, the Copilot, spend limits and
 * the spend guard, providers, health, audit — and every operator action the UI
 * offers calls an existing endpoint. The dashboard can therefore never grant an
 * authority the platform did not already have.
 *
 * Two rules make the output trustworthy:
 *  1. A section that cannot be read is `UNAVAILABLE`, never a silent zero.
 *  2. A value that is genuinely unknown is `null`, never 0.
 */

const MAX_PAGE_SIZE = 100;
/** A task still open after this long is reported as overdue. */
const OVERDUE_MINUTES = 60;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The platform's own role→permission table; the same rule the AI services use. */
function roleHas(userRoles: string[], permission: string): boolean {
  return userRoles.some((role) => ROLE_PERMISSIONS[role as UserRole]?.has(permission as Permission));
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Service errors are written for operators; anything that looks like a stack
  // frame is replaced so an internal detail never reaches the browser.
  return message.length <= 200 && !/\n\s+at /.test(message) ? message : 'Source unavailable';
}

/** Runs one section and turns a failure into a stated gap, not a broken page. */
async function settle<T>(source: string, load: () => Promise<T>): Promise<Section<T>> {
  const generatedAt = new Date().toISOString();
  try {
    return { state: 'OK', source, generatedAt, data: await load(), error: null };
  } catch (err) {
    logger.warn('gm command center section unavailable', { source, error: safeError(err) });
    return { state: 'UNAVAILABLE', source, generatedAt, data: null, error: safeError(err) };
  }
}

/** The roles that may decide an approval — the same rule the approval services
 * enforce (`ai:manage`, or one of the two staff roles), read from the DB. */
async function approverRolesOf(db: DB): Promise<string[]> {
  const rows = await db.select({ name: roles.name }).from(roles);
  return rows
    .map((row) => row.name)
    .filter((name) => roleHas([name], 'ai:manage') || name === 'ADMIN' || name === 'SUPER_ADMIN')
    .sort();
}

/** Ids of active, unlocked users holding an approver role. */
async function approverUserIds(db: DB, approverRoles: string[]): Promise<string[]> {
  if (approverRoles.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(inArray(roles.name, approverRoles), eq(users.isActive, true), eq(users.isLocked, false)));
  return rows.map((row) => row.userId);
}

async function taskStatusTotals(db: DB): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: agentTasks.status, total: count() })
    .from(agentTasks)
    .groupBy(agentTasks.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}

async function copilotStatusTotals(db: DB): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: agentRuns.status, total: count() })
    .from(agentRuns)
    .where(sql`${agentRuns.runKey} like 'copilot:%'`)
    .groupBy(agentRuns.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
}

/** Recorded AI cost over the last 24h. `null` when it cannot be read. */
async function spend24hOrNull(db: DB, environment: string): Promise<{ costUsd: string; requests: number } | null> {
  try {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [row] = await db
      .select({ requests: count(), cost: sql<string>`coalesce(sum(${aiRequests.cost}), 0)` })
      .from(aiRequests)
      .where(and(gte(aiRequests.createdAt, since), eq(aiRequests.environment, environment)));
    return { costUsd: row?.cost ?? '0', requests: Number(row?.requests ?? 0) };
  } catch (err) {
    logger.warn('gm command center could not read 24h spend', { error: safeError(err) });
    return null;
  }
}

/** A provider that can actually run a call: enabled, and either keyless (local
 * engine) or holding a credential. */
function providerUsable(row: ProviderRow): boolean {
  const masked = maskProvider(row);
  return row.enabled && (!masked.requiresKey || masked.keyState.present);
}

/** What the generation path needs before it can reach a provider at all. */
async function generationReadiness(
  db: DB,
  environment: string,
): Promise<{ available: boolean; reason: string | null }> {
  if (!(await getAiExecutionSwitchState(db)).enabled) {
    return { available: false, reason: 'AI execution is stopped by the central switch' };
  }
  const rows = await listProviderRows(db);
  if (!rows.some(providerUsable)) {
    return { available: false, reason: 'no enabled provider with a usable credential' };
  }
  const guard = await spendGuardState(db, environment);
  if (!guard.ready) {
    return { available: false, reason: `the spend guard is missing a GLOBAL ${guard.missing.join(' + ')} cap` };
  }
  return { available: true, reason: null };
}

export async function buildAgentsSection(
  db: DB,
  days: number,
  viewer: { id: string; roles: string[] },
): Promise<GmAgentsData> {
  const environment = configEnvironment();
  const since = new Date(Date.now() - days * 86_400_000);
  const [definitions, company, spend] = await Promise.all([
    listAgents(db),
    buildCompanyMetricsForAdmin(
      db,
      derivePlatformScope({ userId: viewer.id }, { roles: viewer.roles as UserRole[] }),
      { since },
    ),
    spendOverview(db, { from: since, to: new Date(), environment }),
  ]);
  const readiness = await generationReadiness(db, environment);

  const spendByAgent = new Map(spend.byAgent.map((row) => [row.agentKey, row]));
  const limitByAgent = new Map(
    spend.limits.filter((limit) => limit.scope === 'AGENT' && limit.isActive).map((limit) => [limit.targetKey, limit]),
  );

  const items: GmAgentRow[] = company.agents.map((metric) => {
    const definition = definitions.find((entry) => entry.key === metric.agentKey);
    const capability = AGENT_GENERATIVE_CAPABILITY[metric.agentKey] ?? null;
    const generation: GmAgentRow['generation'] = capability
      ? 'llm'
      : definition?.executable
        ? 'deterministic'
        : 'none';
    const usage = spendByAgent.get(metric.agentKey);
    const limit = limitByAgent.get(metric.agentKey);
    return {
      key: metric.agentKey,
      name: definition?.name ?? metric.name,
      nameAr: definition?.nameAr ?? null,
      mission: definition?.mission ?? null,
      category: definition?.category ?? null,
      tier: definition?.tier ?? null,
      active: definition?.isActive ?? metric.active,
      status: definition?.status ?? null,
      requiresHumanApproval: definition?.requiresHumanApproval ?? metric.requiresHumanApproval,
      approvalActions: definition?.approvalActions ?? [],
      permissionsRequired: definition?.permissionsRequired ?? [],
      allowedTools: definition?.allowedTools ?? [],
      generation,
      generationCapability: capability,
      execution: {
        total: metric.execution.totalRuns,
        completed: metric.execution.completed,
        failed: metric.execution.failed,
        pending: metric.execution.pending,
        running: metric.execution.running,
        // Null, not 0: a success rate over no runs is unknown, not "0%".
        successRate: metric.execution.successRate,
      },
      cost: {
        available: metric.cost.available,
        requests: usage?.requests ?? metric.cost.requests,
        actualCostUsd: metric.cost.available ? metric.cost.actualProviderCostUsd : null,
        tokensInput: usage?.tokensInput ?? metric.cost.tokensInput,
        tokensOutput: usage?.tokensOutput ?? metric.cost.tokensOutput,
      },
      limit: {
        configured: Boolean(limit),
        maxCost: limit?.maxCost ?? null,
        warnRatio: limit?.warnRatio ?? null,
      },
      health: metric.health,
      healthReason: metric.healthReason,
      lastActivityAt: metric.lastActivityAt,
    };
  });

  return {
    items,
    counts: agentLayerSummary(),
    company: {
      overall: company.overall,
      attention: company.attention,
      dataFreshness: company.dataFreshness,
      notes: [
        ...company.notes,
        readiness.available
          ? 'Generation path ready: switch open, a usable provider and GLOBAL spend caps are in place.'
          : `Generation falls back to deterministic analysis: ${readiness.reason}.`,
      ],
      window: company.window,
    },
    generativeAgents: items.filter((item) => item.generation === 'llm').map((item) => item.key),
    deterministicAgents: items.filter((item) => item.generation === 'deterministic').map((item) => item.key),
    // No generation path and no deterministic executor — e.g. the supervisor,
    // which coordinates rather than answers. Kept apart from `counts.declared`,
    // which the catalogue defines as "not executable and not the supervisor".
    noExecutorAgents: items.filter((item) => item.generation === 'none').map((item) => item.key),
  };
}

export async function buildCopilotSection(db: DB, viewerId: string, recent = 8): Promise<GmCopilotData> {
  const [items, totals] = await Promise.all([listCopilotRequests(db, viewerId, recent), copilotStatusTotals(db)]);
  const sum = (...keys: string[]) => keys.reduce((acc, key) => acc + (totals[key] ?? 0), 0);
  return {
    items,
    totals: {
      total: Object.values(totals).reduce((a, b) => a + b, 0),
      succeeded: sum('COMPLETED', 'SUCCEEDED'),
      failed: sum('FAILED'),
      awaiting: sum('AWAITING_APPROVAL'),
      running: sum('RUNNING', 'DISPATCHING', 'PLANNING'),
    },
    recentLimit: recent,
  };
}

export async function buildSupervisorSection(db: DB): Promise<GmSupervisorData> {
  const [overview, alertRows] = await Promise.all([
    buildSupervisorOverview(db),
    db
      .select({
        id: alertEvents.id,
        rule: alertEvents.rule,
        severity: alertEvents.severity,
        status: alertEvents.status,
        summary: alertEvents.summary,
        startedAt: alertEvents.startedAt,
        resolvedAt: alertEvents.resolvedAt,
      })
      .from(alertEvents)
      .where(eq(alertEvents.status, 'FIRING'))
      .orderBy(desc(alertEvents.startedAt))
      .limit(20),
  ]);
  const inMemory = firingAlerts();
  return {
    overview,
    alerts: {
      // The engine's live state can be ahead of the persisted events; report the
      // larger of the two rather than understating a firing alert.
      firing: Math.max(alertRows.length, inMemory.length),
      items: alertRows.map((row) => ({
        ...row,
        startedAt: iso(row.startedAt) ?? new Date().toISOString(),
        resolvedAt: iso(row.resolvedAt),
      })),
    },
  };
}

const SEVERITY_STATUSES: Record<GmTaskRow['severity'], string[]> = {
  high: ['failed', 'rejected', 'cancelled', 'contained'],
  medium: ['awaiting_approval', 'running', 'queued'],
  low: ['succeeded', 'approved', 'completed'],
};

function severityOf(status: string): GmTaskRow['severity'] {
  if (SEVERITY_STATUSES.high.includes(status)) return 'high';
  if (SEVERITY_STATUSES.medium.includes(status)) return 'medium';
  return 'low';
}

function totalsOf(byStatus: Record<string, number>, overdue: number): GmTasksData['totals'] {
  const sum = (...keys: string[]) => keys.reduce((acc, key) => acc + (byStatus[key] ?? 0), 0);
  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    queued: sum('queued', 'pending'),
    running: sum('running', 'in_progress'),
    awaitingApproval: sum('awaiting_approval'),
    completed: sum('succeeded', 'completed', 'approved'),
    failed: sum('failed'),
    cancelled: sum('cancelled', 'rejected'),
    overdue,
  };
}

/** Open tasks older than the overdue threshold. */
async function overdueTaskCount(db: DB): Promise<number> {
  const cutoff = new Date(Date.now() - OVERDUE_MINUTES * 60_000);
  const [row] = await db
    .select({ total: count() })
    .from(agentTasks)
    .where(
      and(inArray(agentTasks.status, ['queued', 'running', 'awaiting_approval']), lte(agentTasks.createdAt, cutoff)),
    );
  return Number(row?.total ?? 0);
}

export interface GmTaskFilters {
  status?: string;
  agentKey?: string;
  kind?: 'agent_task' | 'copilot_run';
  severity?: GmTaskRow['severity'];
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function listGmTasks(db: DB, filters: GmTaskFilters = {}): Promise<GmTasksData> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, filters.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const [statusTotals, overdue] = await Promise.all([taskStatusTotals(db), overdueTaskCount(db)]);

  if (filters.kind === 'copilot_run') {
    const conditions = [sql`${agentRuns.runKey} like 'copilot:%'`];
    if (filters.status) conditions.push(sql`${agentRuns.status} = ${filters.status}`);
    if (filters.severity) {
      const statuses = SEVERITY_STATUSES[filters.severity];
      conditions.push(sql`${agentRuns.status} in ${statuses}`);
    }
    if (filters.from) conditions.push(gte(agentRuns.createdAt, filters.from));
    if (filters.to) conditions.push(lte(agentRuns.createdAt, filters.to));
    const rows = await db
      .select({
        id: agentRuns.id,
        title: agentRuns.title,
        status: agentRuns.status,
        requestedBy: agentRuns.requestedBy,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        createdAt: agentRuns.createdAt,
        error: agentRuns.error,
      })
      .from(agentRuns)
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt))
      .limit(pageSize)
      .offset(offset);
    const items: GmTaskRow[] = rows.map((row) => ({
      id: row.id,
      kind: 'copilot_run',
      agentKey: 'copilot',
      title: row.title,
      status: row.status,
      taskType: 'copilot',
      requestedBy: row.requestedBy,
      runId: row.id,
      severity: severityOf(row.status),
      cost: '0',
      model: 'none',
      tokensInput: 0,
      tokensOutput: 0,
      durationMs:
        row.startedAt && row.completedAt
          ? Math.max(0, new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime())
          : null,
      createdAt: iso(row.createdAt)!,
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      errorMessage: (row.error as { message?: string } | null)?.message ?? null,
    }));
    return { items, totals: totalsOf(statusTotals, overdue), page, pageSize };
  }

  const conditions = [];
  if (filters.status) conditions.push(eq(agentTasks.status, filters.status));
  if (filters.agentKey) conditions.push(eq(agentTasks.agentKey, filters.agentKey));
  if (filters.severity) conditions.push(inArray(agentTasks.status, SEVERITY_STATUSES[filters.severity]));
  if (filters.from) conditions.push(gte(agentTasks.createdAt, filters.from));
  if (filters.to) conditions.push(lte(agentTasks.createdAt, filters.to));

  const rows = await db
    .select({
      id: agentTasks.id,
      agentKey: agentTasks.agentKey,
      status: agentTasks.status,
      taskType: agentTasks.taskType,
      requestedBy: agentTasks.requestedBy,
      correlationId: agentTasks.correlationId,
      cost: agentTasks.cost,
      model: agentTasks.model,
      tokensInput: agentTasks.tokensInput,
      tokensOutput: agentTasks.tokensOutput,
      startedAt: agentTasks.startedAt,
      completedAt: agentTasks.completedAt,
      createdAt: agentTasks.createdAt,
      error: agentTasks.error,
    })
    .from(agentTasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentTasks.createdAt))
    .limit(pageSize)
    .offset(offset);

  const items: GmTaskRow[] = rows.map((row) => ({
    id: row.id,
    kind: 'agent_task',
    agentKey: row.agentKey,
    title: null,
    status: row.status,
    taskType: row.taskType,
    requestedBy: row.requestedBy,
    runId: row.correlationId,
    severity: severityOf(row.status),
    cost: row.cost,
    model: row.model,
    tokensInput: row.tokensInput,
    tokensOutput: row.tokensOutput,
    durationMs:
      row.startedAt && row.completedAt
        ? Math.max(0, new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime())
        : null,
    createdAt: iso(row.createdAt)!,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    errorMessage: (row.error as { message?: string } | null)?.message ?? null,
  }));

  return { items, totals: totalsOf(statusTotals, overdue), page, pageSize };
}

export async function buildApprovalsSection(db: DB, viewerId: string): Promise<GmApprovalsData> {
  const [taskRows, stepRows, approverRoles] = await Promise.all([
    db
      .select({
        id: agentTasks.id,
        agentKey: agentTasks.agentKey,
        action: agentTasks.approvalAction,
        taskType: agentTasks.taskType,
        requestedBy: agentTasks.requestedBy,
        correlationId: agentTasks.correlationId,
        createdAt: agentTasks.createdAt,
        attempts: agentTasks.attempts,
      })
      .from(agentTasks)
      .where(eq(agentTasks.status, 'awaiting_approval'))
      .orderBy(desc(agentTasks.createdAt))
      .limit(50),
    db
      .select({
        id: agentRunSteps.id,
        runId: agentRunSteps.runId,
        stepKey: agentRunSteps.stepKey,
        agentKey: agentRunSteps.agentKey,
        status: agentRunSteps.status,
        requestedBy: agentRuns.requestedBy,
        createdAt: agentRunSteps.createdAt,
        runTitle: agentRuns.title,
      })
      .from(agentRunSteps)
      .innerJoin(agentRuns, eq(agentRunSteps.runId, agentRuns.id))
      .where(
        and(
          eq(agentRunSteps.requiresApproval, true),
          inArray(agentRunSteps.status, ['PENDING', 'AWAITING_APPROVAL']),
        ),
      )
      .orderBy(desc(agentRunSteps.createdAt))
      .limit(50),
    approverRolesOf(db),
  ]);

  const approverIds = await approverUserIds(db, approverRoles);
  const hasIndependent = (requester: string) => approverIds.some((id) => id !== requester);
  const now = Date.now();
  const ageOf = (value: Date) => Math.round((now - new Date(value).getTime()) / 60_000);

  const items: ApprovalItem[] = [
    ...taskRows.map((row) => ({
      id: row.id,
      kind: 'agent_task' as const,
      agentKey: row.agentKey,
      action: row.action ?? row.taskType ?? 'agent task',
      title: `${row.agentKey} — ${row.action ?? row.taskType ?? 'task'}`,
      requestedBy: row.requestedBy,
      requestedAt: iso(row.createdAt)!,
      ageMinutes: ageOf(row.createdAt),
      risk: row.action ? ('high' as const) : ('medium' as const),
      evidence: [
        `task ${row.id}`,
        row.taskType ? `type ${row.taskType}` : 'no task type',
        `attempt ${row.attempts + 1}`,
        row.correlationId ? `run ${row.correlationId}` : 'no run',
      ],
      runId: row.correlationId,
      stepKey: null,
      reason: 'The agent declares this action as requiring a human decision before execution.',
      selfApprovalBlocked: row.requestedBy === viewerId,
      independentApproverAvailable: hasIndependent(row.requestedBy),
      state: hasIndependent(row.requestedBy) ? ('PENDING' as const) : ('BLOCKED_PENDING_INDEPENDENT_APPROVER' as const),
    })),
    ...stepRows.map((row) => ({
      id: row.id,
      kind: 'run_step' as const,
      agentKey: row.agentKey,
      action: row.stepKey,
      title: `${row.runTitle} — ${row.stepKey}`,
      requestedBy: row.requestedBy,
      requestedAt: iso(row.createdAt)!,
      ageMinutes: ageOf(row.createdAt),
      risk: 'high' as const,
      evidence: [`run ${row.runId}`, `step ${row.stepKey}`, `status ${row.status}`],
      runId: row.runId,
      stepKey: row.stepKey,
      reason: 'The plan marked this step as approval-gated before dispatch.',
      selfApprovalBlocked: row.requestedBy === viewerId,
      independentApproverAvailable: hasIndependent(row.requestedBy),
      state: hasIndependent(row.requestedBy) ? ('PENDING' as const) : ('BLOCKED_PENDING_INDEPENDENT_APPROVER' as const),
    })),
  ].sort((a, b) => b.ageMinutes - a.ageMinutes);

  return {
    items,
    blocked: items.filter((item) => item.state === 'BLOCKED_PENDING_INDEPENDENT_APPROVER').length,
    approverRoles,
  };
}

export async function buildProvidersSection(db: DB): Promise<GmProvidersData> {
  const rows = await listProviderRows(db);
  const storage = secretStorageStatus();
  return {
    environment: configEnvironment(),
    liveTestAllowed: env.AI_PROVIDER_ALLOW_LIVE_TEST,
    secretStorage: { available: storage.available, reason: storage.reason ?? null },
    items: rows.map((row) => ({ ...maskProvider(row) })),
  };
}

export async function buildSpendingSection(db: DB, days: number): Promise<GmSpendingData> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const environment = configEnvironment();
  const [overview, guard] = await Promise.all([
    spendOverview(db, { from, to, environment }),
    spendGuardState(db, environment),
  ]);
  return { overview, guard };
}

async function buildHealthSection(db: DB, supervisor: GmSupervisorData | null): Promise<GmHealthData> {
  const checkedAt = new Date().toISOString();
  const items: HealthCheck[] = [];

  items.push({
    key: 'api',
    state: 'HEALTHY',
    detail: 'This response was produced by the API process.',
    probed: true,
    checkedAt,
  });

  const dbStarted = Date.now();
  try {
    await pingDb();
    const latency = Date.now() - dbStarted;
    items.push({
      key: 'postgres',
      state: latency > 1_000 ? 'DEGRADED' : 'HEALTHY',
      detail: `SELECT 1 answered in ${latency} ms.`,
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({ key: 'postgres', state: 'DOWN', detail: 'The database did not answer.', probed: true, checkedAt });
  }

  try {
    const status = rateLimitStoreStatus(db);
    const readiness = await checkRateLimitStoreReadiness(db);
    items.push({
      key: 'rateLimitStore',
      state: readiness.ready ? 'HEALTHY' : 'DEGRADED',
      // A memory store is process-local: saying "shared" here would overstate a
      // single-instance deployment, so the scope is reported from the store id.
      detail: `${status.store} store, ${
        readiness.durable ? 'shared across replicas' : 'process-local, not shared'
      }${readiness.ready ? '' : ` (${readiness.detail ?? 'unavailable'})`}`,
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({
      key: 'rateLimitStore',
      state: 'UNKNOWN',
      detail: 'Store state could not be read.',
      probed: false,
      checkedAt,
    });
  }

  const killSwitch = await getAiExecutionSwitchState(db);
  items.push({
    key: 'aiExecution',
    state: killSwitch.failClosed ? 'DOWN' : killSwitch.enabled ? 'HEALTHY' : 'DEGRADED',
    detail: killSwitch.failClosed
      ? 'AI execution control is unavailable; new work is refused (fail-closed).'
      : killSwitch.enabled
        ? `AI execution is open (source: ${killSwitch.source}).`
        : `AI execution is stopped (source: ${killSwitch.source}).`,
    probed: true,
    checkedAt,
  });

  try {
    const heartbeat = await catalogHeartbeat(db);
    items.push({
      key: 'aiCatalogue',
      state: heartbeat.ok ? 'HEALTHY' : 'DOWN',
      detail: heartbeat.ok ? `${heartbeat.models} active model(s).` : 'No active model in the catalogue.',
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({ key: 'aiCatalogue', state: 'UNKNOWN', detail: 'Catalogue could not be read.', probed: false, checkedAt });
  }

  try {
    const providers = await listProviderRows(db);
    const usable = providers.filter(providerUsable).length;
    items.push({
      key: 'aiProviders',
      state: usable > 0 ? 'HEALTHY' : 'DEGRADED',
      detail:
        usable > 0
          ? `${providers.length} configured, ${usable} usable now.`
          : `${providers.length} configured, none can run a call.`,
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({
      key: 'aiProviders',
      state: 'UNKNOWN',
      detail: 'Provider configuration could not be read.',
      probed: false,
      checkedAt,
    });
  }

  try {
    const media = await describeMediaProviders();
    items.push({
      key: 'media',
      state: media.video.available ? 'HEALTHY' : 'DEGRADED',
      detail: `storage ${media.storage.id}${media.storage.available ? '' : ' (unavailable)'}, video ${media.video.id}${
        media.video.available ? '' : ` (${media.video.reason ?? 'unavailable'})`
      }`,
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({ key: 'media', state: 'UNKNOWN', detail: 'Media runtime could not be probed.', probed: false, checkedAt });
  }

  try {
    const notifier = alertStatus();
    items.push({
      key: 'alerts',
      state: notifier.available ? 'HEALTHY' : 'DEGRADED',
      detail: `${firingAlerts().length} rule(s) firing, notifier ${notifier.notifier}${notifier.available ? '' : ' (unavailable)'}, last evaluation ${
        iso(lastAlertEvaluationAt()) ?? 'never'
      }.`,
      probed: true,
      checkedAt,
    });
  } catch {
    items.push({ key: 'alerts', state: 'UNKNOWN', detail: 'Alert engine state could not be read.', probed: false, checkedAt });
  }

  items.push(
    supervisor
      ? {
          key: 'supervisor',
          state:
            supervisor.overview.stuckRuns > 0 || supervisor.overview.budgetExceededRuns > 0 ? 'DEGRADED' : 'HEALTHY',
          detail: `${supervisor.overview.activeRuns} live run(s), ${supervisor.overview.stuckRuns} stuck, ${
            supervisor.overview.containedRuns
          } contained, last intervention ${supervisor.overview.lastCycleAt ?? 'none recorded'}.`,
          probed: true,
          checkedAt,
        }
      : {
          key: 'supervisor',
          state: 'UNKNOWN',
          detail: 'The Supervisor overview was unavailable.',
          probed: false,
          checkedAt,
        },
  );

  const backup = backupStatus();
  items.push({
    key: 'backup',
    state:
      !backup.configured || backup.ageHours === null
        ? 'UNKNOWN'
        : backup.ageHours <= backup.maxAgeHours
          ? 'HEALTHY'
          : 'DEGRADED',
    detail: !backup.configured
      ? 'No backup heartbeat is configured in this deployment.'
      : backup.lastSuccessAt
        ? `Last success ${backup.lastSuccessAt} (${backup.ageHours}h ago, limit ${backup.maxAgeHours}h).`
        : 'A heartbeat file is configured but no successful run is recorded.',
    probed: true,
    checkedAt,
  });

  return { overall: worst(items.map((item) => item.state)), items };
}

function worst(states: HealthState[]): HealthState {
  if (states.includes('DOWN')) return 'DOWN';
  if (states.includes('DEGRADED')) return 'DEGRADED';
  if (states.length > 0 && states.every((state) => state === 'UNKNOWN')) return 'UNKNOWN';
  return 'HEALTHY';
}

export interface GmAuditFilters {
  action?: string;
  entityType?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function listGmAudit(db: DB, filters: GmAuditFilters = {}): Promise<GmAuditData> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, filters.pageSize ?? 50));
  const conditions = [];
  if (filters.action) conditions.push(sql`${auditLogs.action} like ${`${filters.action}%`}`);
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.from) conditions.push(gte(auditLogs.createdAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogs.createdAt, filters.to));
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    items: rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! })) as GmAuditRow[],
    page,
    pageSize,
  };
}

export interface GmViewer {
  id: string;
  roles: string[];
}

/**
 * The executive summary is derived from the sections, never queried twice: a
 * section that failed yields `null` here, so the headline can never show a zero
 * for something that was simply unreadable.
 */
async function buildPlatformSection(
  db: DB,
  environment: string,
  parts: {
    agents: Section<GmAgentsData>;
    copilot: Section<GmCopilotData>;
    tasks: Section<GmTasksData>;
    approvals: Section<GmApprovalsData>;
    providers: Section<GmProvidersData>;
    supervisor: Section<GmSupervisorData>;
  },
): Promise<GmPlatformData> {
  const spend = await spend24hOrNull(db, environment);
  const agents = parts.agents.data;
  const copilot = parts.copilot.data;
  const tasks = parts.tasks.data;
  const approvals = parts.approvals.data;
  const providers = parts.providers.data;
  const supervisor = parts.supervisor.data;

  const switchState = await getAiExecutionSwitchState(db);
  const lastActivity = [
    ...(agents?.items.map((item) => item.lastActivityAt).filter((value): value is string => Boolean(value)) ?? []),
    ...(copilot?.items.map((report) => report.createdAt) ?? []),
  ].sort().at(-1);

  return {
    killSwitch: {
      enabled: switchState.enabled,
      source: switchState.source,
      failClosed: switchState.failClosed,
      globalStopped: switchState.globalStopped,
      envStopped: switchState.envStopped,
      stoppedAgents: switchState.stoppedAgents,
      reason: switchState.global?.reason ?? null,
      actorId: switchState.global?.actorId ?? null,
      updatedAt: switchState.global?.updatedAt ?? null,
    },
    agents: agents
      ? {
          total: agents.counts.total,
          active: agents.items.filter((item) => item.active).length,
          generative: agents.generativeAgents.length,
          noExecutor: agents.noExecutorAgents.length,
        }
      : null,
    tasks: tasks
      ? {
          queued: tasks.totals.queued,
          running: tasks.totals.running,
          awaitingApproval: tasks.totals.awaitingApproval,
          failed24h: tasks.totals.failed,
        }
      : null,
    copilot: copilot
      ? { total: copilot.totals.total, failed: copilot.totals.failed, awaiting: copilot.totals.awaiting }
      : null,
    approvalsPending: approvals ? approvals.items.length : null,
    approvalsBlocked: approvals ? approvals.blocked : null,
    alertsFiring: supervisor ? supervisor.alerts.firing : null,
    providers: providers
      ? {
          total: providers.items.length,
          enabled: providers.items.filter((item) => item.enabled === true).length,
          withKey: providers.items.filter((item) => {
            const state = item.keyState as { present?: boolean } | undefined;
            return state?.present === true;
          }).length,
        }
      : null,
    spend24h: spend,
    lastActivityAt: lastActivity ?? null,
  };
}

export async function buildGmOverview(db: DB, viewer: GmViewer, days: number): Promise<GmOverview> {
  const environment = configEnvironment();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  // The Supervisor section feeds the health row, so it is built first; the
  // remaining sections are independent and run in parallel.
  const supervisor = await settle<GmSupervisorData>('agent_runs, alert_events', () => buildSupervisorSection(db));

  const [agents, copilot, tasks, approvals, providers, spending, health, audit] = await Promise.all([
    settle<GmAgentsData>('agent_registry, agent_runs, ai_requests', () => buildAgentsSection(db, days, viewer)),
    settle<GmCopilotData>('agent_runs (copilot:*), agent_run_steps', () => buildCopilotSection(db, viewer.id)),
    settle<GmTasksData>('agent_tasks', () => listGmTasks(db, { pageSize: 10 })),
    settle<GmApprovalsData>('agent_tasks, agent_run_steps, user_roles', () => buildApprovalsSection(db, viewer.id)),
    settle<GmProvidersData>('ai_providers', () => buildProvidersSection(db)),
    settle<GmSpendingData>('ai_requests, ai_spend_limits', () => buildSpendingSection(db, days)),
    settle<GmHealthData>('live probes', () => buildHealthSection(db, supervisor.data)),
    settle<GmAuditData>('audit_logs', () => listGmAudit(db, { pageSize: 15 })),
  ]);

  const platform = await settle<GmPlatformData>('aggregated sections', () =>
    buildPlatformSection(db, environment, { agents, copilot, tasks, approvals, providers, supervisor }),
  );

  return {
    generatedAt: new Date().toISOString(),
    environment,
    window: { days, from: from.toISOString(), to: to.toISOString() },
    viewer: {
      id: viewer.id,
      roles: viewer.roles,
      canDecideApprovals:
        roleHas(viewer.roles, 'ai:manage') || viewer.roles.includes('ADMIN') || viewer.roles.includes('SUPER_ADMIN'),
    },
    sections: { platform, agents, copilot, supervisor, tasks, approvals, providers, spending, health, audit },
  };
}
