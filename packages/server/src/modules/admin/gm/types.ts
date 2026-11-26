import type { AgentDefinition } from '../../../lib/ai/types.js';
import type { AgentLayerCounts } from '../../ai/catalogue.js';
import type { CompanyMetrics, AgentHealth } from '../../ai/agent-metrics.js';
import type { SupervisorOverview } from '../../ai/supervisor.js';
import type { CopilotReport } from '../../ai/copilot/types.js';
import type { SpendOverview } from '../../../lib/ai/spend-limits.js';
import type { SpendGuardState } from '../../../lib/ai/spend-guard.js';
import type { MaskedProvider } from '../../../lib/ai/provider-config.js';

/**
 * The GM command center contract (WASIT-GM-DASHBOARD-01).
 *
 * Every section is wrapped in {@link Section}: a dashboard must survive one
 * failing source instead of blanking the page, and it must be able to say "I
 * could not read this" instead of rendering a zero. `null` inside `data` means
 * the value is genuinely unknown; `0` is only ever a measured zero.
 */

export type SectionState = 'OK' | 'UNAVAILABLE';

export interface Section<T> {
  state: SectionState;
  /** The tables/services the numbers came from, shown in the UI. */
  source: string;
  generatedAt: string;
  data: T | null;
  /** Operator-readable reason, never a stack trace or a credential. */
  error: string | null;
}

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface HealthCheck {
  key: string;
  state: HealthState;
  /** What was actually checked, in words a GM can read. */
  detail: string;
  /** false when the state is an inference rather than a live probe. */
  probed: boolean;
  checkedAt: string;
}

/** One agent as the command center shows it. */
export interface GmAgentRow {
  key: string;
  name: string;
  nameAr: string | null;
  mission: string | null;
  category: string | null;
  tier: string | null;
  active: boolean;
  status: string | null;
  requiresHumanApproval: boolean;
  approvalActions: string[];
  permissionsRequired: string[];
  allowedTools: string[];
  /**
   * `llm` — the executor calls the unified generation path.
   * `deterministic` — the executor produces its analysis from SQL only.
   * `none` — declared in the catalogue but has no executor.
   */
  generation: 'llm' | 'deterministic' | 'none';
  generationCapability: string | null;
  execution: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    running: number;
    successRate: number | null;
  };
  cost: {
    available: boolean;
    requests: number;
    actualCostUsd: string | null;
    tokensInput: number;
    tokensOutput: number;
  };
  limit: {
    configured: boolean;
    maxCost: string | null;
    warnRatio: string | null;
  };
  health: AgentHealth;
  healthReason: string;
  lastActivityAt: string | null;
}

export interface GmAgentsData {
  items: GmAgentRow[];
  counts: AgentLayerCounts;
  company: Pick<CompanyMetrics, 'overall' | 'attention' | 'dataFreshness' | 'notes' | 'window'>;
  /** Explicit split, so the UI cannot present a deterministic agent as generative. */
  generativeAgents: string[];
  deterministicAgents: string[];
  noExecutorAgents: string[];
}

export interface GmCopilotData {
  items: CopilotReport[];
  totals: {
    total: number;
    succeeded: number;
    failed: number;
    awaiting: number;
    running: number;
  };
  /** How many recent requests the `items` list holds (totals cover all). */
  recentLimit: number;
}

export interface GmSupervisorData {
  overview: SupervisorOverview;
  alerts: {
    firing: number;
    items: Array<{
      id: string;
      rule: string;
      severity: string;
      status: string;
      summary: string;
      startedAt: string;
      resolvedAt: string | null;
    }>;
  };
}

export interface GmTaskRow {
  id: string;
  kind: 'agent_task' | 'copilot_run';
  agentKey: string;
  title: string | null;
  status: string;
  taskType: string | null;
  requestedBy: string;
  runId: string | null;
  severity: 'high' | 'medium' | 'low';
  cost: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface GmTasksData {
  items: GmTaskRow[];
  totals: {
    total: number;
    queued: number;
    running: number;
    awaitingApproval: number;
    completed: number;
    failed: number;
    cancelled: number;
    overdue: number;
  };
  page: number;
  pageSize: number;
}

export interface ApprovalItem {
  id: string;
  kind: 'agent_task' | 'run_step';
  agentKey: string;
  action: string;
  title: string;
  requestedBy: string;
  requestedAt: string;
  ageMinutes: number;
  risk: 'high' | 'medium' | 'low';
  evidence: string[];
  runId: string | null;
  stepKey: string | null;
  /** Why this needs a human at all. */
  reason: string;
  /** True when the viewer may not decide it (their own request). */
  selfApprovalBlocked: boolean;
  /** False when no other authorised approver exists in the platform. */
  independentApproverAvailable: boolean;
  state: 'PENDING' | 'BLOCKED_PENDING_INDEPENDENT_APPROVER';
}

export interface GmApprovalsData {
  items: ApprovalItem[];
  blocked: number;
  /** Roles that can decide an approval, resolved from RBAC, not hardcoded. */
  approverRoles: string[];
}

export interface GmProvidersData {
  environment: string;
  liveTestAllowed: boolean;
  secretStorage: { available: boolean; reason: string | null };
  items: MaskedProvider[];
}

export interface GmSpendingData {
  overview: SpendOverview;
  guard: SpendGuardState;
}

export interface GmHealthData {
  overall: HealthState;
  items: HealthCheck[];
}

export interface GmAuditRow {
  id: string;
  action: string;
  actorId: string | null;
  entityType: string;
  entityId: string | null;
  createdAt: string;
}

export interface GmAuditData {
  items: GmAuditRow[];
  page: number;
  pageSize: number;
}

export interface GmPlatformData {
  killSwitch: { enabled: boolean; source: 'runtime' | 'env' };
  /** Each block is null when its source section was unavailable. */
  agents: { total: number; active: number; generative: number; noExecutor: number } | null;
  tasks: { queued: number; running: number; awaitingApproval: number; failed24h: number } | null;
  copilot: { total: number; failed: number; awaiting: number } | null;
  approvalsPending: number | null;
  approvalsBlocked: number | null;
  alertsFiring: number | null;
  providers: { total: number; enabled: number; withKey: number } | null;
  spend24h: { costUsd: string | null; requests: number } | null;
  lastActivityAt: string | null;
}

export interface GmOverview {
  generatedAt: string;
  environment: string;
  window: { days: number; from: string; to: string };
  viewer: { id: string; roles: string[]; canDecideApprovals: boolean };
  sections: {
    platform: Section<GmPlatformData>;
    agents: Section<GmAgentsData>;
    copilot: Section<GmCopilotData>;
    supervisor: Section<GmSupervisorData>;
    tasks: Section<GmTasksData>;
    approvals: Section<GmApprovalsData>;
    providers: Section<GmProvidersData>;
    spending: Section<GmSpendingData>;
    health: Section<GmHealthData>;
    audit: Section<GmAuditData>;
  };
}

/** Catalogue entry as the API returns it (identity only, no authority). */
export type GmAgentDefinition = AgentDefinition;
