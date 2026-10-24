import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Trusted identity of the agent task currently executing.
 *
 * Set once by the runner (`withAgentRunContext`) around a single
 * `executeAgentTask` call and read by `runAIFeature` so every AI request a task
 * issues can be attributed back to that task. It is never derived from task
 * `input`, so a caller cannot forge it.
 */
export interface AgentRunContext {
  readonly taskId: string;
  readonly agentKey: string;
  /**
   * The task type this run is executing, set by the runner from the stored task
   * row (never from `input`). Lets an executor select a path — e.g. the
   * Development Agent's read-only plan vs its isolated repair path — without
   * trusting a caller-supplied value.
   */
  readonly taskType?: string;
  /**
   * Per-run cost cap (USD) resolved by the runner from the agent's declarative
   * `limits.maxCostUsdPerRun`, falling back to the runner default. Carried as a
   * string so the exact decimal reaches the reservation layer without a float
   * round-trip. Absent means no per-run cap was declared.
   */
  readonly runCapUsd?: string;
  /** The task attempt this execution belongs to (audit only). */
  readonly attempt?: number;
  /**
   * The bounded set of action ids this run is authorised to perform, derived by
   * the runner from trusted catalogue metadata â€” never from task `input`. It is
   * a *grant list*, not an enforcement: each operation must still call
   * {@link requireAction} at its own boundary. Absent means "no grant" and the
   * gate refuses, so a context that omits it can never widen access.
   */
  readonly authorizedActions?: readonly string[];
}

/**
 * Per-async-execution store. `AsyncLocalStorage` scopes the value to the
 * callback it wraps, so concurrent tasks running on the same process each see
 * their own context and it expires the moment `runTask` returns.
 */
const agentRunStorage = new AsyncLocalStorage<AgentRunContext>();

/** Runs `fn` with the given task identity visible to everything it awaits. */
export function withAgentRunContext<T>(ctx: AgentRunContext, fn: () => Promise<T>): Promise<T> {
  return agentRunStorage.run(ctx, fn);
}

/** The current task identity, or `undefined` outside an agent task run. */
export function getAgentRunContext(): AgentRunContext | undefined {
  return agentRunStorage.getStore();
}

/** Thrown by {@link requireAction} when an operation is not authorised. */
export class ActionNotAuthorizedError extends Error {
  readonly actionId: string;
  readonly code = 'ACTION_NOT_AUTHORIZED';
  constructor(actionId: string) {
    super(`Action not authorized: ${actionId}`);
    this.name = 'ActionNotAuthorizedError';
    this.actionId = actionId;
  }
}

/**
 * The trusted action-authorization gate for an operation boundary.
 *
 * An executor calls this with the **literal** action id of the operation it is
 * about to perform (e.g. `requireAction('supplier.get_owned')`). The id is a
 * code literal, never task `input`, so a caller cannot name an action the run
 * was not granted. It fails closed: an absent run context, an absent/empty
 * grant list, or an id that is not in the list all throw before the operation
 * runs. Being present in the registry is *not* sufficient — only membership in
 * this run's server-derived grant list authorizes execution.
 */
export function requireAction(actionId: string): void {
  const ctx = agentRunStorage.getStore();
  if (!ctx) {
    throw new ActionNotAuthorizedError(actionId);
  }
  const granted = ctx.authorizedActions;
  if (!Array.isArray(granted) || !granted.includes(actionId)) {
    throw new ActionNotAuthorizedError(actionId);
  }
}

/**
 * Merges the trusted task identity into AI request metadata.
 *
 * `taskId` is always taken from the trusted run context. A caller-supplied
 * `taskId` is overwritten when a task is running and deleted otherwise, so a
 * forged `metadata.taskId` can never attribute a request to a task â€” and a
 * request made outside any task never carries one.
 */
export function mergeAgentTaskMetadata(
  metadata: Record<string, unknown> | undefined,
  ctx: AgentRunContext | undefined,
): Record<string, unknown> {
  const merged = { ...(metadata ?? {}) };
  if (ctx?.taskId) {
    merged.taskId = ctx.taskId;
  } else {
    delete merged.taskId;
  }
  return merged;
}
