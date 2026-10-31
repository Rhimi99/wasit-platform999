import { and, desc, eq, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentMemory, agentTasks } from '../../db/schema/agents';
import { newId } from '../../lib/ids';
import { assertValidScope, type AgentScopeCtx } from './scope';

/**
 * Owner-scoped access to `agent_memory`.
 *
 * This is the ONLY module allowed to touch the `agent_memory` table. Three rules
 * hold on every statement:
 *   1. `scope_owner = ctx.owner` is always injected — no read/write/delete can
 *      span owners, and `deleteOwn` can only remove the caller's own rows.
 *   2. Content passes a strict allow-list before it is stored. Secrets, personal
 *      data and raw business payloads are rejected, not merely discouraged.
 *   3. A `taskId` in the content must reference a task OWNED by `ctx.owner`
 *      (checked against `agent_tasks`), so a caller cannot store — and later
 *      read back — another owner's task id.
 *
 * AI-06.0 wires this module into the execution gate via `memory-service.ts`:
 * the runner records a compact, deterministic outcome note per terminal task and
 * recalls the owner's prior context for the next one. The owner-agnostic
 * `pruneMemoryByAge` is the only non-scoped statement — a retention sweep for
 * notes only (it never touches the append-only audit trail).
 */

export type MemoryKind = 'note' | 'learning' | 'summary';

export const MEMORY_KINDS: readonly MemoryKind[] = ['note', 'learning', 'summary'];

export interface MemoryEntry {
  agentKey: string;
  kind: MemoryKind;
  content: unknown;
}

export interface AgentMemoryRow {
  id: string;
  agentKey: string;
  scopeOwner: string;
  kind: string;
  content: unknown;
  createdAt: Date;
}

export interface MemoryFilter {
  agentKey?: string;
  kind?: MemoryKind;
}

// ---------- allow-list content schema ----------
//
// The stored content is deliberately a small, structured set of fields. Free
// text is NOT accepted: a regular expression cannot reliably tell a benign note
// from a person's name, an address, a formatted phone number or an encoded
// secret, so any field that cannot be validated is rejected rather than stored
// on the assumption that it is safe. See `scanText` for the (heuristic, best
// effort) patterns still applied to the remaining fields.

const MAX_TAG_LEN = 32;
const MAX_TAGS = 20;
const MAX_REFS = 20;
const REF_TYPES = ['task', 'order', 'product'] as const;
const METRIC_OUTCOMES = ['succeeded', 'failed', 'blocked', 'refused'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = ['tags', 'metrics', 'refs', 'source', 'taskId'] as const;

/**
 * Where a memory note came from. A bounded, code-defined enum — never free text
 * — so the origin of every note is machine-checkable and cannot smuggle prose.
 */
export const SOURCE_TYPES = ['task', 'schedule', 'gm', 'manual'] as const;
export type MemorySource = (typeof SOURCE_TYPES)[number];

/**
 * The fixed allow-list of memory tags (decision C′).
 *
 * A tag must be one of these exact, lower-case, code-defined values. It is built
 * only from identifiers already present in the agent catalogue
 * (`packages/server/src/modules/ai/catalogue.ts`): the agent `category` values,
 * the `taskTypes` family prefixes, and the objective `window` values. Nothing is
 * invented, and no free-form string, personal name, phone number or e-mail can
 * ever match, so such values are rejected structurally rather than by heuristic.
 */
export const ALLOWED_TAGS: readonly string[] = [
  // agent categories
  'coordination', 'growth', 'operations', 'insight', 'trust', 'platform',
  'finance', 'network', 'oversight',
  // task-type families
  'sales', 'marketing', 'ads', 'product', 'support', 'analytics', 'research',
  'b2b', 'risk', 'dispute', 'dev', 'payment', 'compliance', 'supplier',
  'merchant', 'customer', 'outreach', 'copilot', 'supervisor',
  // objective windows
  'daily', 'weekly', 'monthly', 'per_task',
];

/**
 * Whether a `refs` entry can be checked against the referenced entity's owner.
 *
 * This module has no trustworthy way to confirm that a referenced task/order/
 * product belongs to `ctx.owner` — doing so would require querying other tables,
 * which is out of scope for this batch. Accepting a bare UUID would let a caller
 * store (and later read) another owner's entity id, i.e. probe for existence of
 * records they do not own. So `refs` is **temporarily disabled**: the field is
 * rejected until a server-side ownership source is wired in. This is a documented
 * compatibility reduction — nothing uses `refs` yet.
 */
export const REF_OWNERSHIP_VERIFIABLE = false;

/** Defence-in-depth patterns scanned across string fields. Tags are already
 * restricted to {@link ALLOWED_TAGS}, so these can only ever see allow-listed
 * words; they remain a best-effort guard for any future field. NOT a guarantee
 * of detecting every secret or PII. */
const SECRET_OR_PII: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'email', re: /[^\s@]+@[^\s@]+\.[^\s@]+/ },
  { name: 'card_number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'secret_keyword', re: /\b(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|bearer|credential|cvv|iban|swift)\b/i },
  { name: 'long_digit_run', re: /\b\d{9,}\b/ },
  // Formatted phone numbers with separators (e.g. "+966 50 123 4567") and
  // digit groups that read like an identifier; plain prose digits are unaffected.
  { name: 'phone_or_identifier', re: /(?:\+\d[\d\s().-]{6,}\d)|(?:\b\d{2,4}(?:[ .-]\d{2,4}){1,}\b)/ },
];

