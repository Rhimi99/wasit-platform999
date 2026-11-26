import { and, eq } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import { platformDb, type DB } from '../../db/client';
import { agentTasks } from '../../db/schema/agents';
import { aiExecutionSwitches } from '../../db/schema/ai-execution-switch';
import { env } from '../env';
import { newId } from '../ids';
import { logger } from '../observability/logger';

/**
 * Fleet-wide AI execution switches (WASIT-AI-KILLSWITCH-FLEET-01).
 *
 * PostgreSQL is the single source of truth: every execution entry point reads
 * the `GLOBAL` row (and, when it knows the agent, the `AGENT` row) at the moment
 * it is about to start work. There is no in-process cache and no polling, so an
 * instance cannot keep running on a stale "enabled" that another instance has
 * already overridden.
 *
 * Concurrency: task creation takes `FOR SHARE` on the GLOBAL row inside the
 * transaction that writes the task, and every switch change takes `FOR UPDATE`
 * on that same row. A stop therefore cannot commit between "checked" and
 * "created": either the creation commits first (and the stop cancels it while
 * it is still `queued`), or the creation waits and then observes the stop.
 *
 * Fail-closed: an unreadable table, a missing GLOBAL row or any query error is
 * reported as `unavailable`, which refuses new work instead of assuming it is
 * allowed.
 */

export const GLOBAL_TARGET_KEY = '*';
export const GLOBAL_SWITCH_ID = '00000000-0000-0000-0000-000000000001';

export const AI_AGENT_PAUSED_MESSAGE = 'AI agent execution is paused by the central kill switch';
export const AI_CONTROL_UNAVAILABLE_MESSAGE =
  'AI execution control is unavailable; refusing to start new work';

/** Accepts the pooled handle or an open transaction. */
export type SwitchDb = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export type SwitchSource = 'database' | 'env' | 'unavailable';

export interface SwitchRowView {
  scope: 'GLOBAL' | 'AGENT';
  targetKey: string;
  stopped: boolean;
  reason: string | null;
  actorId: string | null;
  version: number;
  updatedAt: string;
}

export interface ExecutionSwitchState {
  /** Effective permission to start new AI work. */
  enabled: boolean;
  source: SwitchSource;
  /** True when the state could not be read (refusals are then mandatory). */
  failClosed: boolean;
  globalStopped: boolean;
  envStopped: boolean;
  stoppedAgents: string[];
  global: SwitchRowView | null;
  agents: SwitchRowView[];
  checkedAt: string;
}

const COLUMNS = {
  scope: aiExecutionSwitches.scope,
  targetKey: aiExecutionSwitches.targetKey,
  stopped: aiExecutionSwitches.stopped,
  reason: aiExecutionSwitches.reason,
  actorId: aiExecutionSwitches.actorId,
  version: aiExecutionSwitches.version,
  updatedAt: aiExecutionSwitches.updatedAt,
};

