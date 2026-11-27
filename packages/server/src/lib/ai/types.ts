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
  /**
   * Set to 'VENDOR' only when the response itself carried a billed amount. The
   * runtime then records the cost as vendor-reported instead of an estimate;
   * omitting it means the catalogue price is an estimate and is labelled so.
   */
  costSource?: 'VENDOR';
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
 * Objectives are DECLARATIVE ONLY: they name the goal and the metric an operator
 * should watch. They do not gate execution, grant permissions, widen a data
 * scope or change the task state machine. An agent without objectives keeps
 * working exactly as before.
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

/** Data-access scope an agent's contract declares. */
export type AgentDataScopeKind = 'own' | 'platform';

/**
 * The organisational identity of a specialised agent.
 *
 * Every field added here is OPTIONAL so the existing eleven executable agents —
 * whose definitions predate the organisational layer — stay valid unchanged.
 * These fields are metadata: they describe the agent to humans and to the
 * registry, and grant nothing on their own. Execution authority continues to
 * come from `capabilities` (via `requireAction`) and from the A2 scope contract,
 * never from a catalogue string.
 */
/**
 * Position of an agent in the official WASIT AI structure.
 *
 * - `CORE_SPECIALIST` — one of the twelve official specialist agents. Exactly
 *   twelve entries may carry this tier; the ordered list lives in
 *   `CORE_SPECIALIST_KEYS` (catalogue.ts).
 * - `SUPPORTING` — an internal function agent that is not one of the twelve and
 *   must not be presented as one.
 * - `GOVERNANCE` — the oversight supervisor and the coordinating Copilot: layers
 *   of supervision/coordination, never specialised agents.
 */
export type AgentTier = 'CORE_SPECIALIST' | 'SUPPORTING' | 'GOVERNANCE';

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  permissionsRequired: string[];
  /** Registry row id when the agent is registered (read paths only). */
  id?: string;
  /** Registry lifecycle (ACTIVE | PAUSED | DISABLED), when registered. */
  status?: string;
  /** Whether the registered agent is active (false = paused/disabled). */
  isActive?: boolean;
  /** Sensitive tasks (financial/admin mutations) need an explicit human approval. */
  requiresHumanApproval: boolean;
  inputSchema?: Record<string, unknown>;

  /** Arabic display name (organisational metadata). */
  nameAr?: string;
  /** One-line mission statement — why the agent exists. */
  mission?: string;
  /** Department/team bucket: growth | operations | insight | trust | finance | network | platform | oversight | coordination. */
  category?: string;
  /** Official position in the WASIT AI structure (see {@link AgentTier}). */
  tier?: AgentTier;
  /**
   * Declared data-source allow-list. In R1 this is DECLARATIVE ONLY: no Tool
   * Gateway is bound on this branch, so listing a tool grants nothing and runs
   * nothing. It records which data sources the agent is *intended* to reach.
   */
  allowedTools?: string[];
  /** Actions from this agent that require an explicit human approval first. */
  approvalActions?: string[];
  /** Deterministic per-run limits (cost, fanout, daily quotas, interval). */
  limits?: Record<string, number | string | boolean>;
  /** Task types this agent is designed to handle. */
  taskTypes?: string[];
  /** Declarative measurable objectives (see {@link AgentObjective}). */
  objectives?: AgentObjective[];
  /** `own` restricts the agent to the caller's entities; `platform` allows aggregates. */
  scope?: AgentDataScopeKind;
  /** When true, a caller without platform-analytics permission is refused outright. */
  requiresPlatformScope?: boolean;
  /** Coordinator layer — not counted among the specialised agents. */
  isCopilot?: boolean;
  /** Oversight agent — organisational identity only, never write authority. */
  isSupervisor?: boolean;
  /**
   * True only for agents that have a real executor wired into
   * `executeAgentTask`. A catalogue entry with `executable: false` is
   * organisational metadata: it exists, it is described, it cannot run.
   */
  executable?: boolean;
}

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected';

export interface CreateAgentTaskInput {
  agentKey: string;
  requestedBy: string;
  input: Record<string, unknown>;
  requestedModel?: string;
}

export interface ResolvedAgentTask {
  id: string;
  agentKey: string;
  requestedBy: string;
  input: Record<string, unknown>;
  status: AgentTaskStatus;
  result: unknown;
  error: unknown;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  model: string;
  latencyMs: number;
  createdAt: Date;
}