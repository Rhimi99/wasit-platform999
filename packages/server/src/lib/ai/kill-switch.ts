import { ApiError } from '@wasit/shared';
import { env } from '../env';

/**
 * Central AI Kill Switch (A1).
 *
 * ONE process-global gate that every AI-execution entry point consults before
 * it starts or continues work. It is deliberately independent of the LLM: it is
 * a plain in-memory boolean, so it works with no provider, no DB round-trip and
 * no model call — the emergency stop must never depend on the thing it stops.
 *
 * Fail-closed: `isAiExecutionEnabled()` returns `false` only for an explicit
 * disable. A resolution error (a bug in the resolver) also yields `false`, so a
 * broken check can never silently allow execution. Callers that need to *start*
 * or *continue* work use `assertAiExecutionEnabled()`, which throws
 * `ApiError.serviceUnavailable` (503) with a stable code so every surface —
 * API, scheduler, supervisor, recovery — refuses uniformly and observably.
 *
 * Scope: this is a *subsystem* stop, not a permission. It grants no authority
 * and replaces nothing: RBAC, agent permissions, human approvals, cost budgets,
 * the (future) Tool Gateway and audit all still apply on top of it.
 *
 * Durability: the switch is process-global, so it stops every entry point in
 * the same process (API requests, the in-process scheduler, supervisor and
 * recovery cycles). It is intentionally NOT persisted: this task may not add a
 * migration/table. A multi-instance deployment therefore needs a shared store
 * (DB-backed flag) to make the stop fleet-wide — that remainder is documented
 * as BLOCKED in `docs/AI_KILL_SWITCH.md`. Until then, the in-process gate is
 * authoritative per instance and the env flag seeds the initial state.
 */

export const AI_EXECUTION_DISABLED_MESSAGE =
  'AI execution is currently disabled by the central kill switch';

let runtimeOverride: boolean | null = null;

/**
 * Resolves the effective state. Precedence: an explicit runtime override
 * (set via the admin control) wins; otherwise the environment default
 * (`AI_AGENT_EXECUTION_ENABLED`, default `true`). Any unexpected failure fails
 * closed.
 */
function resolveEnabled(): boolean {
  try {
    if (runtimeOverride !== null) return runtimeOverride;
    return env.AI_AGENT_EXECUTION_ENABLED !== false;
  } catch {
    // Fail closed: if the flag cannot be resolved, refuse to execute.
    return false;
  }
}

/**
 * True when AI execution is allowed. Fail-closed: only an explicit disable (or
 * an unreadable flag) returns false.
 */
export function isAiExecutionEnabled(): boolean {
  return resolveEnabled();
}

/** True when the emergency stop is active. */
export function isAiExecutionDisabled(): boolean {
  return !resolveEnabled();
}

/**
 * The single guard every execution entry point calls. Throws a 503 with a
 * stable `SERVICE_UNAVAILABLE` code and a clear, user-facing reason when the
 * switch is off. Callers do NOT audit here — auditing is the responsibility of
 * the surface that owns the attempt (so a sweep is not audited per scanned row).
 */
export function assertAiExecutionEnabled(): void {
  if (!resolveEnabled()) {
    throw ApiError.serviceUnavailable(AI_EXECUTION_DISABLED_MESSAGE);
  }
}

/**
 * The audit-free predicate a caller uses to *decide* whether to attempt work,
 * so it can record its own "refused" audit entry exactly once (rather than
 * relying on a thrown error). Equivalent to `isAiExecutionEnabled`.
 */
export function isAiExecutionBlocked(): boolean {
  return !resolveEnabled();
}

/**
 * Sets the runtime override. `null` clears the override and falls back to the
 * environment default. Used by the admin enable/disable control and by tests.
 */
export function setAiExecutionEnabled(enabled: boolean | null): void {
  runtimeOverride = enabled;
}

/** The current effective state plus its source, for the admin status surface. */
export function getAiExecutionSwitchState(): {
  enabled: boolean;
  source: 'runtime' | 'env';
} {
  return {
    enabled: resolveEnabled(),
    source: runtimeOverride !== null ? 'runtime' : 'env',
  };
}
