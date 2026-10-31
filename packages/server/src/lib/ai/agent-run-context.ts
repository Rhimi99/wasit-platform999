import { AsyncLocalStorage } from 'node:async_hooks';
import Decimal from 'decimal.js';
import type { UserRole } from '@wasit/shared';

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
   * the runner from trusted catalogue metadata — never from task `input`. It is
   * a *grant list*, not an enforcement: each operation must still call
   * {@link requireAction} at its own boundary. Absent means "no grant" and the
   * gate refuses, so a context that omits it can never widen access.
   */
  readonly authorizedActions?: readonly string[];
  /**
   * The registered Tool Gateway tools this run is bound to, set by the runner
   * from the agent's catalogue `allowedTools` intersected with the tool registry
   * (never from task `input`). The gateway calls `requireAction(toolId, 'tools')`:
   * a tool not in this list is refused, and a declared-but-unregistered id is
   * inert. Absent means "no tools granted", so the gateway refuses every tool.
   */
  readonly allowedTools?: readonly string[];
  /**
   * The user id that requested this run, set by the runner from the stored task
   * row (`requestedBy`) — never from task `input`. The Tool Gateway resolves the
   * requester's roles from the database against THIS id, so a caller cannot
   * forge the principal a tool executes as.
   */
  readonly requestedBy?: string;
  /**
   * The roles the runner resolved for `requestedBy` at execution time (from the
   * database, or the trusted scheduler principal's own roles). Used by the Tool
   * Gateway as the RBAC basis. Absent means "no roles" and every role-gated
   * check refuses.
   */
  readonly requesterRoles?: readonly UserRole[];
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

/** Which trusted grant list a {@link requireAction} boundary consults. */
export type ActionScope = 'actions' | 'tools';

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
 *
 * The grant list is ALWAYS read from the trusted run context; it is never
 * accepted as an argument. `scope` selects which trusted list to consult — the
 * capability grant list (`authorizedActions`, the default) or the Tool Gateway
 * tool list (`allowedTools`). Because the only thing a caller can pass is a
 * named selector and not an array, a caller cannot forge a grant list to widen
 * its own authority.
 */
export function requireAction(actionId: string, scope: ActionScope = 'actions'): void {
  const ctx = agentRunStorage.getStore();
  if (!ctx) {
    throw new ActionNotAuthorizedError(actionId);
  }
  const list = scope === 'tools' ? ctx.allowedTools : ctx.authorizedActions;
  if (!Array.isArray(list) || !list.includes(actionId)) {
    throw new ActionNotAuthorizedError(actionId);
  }
}

/**
 * Merges the trusted task identity into AI request metadata.
 *
 * `taskId` is always taken from the trusted run context. A caller-supplied
 * `taskId` is overwritten when a task is running and deleted otherwise, so a
 * forged `metadata.taskId` can never attribute a request to a task — and a
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

/**
 * Accumulator for the money spent inside a single agent run.
 *
 * The runner creates exactly one per run, binds it to the trusted run context
 * (so it is reachable from `runAIFeature` without being threaded through every
 * executor signature), and reads it back when the run finishes. Because it lives
 * on the per-execution context rather than in a module global, two concurrent
 * runs never share a counter.
 *
 * A retry is seeded with the cost already recorded for the task, so the ceiling
 * bounds the *whole* task across attempts — a retry cannot reset the counter and
 * spend the cap again.
 *
 * Enforcement is reservation-based rather than check-then-act. Before a provider
 * call the caller reserves the call's conservative estimate; the reservation is
 * an atomic (synchronous) add, so two calls in flight at once cannot both slip
 * under the same remaining headroom — the second is refused before it reaches
 * the provider. After the call the reservation is settled to the *measured* cost
 * (replacing the estimate), so the counter always reflects real spend.
 */
export class AgentRunBudget {
  /** Reserved-then-settled spend, as an exact decimal. */
  private spent: Decimal;
  /** Provider calls reserved against this run. */
  private calls = 0;

