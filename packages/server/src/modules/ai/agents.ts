import { desc, eq } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentRegistry, agentTasks } from '../../db/schema/agents';
import { writeAudit } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { createNotification } from '../../lib/notifications-service';
import type { AgentCapability } from '../../lib/ai/types';
import type { AgentDefinition, AgentTaskStatus, CreateAgentTaskInput, ResolvedAgentTask } from '../../lib/ai/types';
import { executeAgentTask } from './executors.js';

/**
 * WASIT Agent Catalogue — the eleven specialised agents from the spec.
 *
 * Read-only advisory agents run immediately. Agents whose capabilities could
 * touch financial/admin actions are gated behind an explicit human approval
 * (see `requiresHumanApproval`).
 */
export const AGENT_CATALOGUE: AgentDefinition[] = [
  {
    key: 'sales-agent',
    name: 'Sales Agent',
    description: 'Identifies prospective buyers/leads and recommends sales priorities.',
    capabilities: [{ action: 'identify_leads', description: 'Find prospective buyers for a seller' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: true,
  },
  {
    key: 'marketing-agent',
    name: 'Marketing Agent',
    description: 'Recommends marketing content angles and channel mix for campaigns.',
    capabilities: [{ action: 'recommend_campaign', description: 'Draft a marketing campaign proposal' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'ads-agent',
    name: 'Ads Agent',
    description: 'Suggests ad budget allocation and placement strategies.',
    capabilities: [{ action: 'recommend_ads', description: 'Draft an advertising plan' }],
    permissionsRequired: ['ai:use', 'ad:create'],
    requiresHumanApproval: true,
  },
  {
    key: 'product-agent',
    name: 'Product Agent',
    description: 'Analyzes a product listing, pricing, category fit and completeness.',
    capabilities: [{ action: 'analyze_product', description: 'Analyze a product listing' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'support-agent',
    name: 'Support Agent',
    description: 'Drafts a support reply given customer conversation context.',
    capabilities: [{ action: 'draft_reply', description: 'Draft a support response' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'analytics-agent',
    name: 'Analytics Agent',
    description: 'Computes business KPIs from live platform data.',
    capabilities: [{ action: 'generate_report', description: 'Generate a KPI report' }],
    permissionsRequired: ['ai:use', 'analytics:read:own'],
    requiresHumanApproval: false,
  },
  {
    key: 'market-research-agent',
    name: 'Market Research Agent',
    description: 'Provides market overview, category trends and competitive notes.',
    capabilities: [{ action: 'market_overview', description: 'Summarize a market/category' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: false,
  },
  {
    key: 'b2b-agent',
    name: 'B2B Agent',
    description: 'Matches buyers to suppliers and merchants to fulfil B2B needs.',
    capabilities: [{ action: 'match_b2b', description: 'Find B2B partners' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: true,
  },
  {
    key: 'risk-agent',
    name: 'Risk Agent',
    description: 'Assesses risk indicators for an entity or transaction.',
    capabilities: [{ action: 'assess_risk', description: 'Evaluate risk indicators' }],
    permissionsRequired: ['risk:read'],
    requiresHumanApproval: true,
  },
  {
    key: 'dispute-assistant',
    name: 'Dispute Assistant',
    description: 'Summarizes dispute context and recommends possible resolution paths.',
    capabilities: [{ action: 'summarize_dispute', description: 'Summarize dispute context' }],
    permissionsRequired: ['dispute:read'],
    requiresHumanApproval: true,
  },
  {
    key: 'development-agent',
    name: 'Development Agent',
    description: 'Summarizes technical context and recommends implementation steps.',
    capabilities: [{ action: 'dev_plan', description: 'Produce a technical plan' }],
    permissionsRequired: ['ai:use'],
    requiresHumanApproval: true,
  },
];

async function ensureAgentRegistrySeeded(db: DB): Promise<void> {
  const existingKeys = new Set((await db.select().from(agentRegistry)).map((r) => r.key));
  for (const def of AGENT_CATALOGUE) {
    if (existingKeys.has(def.key)) continue;
    await db.insert(agentRegistry).values({
      id: newId(),
      key: def.key,
      name: def.name,
      description: def.description,
      capabilities: def.capabilities as never,
      permissionsRequired: def.permissionsRequired as never,
      requiresHumanApproval: def.requiresHumanApproval,
      inputSchema: (def.inputSchema ?? null) as never,
      isActive: true,
    });
  }
}

export async function listAgents(db: DB): Promise<AgentDefinition[]> {
  await ensureAgentRegistrySeeded(db);
  const rows = await db.select().from(agentRegistry);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description ?? '',
    capabilities: (r.capabilities ?? []) as AgentCapability[],
    permissionsRequired: (r.permissionsRequired ?? []) as string[],
    requiresHumanApproval: r.requiresHumanApproval,
    isActive: r.isActive,
  }));
}

async function getAgentDef(db: DB, agentKey: string): Promise<AgentDefinition> {
  await ensureAgentRegistrySeeded(db);
  const found = AGENT_CATALOGUE.find((a) => a.key === agentKey);
  if (!found) throw ApiError.notFound('Agent');
  return found;
}

/**
 * Per-agent specialised executors live in `./executors.ts`.
 * `executeAgentTask` routes each agent key to its own DB-backed implementation,
 * returning structured results (never mock data).
 */

export async function createAgentTask(
  db: DB,
  role: UserRole[],
  requestedBy: string,
  input: CreateAgentTaskInput,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const agent = await getAgentDef(db, input.agentKey);
  if (!role.includes('ADMIN') && !role.includes('SUPER_ADMIN')) {
    // Secondary guard: every required permission must be present.
    const { ROLE_PERMISSIONS } = await import('@wasit/shared');
    const hasAll = agent.permissionsRequired.every((p) =>
      role.some((r) => (ROLE_PERMISSIONS[r] as ReadonlySet<string>).has(p)),
    );
    if (!hasAll) throw ApiError.forbidden('Agent capability not allowed for your role');
  }

  const requiresApproval = agent.requiresHumanApproval;
  const initialStatus: AgentTaskStatus = requiresApproval ? 'awaiting_approval' : 'queued';

  const id = newId();
  await db.insert(agentTasks).values({
    id,
    agentKey: agent.key,
    requestedBy,
    input: input.input as never,
    status: initialStatus,
    requiresApproval,
    model: 'local-heuristic',
  });

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_CREATED',
    entityType: 'AGENT_TASK',
    entityId: id,
    metadata: { agentKey: agent.key, requiresApproval },
  });

  let status: AgentTaskStatus = initialStatus;
  let result: unknown = null;
  let error: unknown = null;
  let tokensInput = 0;
  let tokensOutput = 0;
  let cost = '0';
  let model = 'local-heuristic';

  if (!requiresApproval) {
    const started = Date.now();
    status = 'running';
    await db.update(agentTasks).set({ status, startedAt: new Date() }).where(eq(agentTasks.id, id));
    try {
      const advice = await executeAgentTask(db, agent, { ...input.input, __userId: requestedBy });
      tokensInput = advice.tokensInput;
      tokensOutput = advice.tokensOutput;
      result = { agentKey: agent.key, advice: advice.content, readOnly: true };
      status = 'succeeded';
      await db
        .update(agentTasks)
        .set({
          status,
          result: result as never,
          tokensInput,
          tokensOutput,
          model,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
        })
        .where(eq(agentTasks.id, id));
      await writeAudit(db, audit, {
        action: 'AI.AGENT_TASK_SUCCEEDED',
        entityType: 'AGENT_TASK',
        entityId: id,
        after: result as never,
      });
    } catch (err) {
      status = 'failed';
      error = { message: err instanceof Error ? err.message : 'Unknown error' };
      await db
        .update(agentTasks)
        .set({ status, error: error as never, errorAt: new Date() })
        .where(eq(agentTasks.id, id));
      await writeAudit(db, audit, {
        action: 'AI.AGENT_TASK_FAILED',
        entityType: 'AGENT_TASK',
        entityId: id,
        metadata: { error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }

  return {
    id,
    agentKey: agent.key,
    requestedBy,
    input: input.input,
    status,
    result,
    error,
    requiresApproval,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    tokensInput,
    tokensOutput,
    cost,
    model,
    latencyMs: 0,
    createdAt: new Date(),
  };
}

/** Lists the current user's tasks, newest first. */
export async function listMyTasks(db: DB, userId: string): Promise<ResolvedAgentTask[]> {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.requestedBy, userId))
    .orderBy(desc(agentTasks.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    agentKey: r.agentKey,
    requestedBy: r.requestedBy,
    input: (r.input ?? {}) as never,
    status: r.status as AgentTaskStatus,
    result: r.result,
    error: r.error,
    requiresApproval: r.requiresApproval,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    cost: r.cost,
    model: r.model,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  }));
}

export async function getTask(db: DB, taskId: string): Promise<ResolvedAgentTask> {
  const rows = await db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  if (rows.length === 0) throw ApiError.notFound('Agent task');
  const r = rows[0];
  return {
    id: r.id,
    agentKey: r.agentKey,
    requestedBy: r.requestedBy,
    input: (r.input ?? {}) as never,
    status: r.status as AgentTaskStatus,
    result: r.result,
    error: r.error,
    requiresApproval: r.requiresApproval,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt,
    rejectionReason: r.rejectionReason,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    cost: r.cost,
    model: r.model,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  };
}

/** Approves (or rejects) a task awaiting approval. Performs the run afterwards. */
export async function decideAgentTask(
  db: DB,
  taskId: string,
  approverId: string,
  decision: 'APPROVE' | 'REJECT',
  reason: string | null,
  audit: { actorId: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<ResolvedAgentTask> {
  const task = await getTask(db, taskId);
  if (task.status !== 'awaiting_approval') {
    throw ApiError.conflict('Task is not awaiting approval');
  }

  if (decision === 'REJECT') {
    await db
      .update(agentTasks)
      .set({ status: 'rejected', approvedBy: approverId, approvedAt: new Date(), rejectionReason: reason })
      .where(eq(agentTasks.id, taskId));
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_REJECTED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: { reason },
    });
    return getTask(db, taskId);
  }

  await db
    .update(agentTasks)
    .set({ status: 'running', approvedBy: approverId, approvedAt: new Date(), startedAt: new Date() })
    .where(eq(agentTasks.id, taskId));

  await writeAudit(db, audit, {
    action: 'AI.AGENT_TASK_APPROVED',
    entityType: 'AGENT_TASK',
    entityId: taskId,
    metadata: { reason },
  });

  const agent = await getAgentDef(db, task.agentKey);
  const started = Date.now();
  try {
    const advice = await executeAgentTask(db, agent, { ...task.input, __userId: approverId });
    const result = { agentKey: agent.key, advice: advice.content, readOnly: true };
    await db
      .update(agentTasks)
      .set({
        status: 'approved',
        result: result as never,
        tokensInput: advice.tokensInput,
        tokensOutput: advice.tokensOutput,
        model: 'local-heuristic',
        completedAt: new Date(),
        latencyMs: Date.now() - started,
      })
      .where(eq(agentTasks.id, taskId));
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_COMPLETED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      after: result as never,
    });

    // Notify the requester that their task is complete.
    await createNotification(db, {
      userId: task.requestedBy,
      type: 'AI.AGENT_TASK_COMPLETED',
      title: `Agent ${agent.key}`,
      body: 'Your agent task has been approved and completed.',
      data: { taskId },
    });
    return getTask(db, taskId);
  } catch (err) {
    const error = { message: err instanceof Error ? err.message : 'Unknown error' };
    await db
      .update(agentTasks)
      .set({ status: 'failed', error: error as never, errorAt: new Date() })
      .where(eq(agentTasks.id, taskId));
    await writeAudit(db, audit, {
      action: 'AI.AGENT_TASK_FAILED',
      entityType: 'AGENT_TASK',
      entityId: taskId,
      metadata: error,
    });
    return getTask(db, taskId);
  }
}