/** Secret- or PII-looking key names, rejected wherever they appear. */
const SECRET_KEY_RE = /\b(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|bearer|credential|cvv|iban|swift|phone|mobile|email|address)\b/i;

function fail(message: string, field: string): never {
  throw ApiError.validation([{ field, message, code: 'VALIDATION_ERROR' }], message);
}

function scanText(value: string, field: string): void {
  for (const { name, re } of SECRET_OR_PII) {
    if (re.test(value)) fail(`Content rejected: looks like ${name}.`, field);
  }
}

/**
 * Validates memory content against the allow-list and returns the normalised
 * object. Unknown keys, free text, `refs` (disabled), over-long values and any
 * secret/PII heuristic match are rejected.
 *
 * This does NOT prove the content is free of secrets or personal data; it only
 * enforces a narrow, structured shape and applies best-effort pattern checks.
 */
export function validateMemoryContent(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    fail('Memory content must be a plain object.', 'content');
  }
  const obj = content as Record<string, unknown>;

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      fail(`Memory content key "${key}" is not allowed.`, `content.${key}`);
    }
    if (SECRET_KEY_RE.test(key)) fail(`Content rejected: suspicious key "${key}".`, `content.${key}`);
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags)) fail('tags must be an array.', 'content.tags');
    if (obj.tags.length > MAX_TAGS) fail(`tags exceeds ${MAX_TAGS} entries.`, 'content.tags');
    out.tags = obj.tags.map((t, i) => {
      if (typeof t !== 'string') fail('tag must be a string.', `content.tags[${i}]`);
      if (t.length === 0 || t.length > MAX_TAG_LEN) fail(`tag length must be 1..${MAX_TAG_LEN}.`, `content.tags[${i}]`);
      if (!ALLOWED_TAGS.includes(t)) fail(`tag "${t}" is not an allowed tag.`, `content.tags[${i}]`);
      scanText(t, `content.tags[${i}]`);
      return t;
    });
  }

  if (obj.refs !== undefined) {
    if (!REF_OWNERSHIP_VERIFIABLE) {
      // No trustworthy ownership source yet — refuse rather than accept an
      // unverifiable UUID that could expose another owner's entity id.
      fail('refs are not accepted until entity ownership can be verified.', 'content.refs');
    }
    if (!Array.isArray(obj.refs)) fail('refs must be an array.', 'content.refs');
    if (obj.refs.length > MAX_REFS) fail(`refs exceeds ${MAX_REFS} entries.`, 'content.refs');
    out.refs = obj.refs.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) fail('ref must be an object.', `content.refs[${i}]`);
      const ref = r as Record<string, unknown>;
      for (const k of Object.keys(ref)) {
        if (k !== 'type' && k !== 'id') fail(`ref key "${k}" is not allowed.`, `content.refs[${i}].${k}`);
      }
      if (!REF_TYPES.includes(ref.type as (typeof REF_TYPES)[number])) {
        fail(`ref.type must be one of ${REF_TYPES.join('|')}.`, `content.refs[${i}].type`);
      }
      if (typeof ref.id !== 'string' || !UUID_RE.test(ref.id)) {
        fail('ref.id must be a UUID.', `content.refs[${i}].id`);
      }
      return { type: ref.type, id: ref.id };
    });
  }

  if (obj.metrics !== undefined) {
    if (!obj.metrics || typeof obj.metrics !== 'object' || Array.isArray(obj.metrics)) {
      fail('metrics must be an object.', 'content.metrics');
    }
    const m = obj.metrics as Record<string, unknown>;
    for (const k of Object.keys(m)) {
      if (k !== 'latencyMs' && k !== 'outcome' && k !== 'errorCode') fail(`metrics key "${k}" is not allowed.`, `content.metrics.${k}`);
    }
    const metrics: Record<string, unknown> = {};
    if (m.latencyMs !== undefined) {
      if (typeof m.latencyMs !== 'number' || !Number.isFinite(m.latencyMs) || m.latencyMs < 0) {
        fail('metrics.latencyMs must be a non-negative number.', 'content.metrics.latencyMs');
      }
      metrics.latencyMs = m.latencyMs;
    }
    if (m.outcome !== undefined) {
      if (!METRIC_OUTCOMES.includes(m.outcome as (typeof METRIC_OUTCOMES)[number])) {
        fail(`metrics.outcome must be one of ${METRIC_OUTCOMES.join('|')}.`, 'content.metrics.outcome');
      }
      metrics.outcome = m.outcome;
    }
    if (m.errorCode !== undefined) {
      // A short machine code only (e.g. NO_SCOPE, timeout). Never a message: a
      // free-form error string could carry data, so the shape is enforced.
      if (typeof m.errorCode !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(m.errorCode)) {
        fail('metrics.errorCode must be a short machine code (A-Za-z0-9_, 1..64).', 'content.metrics.errorCode');
      }
      metrics.errorCode = m.errorCode;
    }
    out.metrics = metrics;
  }

  if (obj.source !== undefined) {
    if (!SOURCE_TYPES.includes(obj.source as MemorySource)) {
      fail(`source must be one of ${SOURCE_TYPES.join('|')}.`, 'content.source');
    }
    out.source = obj.source;
  }

  if (obj.taskId !== undefined) {
    // A UUID only; ownership is verified against `agent_tasks` in `putMemory`.
    if (typeof obj.taskId !== 'string' || !UUID_RE.test(obj.taskId)) {
      fail('taskId must be a UUID.', 'content.taskId');
    }
    out.taskId = obj.taskId;
  }

  // An empty object carries no information; require at least one accepted field.
  if (Object.keys(out).length === 0) fail('Memory content must include at least one allowed field.', 'content');
  return out;
}

