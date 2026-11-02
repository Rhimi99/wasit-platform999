/** Unified, provider-agnostic result of an AI feature call. */
export interface AIFeatureResult {
  kind: string;
  model: string;
  recommendation?: unknown;
  confidence: number;
  reasoning: string[];
  data?: unknown;
  requiresApproval?: boolean;
  estimatedCost: string;
}

export interface AIProviderCallOptions {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  budgetPeriod: string;
  /**
   * The catalogue model key the router selected. Adapters must send this to the
   * vendor instead of their constructor default, otherwise routing a capability
   * to a different model silently keeps calling the default one.
   */
  model?: string;
}

export interface AIProviderCallResult {
  content: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  currencyCode: string;
}

/**
 * AI Provider contract — any backend (OpenAI, Anthropic, local heuristics,
 * test harness) can implement this. The AI Core never ties to a concrete vendor.
 */
export interface AIProvider {
  readonly id: string;
  /** Returns true when this provider can serve calls right now. */
  isAvailable(): boolean;
  call(opts: AIProviderCallOptions): Promise<AIProviderCallResult>;
}

export interface AgentCapability {
  action: string;
  description: string;
  requiresApproval?: boolean;
}

/**
 * A single measurable objective for an agent (the "digital employee" contract).
 *
 * Objectives are declarative only: they name the goal and the metric an operator
 * should watch. Nothing here executes, mutates state or widens an agent's
 * permissions — `metric` is the key a future metrics recorder will aggregate
 * (outcome / latency / volume), and `target` the value to compare it against.
 */
export interface AgentObjective {
  /** Stable slug, unique within the agent (e.g. `sales.qualified_leads`). */
  id: string;
  /** Human-readable goal statement. */
  statement: string;
  /** Metric key the objective is measured by. */
  metric: string;
  /** Numeric target the metric is compared against. */
  target: number;
  /** Unit of the target: count | ratio | ms | TND | percent. */
  unit: 'count' | 'ratio' | 'ms' | 'TND' | 'percent';
  /** Whether the agent should push the metric up or down. */
  direction: 'increase' | 'decrease';
  /** Aggregation window the target applies to. */
  window: 'per_task' | 'daily' | 'weekly' | 'monthly';
}

export interface AgentDefinition {
  key: string;
  name: string;
  nameAr?: string;
  mission?: string;
  category?: string;
  description: string;
  capabilities: AgentCapability[];
  /** Declarative tool allow-list — an executor may only reach data via these. */
  allowedTools: string[];
  /** Actions from this agent that require an explicit human approval first. */
  approvalActions: string[];
  /** Deterministic per-run limits (cost, fanout, daily quotas, interval). */
  limits: Record<string, number | string | boolean>;
  /** Task types this agent is designed to handle. */
  taskTypes: string[];
  /**
   * Optional measurable objectives (digital-employee contract). Declarative
   * only — they document what the agent is accountable for and which metric an
   * operator watches. They do not gate execution, grant permissions or change
   * the task state machine; agents without objectives keep working unchanged.
   */
  objectives?: AgentObjective[];
  permissionsRequired: string[];
  /**
   * Data-access scope, enforced by the runner before a task is created and again
   * before it runs. `own` (the default) restricts the executor to the caller's
   * own entities; `platform` permits platform-wide aggregates and is granted only
   * to roles holding a platform-analytics permission.
   */
  scope?: 'own' | 'platform';
  /**
   * When true, a caller without platform-analytics permission is refused
   * outright rather than degraded to an own-scope view — used by agents whose
   * only meaningful output is a platform-wide aggregate.
   */
  requiresPlatformScope?: boolean;
  /** Sensitive tasks (financial/admin mutations) need an explicit human approval. */
  requiresHumanApproval: boolean;
  /** Coordinator layer — not counted among the 20 specialised agents. */
  isCopilot?: boolean;
  /** Oversight agent — a deterministic guardrail, not a model-driven executor. */
  isSupervisor?: boolean;
  inputSchema?: Record<string, unknown>;
}

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'blocked';

export interface CreateAgentTaskInput {
  agentKey: string;
  taskType?: string;
  input: Record<string, unknown>;
  /** Legacy baggage field; the authoritative requester is the argument to createAgentTask. */
  requestedBy?: string;
  requestedModel?: string;
  /** Idempotency: a second enqueue with the same open key returns the first. */
  dedupeKey?: string;
  correlationId?: string;
  priority?: number;
  triggeredBy?: string;
  scheduledFor?: Date;
}

export interface ResolvedAgentTask {
  id: string;
  agentKey: string;
  requestedBy: string;
  taskType: string | null;
  input: Record<string, unknown>;
  status: AgentTaskStatus;
  result: unknown;
  error: unknown;
  requiresApproval: boolean;
  approvalAction: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  dedupeKey: string | null;
  correlationId: string | null;
  triggeredBy: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  scheduledFor: Date | null;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  model: string;
  latencyMs: number;
  createdAt: Date;
}