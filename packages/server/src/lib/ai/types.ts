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

export interface AgentDefinition {
  key: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  permissionsRequired: string[];
  /** Sensitive tasks (financial/admin mutations) need an explicit human approval. */
  requiresHumanApproval: boolean;
  inputSchema?: Record<string, unknown>;
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