// ---------- scope helpers ----------

/** Every operation validates the scope through the runtime guard, which rejects
 * any context not produced by `deriveScope`/`derivePlatformScope`. */
function assertScope(ctx: AgentScopeCtx | null | undefined): AgentScopeCtx {
  return assertValidScope(ctx);
}

/** The scope predicate that must appear in every statement on this table. */
function ownerPredicate(ctx: AgentScopeCtx): SQL {
  return eq(agentMemory.scopeOwner, ctx.owner);
}

function filterPredicate(filter?: MemoryFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (filter?.agentKey) conds.push(eq(agentMemory.agentKey, filter.agentKey));
  if (filter?.kind) conds.push(eq(agentMemory.kind, filter.kind));
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : and(...conds);
}

// ---------- operations ----------

/** Whether `taskId` is a task owned by `owner`. A memory note may only reference
 * a task the same owner requested, so a stored id can never point at — or later
 * leak — another owner's task. */
async function ownsTask(db: DB, owner: string, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.requestedBy, owner)))
    .limit(1);
  return rows.length > 0;
}

/** Whether this owner already has a memory note referencing `taskId`. Used to
 * make recording idempotent when a task is finalised more than once (e.g. a
 * scheduler tick racing an on-demand run). */
export async function hasMemoryForTask(db: DB, ctx: AgentScopeCtx, taskId: string): Promise<boolean> {
  assertScope(ctx);
  const rows = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(ownerPredicate(ctx), sql`${agentMemory.content}->>'taskId' = ${taskId}`))
    .limit(1);
  return rows.length > 0;
}

