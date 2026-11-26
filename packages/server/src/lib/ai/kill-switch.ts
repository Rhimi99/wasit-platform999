import type { DB } from '../../db/client';
import { setGlobalSwitch } from './execution-switch';
import {
  assertExecutionAllowed,
  isExecutionBlocked,
  readExecutionSwitchState,
  type ExecutionSwitchState,
} from './execution-switch';

/**
 * Central AI Kill Switch — compatibility surface over the fleet-wide store.
 *
 * The authority is the `ai_execution_switches` table (see `execution-switch.ts`),
 * read at the moment of execution. Nothing is cached in the process: a stop
 * committed on one instance is observed by every other instance on its very next
 * attempt, and it survives a restart.
 *
 * Scope: this is a *subsystem* stop, not a permission. It grants no authority
 * and replaces nothing: RBAC, agent permissions, human approvals, cost budgets,
 * the tool gateway and audit all still apply on top of it.
 */
export const AI_EXECUTION_DISABLED_MESSAGE =
  'AI execution is currently disabled by the central kill switch';

/**
 * The single guard every execution entry point awaits before it starts work.
 * Throws `ApiError.serviceUnavailable` (503) when the global switch is off, the
 * agent is paused, or the control store cannot be read (fail-closed).
 */
export async function assertAiExecutionEnabled(db: DB, agentKey?: string | null): Promise<void> {
  await assertExecutionAllowed(db, agentKey);
}

/** True when AI execution is currently blocked (fail-closed on any error). */
export async function isAiExecutionBlocked(db: DB, agentKey?: string | null): Promise<boolean> {
  return isExecutionBlocked(db, agentKey);
}

/** The audit-free predicate a caller uses to decide whether to attempt work. */
export async function isAiExecutionEnabled(db: DB, agentKey?: string | null): Promise<boolean> {
  return !(await isExecutionBlocked(db, agentKey));
}

/** The current effective state plus its source, for admin/GM read surfaces. */
export async function getAiExecutionSwitchState(db: DB): Promise<ExecutionSwitchState> {
  return readExecutionSwitchState(db);
}

/**
 * Direct writer for the GLOBAL switch, for test setup and operational scripts.
 * `null`/`true` open the switch, `false` stops it. It writes the same persisted
 * row the API writes — there is no in-process override to bypass the store.
 */
export async function setAiExecutionEnabled(db: DB, enabled: boolean | null): Promise<void> {
  await setGlobalSwitch(db, {
    stopped: enabled === false,
    reason: enabled === false ? 'set by test/ops helper' : null,
    actorId: 'system:switch-helper',
  });
}