  constructor(
    /** Per-run ceiling in USD, or `null` when no finite cap applies (uncapped). */
    readonly maxCostUsd: Decimal | null,
    /** Cost already spent by earlier attempts of the same task (retry carry-over). */
    initialSpentUsd: Decimal = new Decimal(0),
  ) {
    this.spent = initialSpentUsd;
  }

  get spentUsd(): Decimal {
    return this.spent;
  }

  get callCount(): number {
    return this.calls;
  }

  /**
   * Atomically reserves `estimateUsd` for an imminent provider call.
   *
   * Returns `false` (and reserves nothing) when the estimate would push the run
   * past `maxCostUsd`, so the caller must abort *before* reaching the provider.
   * A `null` ceiling is uncapped and always reserves. Because this is a
   * synchronous check-and-add, two concurrent calls cannot both consume the same
   * remaining headroom.
   */
  reserve(estimateUsd: Decimal): boolean {
    if (this.maxCostUsd !== null && this.spent.plus(estimateUsd).gt(this.maxCostUsd)) {
      return false;
    }
    this.spent = this.spent.plus(estimateUsd);
    this.calls += 1;
    return true;
  }

  /**
   * Releases a reservation for a call that never reached the provider (or whose
   * outcome is unknown). Without this, a failed call would wrongly consume the
   * budget it never spent.
   */
  release(estimateUsd: Decimal): void {
    this.spent = this.spent.minus(estimateUsd);
    this.calls = Math.max(0, this.calls - 1);
  }

  /**
   * Settles a reservation to the measured cost of the completed call.
   *
   * The estimate is replaced by `actualUsd` (never added on top of it), so the
   * measured cost is recorded exactly once and never double-counted. Returns
   * `false` when the settled total exceeds `maxCostUsd`: the money is still
   * spent and still counted — only the return value flags that the run must be
   * refused and no further call permitted.
   */
  settle(estimateUsd: Decimal, actualUsd: Decimal): boolean {
    this.spent = this.spent.minus(estimateUsd).plus(actualUsd);
    return this.maxCostUsd === null || this.spent.lte(this.maxCostUsd);
  }
}

/** Per-execution budget store, kept separate so it can be set/cleared independently. */
const agentBudgetStorage = new AsyncLocalStorage<AgentRunBudget>();

/** Runs `fn` with `budget` visible to every AI call it awaits. */
export function withAgentRunBudget<T>(budget: AgentRunBudget, fn: () => Promise<T>): Promise<T> {
  return agentBudgetStorage.run(budget, fn);
}

/** The current run's budget accumulator, or `undefined` outside an agent run. */
export function getAgentRunBudget(): AgentRunBudget | undefined {
  return agentBudgetStorage.getStore();
}

/** Thrown when a run's per-run cost ceiling is exceeded mid-execution. */
export class AgentRunBudgetExceededError extends Error {
  readonly code = 'RUN_BUDGET_EXCEEDED';
  constructor(
    readonly maxCostUsd: string,
    readonly spentUsd: string,
  ) {
    super(`Agent run cost ceiling exceeded (spent ${spentUsd} > cap ${maxCostUsd} USD)`);
    this.name = 'AgentRunBudgetExceededError';
  }
}

/**
 * Thrown when the measured cost of a completed provider call could not be
 * persisted to the ledger.
 *
 * The provider has already been paid, so the run must not continue as if the
 * cost were zero and must not report success. The error is retryable so the
 * caller's retry re-enters the ledger path with the correct spend.
 */
export class AgentCostRecordingError extends Error {
  readonly code = 'RUN_COST_NOT_RECORDED';
  constructor(
    readonly costUsd: string,
    readonly cause?: string,
  ) {
    super(`Agent run cost could not be recorded (unrecorded ${costUsd} USD)`);
    this.name = 'AgentCostRecordingError';
  }
}