/**
 * Stores a memory entry for `ctx.owner` after validating its content.
 *
 * When the content carries a `taskId`, it is verified against `agent_tasks`
 * first: the referenced task must belong to the same owner, otherwise the write
 * is refused. The verified id is then persisted so the note is traceable back to
 * the run that produced it.
 */
export async function putMemory(db: DB, ctx: AgentScopeCtx, entry: MemoryEntry): Promise<string> {
  assertScope(ctx);
  if (!MEMORY_KINDS.includes(entry.kind)) fail(`kind must be one of ${MEMORY_KINDS.join('|')}.`, 'kind');
  const content = validateMemoryContent(entry.content);
  const taskId = content.taskId;
  if (typeof taskId === 'string') {
    if (!UUID_RE.test(taskId)) fail('taskId must be a UUID.', 'content.taskId');
    if (!(await ownsTask(db, ctx.owner, taskId))) {
      fail('taskId must reference a task owned by the caller.', 'content.taskId');
    }
  }
  const id = newId();
  await db.insert(agentMemory).values({
    id,
    agentKey: entry.agentKey,
    scopeOwner: ctx.owner,
    kind: entry.kind,
    content,
  });
  return id;
}

/** Lists this owner's memory only, newest first. */
export async function listMemory(db: DB, ctx: AgentScopeCtx, filter?: MemoryFilter): Promise<AgentMemoryRow[]> {
  assertScope(ctx);
  const fp = filterPredicate(filter);
  const where = fp ? and(ownerPredicate(ctx), fp) : ownerPredicate(ctx);
  const rows = await db.select().from(agentMemory).where(where).orderBy(desc(agentMemory.createdAt));
  return rows as AgentMemoryRow[];
}

/** Deletes one of this owner's entries. Returns false when the id is not theirs. */
export async function deleteOwn(db: DB, ctx: AgentScopeCtx, id: string): Promise<boolean> {
  assertScope(ctx);
  const deleted = await db
    .delete(agentMemory)
    .where(and(ownerPredicate(ctx), eq(agentMemory.id, id)))
    .returning({ id: agentMemory.id });
  return deleted.length > 0;
}

// ---------- retention ----------

/**
 * Trims this owner's memory to the newest `keep` entries, deleting the rest.
 *
 * A per-owner volume cap so a single owner cannot grow the store without bound.
 * Scoped to `ctx.owner`, so it can never remove another owner's notes. Returns
 * the number of rows removed.
 */
export async function trimOwnMemory(db: DB, ctx: AgentScopeCtx, keep: number): Promise<number> {
  assertScope(ctx);
  if (!Number.isInteger(keep) || keep < 0) fail('keep must be a non-negative integer.', 'keep');
  const keepIds = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(ownerPredicate(ctx))
    .orderBy(desc(agentMemory.createdAt))
    .limit(keep);
  const keepSet = keepIds.map((r) => r.id);
  const removed = await db
    .delete(agentMemory)
    .where(
      keepSet.length > 0
        ? and(ownerPredicate(ctx), notInArray(agentMemory.id, keepSet))
        : ownerPredicate(ctx),
    )
    .returning({ id: agentMemory.id });
  return removed.length;
}

/**
 * Age-based retention sweep for memory notes.
 *
 * Deletes `agent_memory` rows older than `maxAgeDays` **across all owners**. This
 * is the single deliberately non-scoped statement in this module: it is a
 * retention policy, not a data read, and it is invoked only by the trusted
 * scheduler. It targets `agent_memory` alone — the append-only `audit_logs`
 * trail is never touched, so no mandatory audit record is ever pruned. Returns
 * the number of notes removed.
 */
export async function pruneMemoryByAge(db: DB, maxAgeDays: number): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const removed = await db
    .delete(agentMemory)
    .where(lt(agentMemory.createdAt, cutoff))
    .returning({ id: agentMemory.id });
  return removed.length;
}

export const __internal = { ownerPredicate, filterPredicate, scanText, ALLOWED_TAGS };
