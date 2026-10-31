import type { DB } from '../../db/client';
import { logger } from '../../lib/observability/logger';
import { findAgentSpec } from './catalogue';
import type { AgentScopeCtx } from './scope';
import {
  putMemory,
  listMemory,
  hasMemoryForTask,
  trimOwnMemory,
  ALLOWED_TAGS,
  SOURCE_TYPES,
  type MemoryKind,
  type MemorySource,
} from './memory-repo';

/**
 * AI-06.0 — operational agent memory, wired into the execution gate.
 *
 * This is the thin service layer between the runner and `memory-repo.ts`. It
 * turns a finished task into ONE compact, deterministic memory note and turns an
 * owner's recent notes into a short recall string for the next run.
 *
 * What a note may contain is bounded by `memory-repo`'s allow-list: `tags`
 * (catalogue identifiers only), `metrics` (outcome / latencyMs / short error
 * code), `source` (a bounded enum), and the verified `taskId`. There is no
 * free-text field, so a note can never carry a person's name, a phone number, a
 * secret or a raw business payload.
 *
 * CONFIRMED vs INFERRED: a note records only facts read back from the database
 * (status, latency, error code, task id). It never stores the model's
 * `proposal`/`reasoning` — that is an inference and would not be verifiable.
 * Recall therefore never feeds a past model guess back as if it were fact.
 *
 * FAILURE POLICY: both functions are best-effort and fail OPEN (log a warning).
 * They run only AFTER the task's terminal status is already persisted, so a
 * memory failure can never change — or fake — the outcome of a run.
 */

/** A task row shaped enough to record memory from (kept structural to avoid a
 * dependency on the full runner type). */
export interface MemoryTaskFacts {
  id: string;
  agentKey: string;
  taskType: string | null;
  requestedBy: string;
  status: string;
  latencyMs: number;
  error: unknown;
  triggeredBy: string;
}

/** Outcome codes a memory note may carry — the metric outcomes plus the two
 * terminal states that are not a "run" outcome (`awaiting_approval`, `rejected`). */
type MemoryOutcome = 'succeeded' | 'failed' | 'blocked' | 'refused';

/** Derives the bounded tag list for a task: catalogue category + task-type
 * family, each kept only if it is one of the allow-listed tags. Never free text. */
export function deriveMemoryTags(agentKey: string, taskType: string | null): string[] {
  const tags: string[] = [];
  const category = findAgentSpec(agentKey)?.category;
  if (category && ALLOWED_TAGS.includes(category)) tags.push(category);
  const family = taskType?.split('.')[0];
  if (family && ALLOWED_TAGS.includes(family) && !tags.includes(family)) tags.push(family);
  return tags;
}

/** Where a note came from, from the task's provenance — a bounded enum, never
 * free text. A scheduled task is `schedule`; everything else is `task`. */
export function deriveMemorySource(triggeredBy: string): MemorySource {
  return triggeredBy.startsWith('schedule:') ? 'schedule' : 'task';
}

/** A short machine error code from a task's stored error, or null. Only an
 * existing code is used; a free-form message is never stored. */
function errorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; refused?: unknown };
  if (typeof e.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.code)) return e.code;
  if (e.refused === true) return 'REFUSED';
  return null;
}

/**
 * Records one memory note for a finished task. Returns the new id, or null when
 * nothing was recorded (duplicate, or a swallowed failure).
 *
 * The caller passes the scope it derived from a trusted source (AI-06.1): the
 * runner resolves either the real requester's owner scope or — for a task the
 * trusted scheduler enqueued — the dedicated system scope. Identity is never
 * taken from the task row here, so a task that merely claims `system` cannot
 * write into the system bucket.
 *
 * Idempotent: a note already referencing this task id is not written again, so a
 * task finalised twice (a scheduler tick racing an on-demand run) yields one
 * note. Only terminal, meaningful outcomes are recorded.
 */