function view(row: {
  scope: string;
  targetKey: string;
  stopped: boolean;
  reason: string | null;
  actorId: string | null;
  version: number;
  updatedAt: Date;
}): SwitchRowView {
  return {
    scope: row.scope === 'GLOBAL' ? 'GLOBAL' : 'AGENT',
    targetKey: row.targetKey,
    stopped: row.stopped,
    reason: row.reason,
    actorId: row.actorId,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The environment belt: it may stop work, never re-open it. */
function envStopped(): boolean {
  try {
    return env.AI_AGENT_EXECUTION_ENABLED === false;
  } catch {
    // An unreadable flag must not be read as "allowed".
    return true;
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', AI_CONTROL_UNAVAILABLE_MESSAGE);
}

function disabled(agentKey?: string): ApiError {
  return agentKey
    ? new ApiError(503, 'SERVICE_UNAVAILABLE', AI_AGENT_PAUSED_MESSAGE)
    : new ApiError(
        503,
        'SERVICE_UNAVAILABLE',
        'AI execution is currently disabled by the central kill switch',
      );
}

/**
 * Pure projection of the stored rows into the effective state. Exported so the
 * decision logic (including fail-closed on a missing GLOBAL row) is unit-tested
 * without a database.
 */
export function describeSwitchState(
  rows: SwitchRowView[],
  envOff: boolean,
  checkedAt = new Date().toISOString(),
): ExecutionSwitchState {
  const global = rows.find((r) => r.scope === 'GLOBAL' && r.targetKey === GLOBAL_TARGET_KEY) ?? null;
  const agents = rows.filter((r) => r.scope === 'AGENT');
  if (!global) {
    return {
      enabled: false,
      source: 'unavailable',
      failClosed: true,
      globalStopped: false,
      envStopped: envOff,
      stoppedAgents: agents.filter((a) => a.stopped).map((a) => a.targetKey),
      global: null,
      agents,
      checkedAt,
    };
  }
  return {
    enabled: !envOff && !global.stopped,
    source: envOff ? 'env' : 'database',
    failClosed: false,
    globalStopped: global.stopped,
    envStopped: envOff,
    stoppedAgents: agents.filter((a) => a.stopped).map((a) => a.targetKey),
    global,
    agents,
    checkedAt,
  };
}

async function readRows(db: SwitchDb): Promise<SwitchRowView[] | null> {
  try {
    // Unwrap an agent-scoped handle: the switch is platform control data, not
    // agent data, so it is read through the same escape hatch as provider
    // configuration. An agent can never write it, and its scope cannot hide it.
    const rows = await platformDb(db as DB).select(COLUMNS).from(aiExecutionSwitches);
    return rows.map(view);
  } catch (err) {
    logger.error('ai execution switch read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Full state for read surfaces (admin, GM dashboard, health). */
export async function readExecutionSwitchState(db: DB): Promise<ExecutionSwitchState> {
  const rows = await readRows(db);
  if (!rows) {
    return {
      enabled: false,
      source: 'unavailable',
      failClosed: true,
      globalStopped: false,
      envStopped: envStopped(),
      stoppedAgents: [],
      global: null,
      agents: [],
      checkedAt: new Date().toISOString(),
    };
  }
  return describeSwitchState(rows, envStopped());
}

/**
 * The guard every execution entry point calls. `agentKey` is supplied wherever
 * the caller knows which agent is about to run, so a single agent's stop is
 * honoured on every instance.
 */
export async function assertExecutionAllowed(db: DB, agentKey?: string | null): Promise<void> {
  const rows = await readRows(db);
  if (!rows) throw unavailable();
  const state = describeSwitchState(rows, envStopped());
  if (state.source === 'unavailable') throw unavailable();
  if (state.envStopped || state.globalStopped) throw disabled();
  if (agentKey && state.stoppedAgents.includes(agentKey)) throw disabled(agentKey);
}

/** Audit-free predicate for sweeps that must record their own single refusal. */
export async function isExecutionBlocked(db: DB, agentKey?: string | null): Promise<boolean> {
  try {
    await assertExecutionAllowed(db, agentKey);
    return false;
  } catch {
    return true;
  }
}

/**
 * The authoritative check for starting a task: locks the GLOBAL row `FOR SHARE`
 * inside the caller's transaction. Any stop waits for this transaction, and any
 * transaction that starts after a committed stop observes it.
 */
export async function lockAndAssertExecutionAllowed(
  tx: SwitchDb,
  agentKey?: string | null,
): Promise<void> {
  let globalRow: SwitchRowView | null = null;
  // A scoped transaction must not hide the authority it is being checked
  // against: unwrap to the platform handle exactly as the read path does.
  const handle = platformDb(tx as unknown as DB) as unknown as SwitchDb;
  try {
    const rows = await handle
      .select(COLUMNS)
      .from(aiExecutionSwitches)
      .where(eq(aiExecutionSwitches.scope, 'GLOBAL'))
      .for('share');
    const found = rows.find((row) => row.targetKey === GLOBAL_TARGET_KEY);
    if (found) globalRow = view(found);
  } catch (err) {
    logger.error('ai execution switch lock failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw unavailable();
  }
  if (!globalRow) throw unavailable();
  if (envStopped() || globalRow.stopped) throw disabled();
  if (agentKey) {
    const [agentRow] = await handle
      .select(COLUMNS)
      .from(aiExecutionSwitches)
      .where(eq(aiExecutionSwitches.scope, 'AGENT'));
    const stopped = agentRow ? view(agentRow).stopped : false;
    if (stopped && agentRow!.targetKey === agentKey) throw disabled(agentKey);
  }
}

export interface SwitchChangeResult {
  row: SwitchRowView;
  previous: SwitchRowView;
  cancelledQueued: number;
  /** False when the requested state was already in force (nothing was written). */
  changed: boolean;
}

/**
 * Stops or resumes ALL AI execution. Cancels `queued` tasks in the same
 * transaction when stopping: they were created before the stop committed and
 * must not be picked up afterwards. They are never re-queued automatically.
 */
export async function setGlobalSwitch(
  db: DB,
  input: { stopped: boolean; reason?: string | null; actorId: string },
): Promise<SwitchChangeResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(COLUMNS)
      .from(aiExecutionSwitches)
      .where(and(eq(aiExecutionSwitches.scope, 'GLOBAL'), eq(aiExecutionSwitches.targetKey, GLOBAL_TARGET_KEY)))
      .limit(1)
      .for('update');
    if (!current) throw unavailable();
    if (current.stopped === input.stopped) {
      return { row: view(current), previous: view(current), cancelledQueued: 0, changed: false };
    }
    const [updated] = await tx
      .update(aiExecutionSwitches)
      .set({
        stopped: input.stopped,
        reason: input.reason ?? null,
        actorId: input.actorId,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(eq(aiExecutionSwitches.scope, 'GLOBAL'), eq(aiExecutionSwitches.targetKey, GLOBAL_TARGET_KEY)),
      )
      .returning(COLUMNS);
    let cancelledQueued = 0;
    if (input.stopped) {
      const cancelled = await tx
        .update(agentTasks)
        .set({
          status: 'cancelled',
          error: { code: 'AI_EXECUTION_DISABLED', message: 'Cancelled by the central kill switch' } as never,
          errorAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(agentTasks.status, 'queued'))
        .returning({ id: agentTasks.id });
      cancelledQueued = cancelled.length;
    }
    return { row: view(updated), previous: view(current), cancelledQueued, changed: true };
  });
}

/**
 * Stops or resumes ONE agent. Resuming is refused while the global switch is
 * off: an individual decision must never be a path around a platform stop.
 * The GLOBAL row is locked first so this change is serialised against task
 * creation (which holds it `FOR SHARE`).
 */
export async function setAgentSwitch(
  db: DB,
  agentKey: string,
  input: { stopped: boolean; reason?: string | null; actorId: string },
): Promise<SwitchChangeResult> {
  return db.transaction(async (tx) => {
    const [global] = await tx
      .select(COLUMNS)
      .from(aiExecutionSwitches)
      .where(and(eq(aiExecutionSwitches.scope, 'GLOBAL'), eq(aiExecutionSwitches.targetKey, GLOBAL_TARGET_KEY)))
      .limit(1)
      .for('update');
    if (!global) throw unavailable();
    if (envStopped() || global.stopped) {
      if (!input.stopped) {
        throw ApiError.conflict(
          'The global AI execution stop is active; individual agents cannot be resumed until it is lifted',
        );
      }
    }

    const [existing] = await tx
      .select(COLUMNS)
      .from(aiExecutionSwitches)
      .where(and(eq(aiExecutionSwitches.scope, 'AGENT'), eq(aiExecutionSwitches.targetKey, agentKey)))
      .limit(1)
      .for('update');

    if (existing && existing.stopped === input.stopped) {
      return {
        row: view(existing),
        previous: view(existing),
        cancelledQueued: 0,
        changed: false,
      };
    }

    const previous: SwitchRowView = existing
      ? view(existing)
      : {
          scope: 'AGENT',
          targetKey: agentKey,
          stopped: false,
          reason: null,
          actorId: null,
          version: 0,
          updatedAt: new Date(0).toISOString(),
        };

    const [updated] = existing
      ? await tx
          .update(aiExecutionSwitches)
          .set({
            stopped: input.stopped,
            reason: input.reason ?? null,
            actorId: input.actorId,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(eq(aiExecutionSwitches.scope, 'AGENT'), eq(aiExecutionSwitches.targetKey, agentKey)),
          )
          .returning(COLUMNS)
      : await tx
          .insert(aiExecutionSwitches)
          .values({
            id: newId(),
            scope: 'AGENT',
            targetKey: agentKey,
            stopped: input.stopped,
            reason: input.reason ?? null,
            actorId: input.actorId,
            version: 1,
          })
          .returning(COLUMNS);

    let cancelledQueued = 0;
    if (input.stopped) {
      const cancelled = await tx
        .update(agentTasks)
        .set({
          status: 'cancelled',
          error: { code: 'AI_AGENT_PAUSED', message: 'Cancelled by an agent kill switch' } as never,
          errorAt: new Date(),
          completedAt: new Date(),
        })
        .where(and(eq(agentTasks.status, 'queued'), eq(agentTasks.agentKey, agentKey)))
        .returning({ id: agentTasks.id });
      cancelledQueued = cancelled.length;
    }
    return { row: view(updated), previous, cancelledQueued, changed: true };
  });
}