export async function recordTaskMemory(db: DB, scope: AgentScopeCtx, task: MemoryTaskFacts): Promise<string | null> {
  try {
    const kind: MemoryKind = 'summary';
    const content: Record<string, unknown> = {
      taskId: task.id,
      source: deriveMemorySource(task.triggeredBy),
      metrics: { outcome: outcomeOf(task.status), latencyMs: task.latencyMs },
    };
    const tags = deriveMemoryTags(task.agentKey, task.taskType);
    if (tags.length > 0) content.tags = tags;
    const code = errorCodeOf(task.error);
    if (code) (content.metrics as Record<string, unknown>).errorCode = code;

    if (await hasMemoryForTask(db, scope, task.id)) return null;
    const id = await putMemory(db, scope, { agentKey: task.agentKey, kind, content });
    return id;
  } catch (err) {
    logger.warn('agent memory record failed (task outcome unaffected)', {
      taskId: task.id,
      agentKey: task.agentKey,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Maps a task status (+ its stored error) to a metric/memory outcome.
 *
 * `refused` is a **first-class** outcome, distinct from `failed` (AI-06.1):
 *   - a deliberate executor refusal is persisted as `failed` with
 *     `error.refused === true`, and an approval REJECT is the `rejected` status —
 *     both map to `refused`, so a refusal is neither counted as a success nor as
 *     a technical failure;
 *   - `awaiting_approval`/`running`/`queued` are not run outcomes, so a
 *     non-terminal task records nothing (see {@link isMemorableStatus}).
 */
function outcomeOf(status: string, error?: unknown): MemoryOutcome {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'blocked') return 'blocked';
  if (status === 'rejected') return 'refused';
  if (error && typeof error === 'object' && (error as { refused?: unknown }).refused === true) return 'refused';
  return 'failed';
}

/** True when a task status is one worth remembering. */
export function isMemorableStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'blocked' || status === 'rejected';
}

/**
 * Builds a compact recall string from this owner's recent notes for the same
 * agent (and, when given, the same task-type family).
 *
 * Every line is a deterministic fact read back from stored notes — status,
 * latency, error code and tags — never a past model guess. Returns null when
 * there is nothing relevant. Owner-scoped: it can only ever see `scope`'s rows,
 * so a human run can never recall the system bucket and vice versa.
 */
export async function recallAgentContext(
  db: DB,
  scope: AgentScopeCtx,
  agentKey: string,
  taskType: string | null,
  limit = 5,
): Promise<string | null> {
  try {
    const rows = await listMemory(db, scope, { agentKey });
    if (rows.length === 0) return null;
    const family = taskType?.split('.')[0];
    const relevant = rows
      .filter((r) => {
        const c = (r.content ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
        return !family || tags.includes(family);
      })
      .slice(0, limit);
    if (relevant.length === 0) return null;
    const lines = relevant.map((r) => {
      const c = (r.content ?? {}) as Record<string, unknown>;
      const m = (c.metrics ?? {}) as Record<string, unknown>;
      const parts = [`task ${r.id.slice(0, 8)}`, String(m.outcome ?? 'unknown')];
      if (typeof m.latencyMs === 'number') parts.push(`${m.latencyMs}ms`);
      if (typeof m.errorCode === 'string') parts.push(`code=${m.errorCode}`);
      const tags = Array.isArray(c.tags) ? (c.tags as string[]) : [];
      if (tags.length > 0) parts.push(`[${tags.join(',')}]`);
      return `- ${parts.join(' ')}`;
    });
    return `Prior runs for ${agentKey} (this account):\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn('agent memory recall failed (run continues without context)', {
      agentKey,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Applies a scope's retention policy: trims to the newest `keep` notes.
 * Best-effort and scope-scoped. Returns the number of notes removed (0 on
 * failure).
 */
export async function enforceMemoryRetention(db: DB, scope: AgentScopeCtx, keep: number): Promise<number> {
  try {
    return await trimOwnMemory(db, scope, keep);
  } catch (err) {
    logger.warn('agent memory retention failed (non-fatal)', {
      error: (err as Error).message,
    });
    return 0;
  }
}

/** Default per-owner note cap and age window, overridable by callers. */
export const DEFAULT_MEMORY_KEEP = 200;
export const DEFAULT_MEMORY_MAX_AGE_DAYS = 180;

export const __internal = { outcomeOf, errorCodeOf, SOURCE_TYPES };