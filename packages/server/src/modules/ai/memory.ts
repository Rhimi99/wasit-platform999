import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentMemory, agentTasks } from '../../db/schema/agents';
import { env } from '../../lib/env';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId } from '../../lib/ids';
import { COPILOT_KEY, findAgentSpec } from './catalogue.js';

/**
 * AI-MEM-01 — institutional agent memory, isolated per agent and per owner.
 *
 * The layer is deliberately narrow. A memory is a SHORT operational note an
 * agent (through its owner) keeps for later runs: a preference, a procedure, a
 * context label, or the deterministic outcome of a task. It is not a store for
 * business records, personal data or secrets — those live in their own tables
 * with their own retention rules.
 *
 * Isolation is structural, not conventional:
 *
 *  * every statement carries `scope_owner = <authenticated user id>` and the
 *    `agent_key` it was asked for; there is no query without both;
 *  * the owner is taken from the session (or the trusted run context), never
 *    from the request body — the zod schemas are `strict`, so a body that
 *    mentions `scopeOwner` is rejected rather than silently ignored;
 *  * `agent_key` and the owner are immutable: a memory cannot be moved to
 *    another agent or owner, only re-written in place by its owner;
 *  * a row carries a checksum over (agent, owner, type, revision, text), so a
 *    row edited behind the service's back is detected instead of trusted.
 *
 * Storage uses the existing `agent_memory` table: `kind` holds the memory type
 * and `content` holds a versioned envelope. That is a deliberate choice over a
 * schema migration — see AD-046.
 */

export const MEMORY_TYPES = ['operational', 'contextual', 'procedural', 'task_result'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Entity labels a memory may point at. A label is a hint, never an authorization. */
export const MEMORY_ENTITY_TYPES = [
  'product',
  'order',
  'supplier',
  'merchant',
  'company',
  'campaign',
  'dispute',
  'thread',
] as const;
export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

/** Retention applied when the caller does not choose one, per memory type. */
export const DEFAULT_TTL_DAYS: Record<MemoryType, number> = {
  operational: 30,
  contextual: 7,
  procedural: 180,
  task_result: 90,
};

/** The stored envelope. `v` allows a future shape change without guessing. */
interface MemoryEnvelope {
  v: 1;
  text: string;
  updatedAt: string;
  expiresAt: string | null;
  taskId: string | null;
  entityType: string | null;
  entityId: string | null;
  revision: number;
  checksum: string;
}

export interface MemoryView {
  id: string;
  agentKey: string;
  type: MemoryType;
  text: string;
  taskId: string | null;
  entityType: string | null;
  entityId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface MemoryScope {
  /** The authenticated owner. Never taken from request input. */
  ownerId: string;
  /** The agent whose memory is addressed. */
  agentKey: string;
}

export interface RememberInput {
  agentKey: string;
  type: MemoryType;
  text: string;
  taskId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ttlDays?: number | null;
}

export interface RecallQuery {
  agentKey: string;
  types?: readonly MemoryType[];
  taskId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Case-insensitive substring over the note text. */
  q?: string | null;
  limit?: number;
}

export interface UpdateMemoryInput {
  type?: MemoryType;
  text?: string;
  /** Accepted only to REFUSE a change: a memory's task link is written once. */
  taskId?: string | null;
  ttlDays?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Optimistic concurrency: refuse when the stored revision differs. */
  expectedRevision?: number;
}

// ---------------------------------------------------------------------------
// Content policy — what may never be written to memory
// ---------------------------------------------------------------------------

/** Refusal reasons surfaced (as a code, never the matched text) to the caller. */
export type MemoryRefusalReason =
  | 'PRIVATE_KEY'
  | 'API_TOKEN'
  | 'BEARER_TOKEN'
  | 'CREDENTIAL_ASSIGNMENT'
  | 'PAYMENT_CARD'
  | 'BANK_ACCOUNT'
  | 'EMAIL_ADDRESS';

const SECRET_PATTERNS: ReadonlyArray<{ reason: MemoryRefusalReason; re: RegExp }> = [
  { reason: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { reason: 'API_TOKEN', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { reason: 'API_TOKEN', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { reason: 'API_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { reason: 'API_TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { reason: 'API_TOKEN', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: 'API_TOKEN', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { reason: 'API_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { reason: 'API_TOKEN', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { reason: 'BEARER_TOKEN', re: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  {
    reason: 'CREDENTIAL_ASSIGNMENT',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S{4,}/i,
  },
  { reason: 'EMAIL_ADDRESS', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { reason: 'BANK_ACCOUNT', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/ },
  {
    reason: 'BANK_ACCOUNT',
    re: /\b(?:iban|account[ _-]?number|routing[ _-]?number)\b\s*[:=]?\s*[A-Z0-9]{8,}/i,
  },
];

/** Luhn check — a bare digit run only counts as a card number when it passes. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export type MemoryScanResult = { ok: true } | { ok: false; reason: MemoryRefusalReason };

/**
 * Whether a note may be stored. Fail-closed: an obvious credential, key, card,
 * IBAN or e-mail address refuses the write. The scan is intentionally blunt —
 * a false positive costs the caller a rephrase, a false negative leaks a
 * secret into a table that agents read back into prompts.
 */
export function scanMemoryText(text: string): MemoryScanResult {
  for (const { reason, re } of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, reason };
  }
  for (const run of text.match(/\d(?:[ -]?\d){12,18}/g) ?? []) {
    const digits = run.replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      return { ok: false, reason: 'PAYMENT_CARD' };
    }
  }
  return { ok: true };
}

/** Resolves the retention of a memory: requested TTL clamped to policy. */
export function resolveTtlDays(type: MemoryType, requested?: number | null): number {
  const fallback = DEFAULT_TTL_DAYS[type] ?? env.AI_MEMORY_DEFAULT_TTL_DAYS;
  const days = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : fallback;
  const bounded = Math.min(Math.max(days, 1), env.AI_MEMORY_MAX_TTL_DAYS);
  return bounded;
}

/** Integrity checksum binding a row to its agent, owner, type, revision and text. */
export function memoryChecksum(input: {
  agentKey: string;
  ownerId: string;
  type: string;
  revision: number;
  text: string;
}): string {
  return createHash('sha256')
    .update(`${input.agentKey}\n${input.ownerId}\n${input.type}\n${input.revision}\n${input.text}`, 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertAgentCanHoldMemory(agentKey: string): void {
  const spec = findAgentSpec(agentKey);
  if (!spec) throw ApiError.notFound('Agent');
  if (agentKey === COPILOT_KEY || spec.isSupervisor === true) {
    throw ApiError.forbidden('The Copilot and the oversight supervisor do not hold memory');
  }
}

function assertOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw ApiError.forbidden('No owned memory scope for this operation — refusing to run.');
  }
  return ownerId;
}

function assertText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw ApiError.validation([{ field: 'text', message: 'Memory text is required', code: 'REQUIRED' }]);
  }
  if (trimmed.length > env.AI_MEMORY_MAX_TEXT_CHARS) {
    throw ApiError.validation([
      {
        field: 'text',
        message: `Memory text must be at most ${env.AI_MEMORY_MAX_TEXT_CHARS} characters`,
        code: 'MAX_LENGTH',
      },
    ]);
  }
  const scan = scanMemoryText(trimmed);
  if (!scan.ok) {
    throw new ApiError(422, 'MEMORY_CONTENT_REFUSED', 'Memory content is not allowed', {
      fieldErrors: [
        { field: 'text', message: `Content refused: ${scan.reason}`, code: scan.reason },
      ],
      details: { code: 'MEMORY_CONTENT_REFUSED', reason: scan.reason },
    });
  }
  return trimmed;
}

function toView(row: { id: string; agentKey: string; kind: string; content: unknown; createdAt: Date }): MemoryView {
  const envl = row.content as MemoryEnvelope;
  return {
    id: row.id,
    agentKey: row.agentKey,
    type: row.kind as MemoryType,
    text: envl.text,
    taskId: envl.taskId ?? null,
    entityType: envl.entityType ?? null,
    entityId: envl.entityId ?? null,
    revision: envl.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: envl.updatedAt,
    expiresAt: envl.expiresAt ?? null,
  };
}

/** The row's checksum still matches its content — otherwise it was edited out of band. */
function verifyIntegrity(row: { agentKey: string; scopeOwner: string; kind: string; content: unknown }): boolean {
  const envl = row.content as MemoryEnvelope;
  if (!envl || typeof envl.text !== 'string' || typeof envl.checksum !== 'string') return false;
  return (
    envl.checksum ===
    memoryChecksum({
      agentKey: row.agentKey,
      ownerId: row.scopeOwner,
      type: row.kind,
      revision: envl.revision,
      text: envl.text,
    })
  );
}

/** SQL predicate: the row has not expired. Rows without an expiry never do. */
function notExpired() {
  return sql`(${agentMemory.content}->>'expiresAt' is null or (${agentMemory.content}->>'expiresAt')::timestamptz > now())`;
}

function ownerAgentWhere(scope: MemoryScope) {
  return and(eq(agentMemory.scopeOwner, assertOwner(scope.ownerId)), eq(agentMemory.agentKey, scope.agentKey));
}

async function liveCount(db: DB, where: ReturnType<typeof ownerAgentWhere>): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemory)
    .where(and(where, notExpired()));
  return rows[0]?.count ?? 0;
}

/**
 * Deletes expired rows, optionally for one owner. Retention is enforced by
 * deletion rather than by filtering alone, so an expired note cannot be read
 * back by a future run that forgets the predicate.
 */
export async function purgeExpiredMemories(db: DB, options: { ownerId?: string; limit?: number } = {}): Promise<number> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const conditions = [sql`not (${notExpired()})`];
  if (options.ownerId) conditions.push(eq(agentMemory.scopeOwner, assertOwner(options.ownerId)));
  const expired = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(...conditions))
    .limit(limit);
  if (expired.length === 0) return 0;
  const deleted = await db
    .delete(agentMemory)
    .where(inArray(agentMemory.id, expired.map((row) => row.id)))
    .returning({ id: agentMemory.id });
  return deleted.length;
}

async function assertTaskBelongsToAgent(db: DB, scope: MemoryScope, taskId: string): Promise<void> {
  const rows = await db
    .select({ agentKey: agentTasks.agentKey, requestedBy: agentTasks.requestedBy })
    .from(agentTasks)
    .where(eq(agentTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  // A task the caller does not own is reported as missing: existence of another
  // owner's task id must not leak through the memory layer.
  if (!row || row.requestedBy !== scope.ownerId) throw ApiError.notFound('Task');
  if (row.agentKey !== scope.agentKey) {
    throw ApiError.validation([
      { field: 'taskId', message: 'Task belongs to a different agent', code: 'AGENT_MISMATCH' },
    ]);
  }
}

function assertEntity(entityType?: string | null, entityId?: string | null): { entityType: string | null; entityId: string | null } {
  if (!entityType && !entityId) return { entityType: null, entityId: null };
  if (!entityType || !entityId) {
    throw ApiError.validation([
      { field: 'entityType', message: 'entityType and entityId must be provided together', code: 'PAIRED' },
    ]);
  }
  if (!(MEMORY_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw ApiError.validation([{ field: 'entityType', message: 'Unknown entity type', code: 'ENUM' }]);
  }
  if (entityId.length > 36) {
    throw ApiError.validation([{ field: 'entityId', message: 'entityId is too long', code: 'MAX_LENGTH' }]);
  }
  return { entityType, entityId };
}

// ---------------------------------------------------------------------------
// Write / read / update / delete — always owner + agent scoped
// ---------------------------------------------------------------------------

export async function rememberMemory(
  db: DB,
  scope: MemoryScope,
  input: RememberInput,
  audit: AuditContext,
): Promise<MemoryView> {
  assertAgentCanHoldMemory(scope.agentKey);
  const ownerId = assertOwner(scope.ownerId);
  const text = assertText(input.text);
  const type = input.type;
  if (!MEMORY_TYPES.includes(type)) {
    throw ApiError.validation([{ field: 'type', message: 'Unknown memory type', code: 'ENUM' }]);
  }
  const entity = assertEntity(input.entityType, input.entityId);
  if (input.taskId) await assertTaskBelongsToAgent(db, scope, input.taskId);

  // Retention first: a write never fails because expired rows occupy the quota.
  await purgeExpiredMemories(db, { ownerId });

  const scopeWhere = ownerAgentWhere(scope);
  if ((await liveCount(db, scopeWhere)) >= env.AI_MEMORY_MAX_PER_AGENT) {
    throw new ApiError(409, 'MEMORY_LIMIT_REACHED', 'Memory limit reached for this agent', {
      details: { limit: env.AI_MEMORY_MAX_PER_AGENT, agentKey: scope.agentKey },
    });
  }
  const ownerRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemory)
    .where(and(eq(agentMemory.scopeOwner, ownerId), notExpired()));
  if ((ownerRows[0]?.count ?? 0) >= env.AI_MEMORY_MAX_PER_OWNER) {
    throw new ApiError(409, 'MEMORY_LIMIT_REACHED', 'Memory limit reached for this account', {
      details: { limit: env.AI_MEMORY_MAX_PER_OWNER },
    });
  }

  const id = newId();
  const now = new Date();
  const ttlDays = resolveTtlDays(type, input.ttlDays);
  const envelope: MemoryEnvelope = {
    v: 1,
    text,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
    taskId: input.taskId ?? null,
    entityType: entity.entityType,
    entityId: entity.entityId,
    revision: 1,
    checksum: memoryChecksum({ agentKey: scope.agentKey, ownerId, type, revision: 1, text }),
  };

  await db.insert(agentMemory).values({
    id,
    agentKey: scope.agentKey,
    scopeOwner: ownerId,
    kind: type,
    content: envelope as never,
    createdAt: now,
  });

  await writeAudit(db, audit, {
    action: 'AI.MEMORY_CREATED',
    entityType: 'AGENT_MEMORY',
    entityId: id,
    metadata: {
      agentKey: scope.agentKey,
      type,
      taskId: envelope.taskId,
      entityType: envelope.entityType,
      entityId: envelope.entityId,
      expiresAt: envelope.expiresAt,
      chars: text.length,
    },
  });

  return toView({ id, agentKey: scope.agentKey, kind: type, content: envelope, createdAt: now });
}

/** Recalls this owner's memories for one agent. Never crosses owner or agent. */
export async function recallMemories(
  db: DB,
  scope: MemoryScope,
  query: RecallQuery,
  audit: AuditContext,
): Promise<MemoryView[]> {
  assertAgentCanHoldMemory(scope.agentKey);
  const ownerId = assertOwner(scope.ownerId);
  const conditions = [ownerAgentWhere(scope), notExpired()];

  if (query.types && query.types.length > 0) {
    for (const t of query.types) {
      if (!MEMORY_TYPES.includes(t)) {
        throw ApiError.validation([{ field: 'types', message: 'Unknown memory type', code: 'ENUM' }]);
      }
    }
    conditions.push(inArray(agentMemory.kind, [...query.types]));
  }
  if (query.taskId) conditions.push(sql`${agentMemory.content}->>'taskId' = ${query.taskId}`);
  if (query.entityType) {
    conditions.push(sql`${agentMemory.content}->>'entityType' = ${query.entityType}`);
    if (query.entityId) conditions.push(sql`${agentMemory.content}->>'entityId' = ${query.entityId}`);
  }
  if (query.q) {
    const needle = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`${agentMemory.content}->>'text' ilike ${needle}`);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(...conditions))
    .orderBy(desc(sql`coalesce((${agentMemory.content}->>'updatedAt')::timestamptz, ${agentMemory.createdAt})`))
    .limit(limit);

  const views: MemoryView[] = [];
  let tampered = 0;
  for (const row of rows) {
    if (!verifyIntegrity(row)) {
      tampered += 1;
      continue;
    }
    views.push(toView(row));
  }
  if (tampered > 0) {
    await writeAudit(db, audit, {
      action: 'AI.MEMORY_INTEGRITY_FAILED',
      entityType: 'AGENT_MEMORY',
      metadata: { agentKey: scope.agentKey, count: tampered, source: 'RECALL' },
    });
  }

  await writeAudit(db, audit, {
    action: 'AI.MEMORY_LISTED',
    entityType: 'AGENT_MEMORY',
    metadata: {
      agentKey: scope.agentKey,
      ownerId,
      count: views.length,
      types: query.types ?? null,
      taskId: query.taskId ?? null,
      entityType: query.entityType ?? null,
      hasQuery: Boolean(query.q),
    },
  });

  return views;
}

export async function getMemory(
  db: DB,
  scope: MemoryScope,
  id: string,
  audit: AuditContext,
): Promise<MemoryView> {
  assertAgentCanHoldMemory(scope.agentKey);
  assertOwner(scope.ownerId);
  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.id, id), ownerAgentWhere(scope)))
    .limit(1);
  const row = rows[0];
  // Wrong owner or wrong agent ⇒ the same 404 as a missing id: no existence leak.
  if (!row) throw ApiError.notFound('Memory');
  if (!verifyIntegrity(row)) {
    await writeAudit(db, audit, {
      action: 'AI.MEMORY_INTEGRITY_FAILED',
      entityType: 'AGENT_MEMORY',
      entityId: id,
      metadata: { agentKey: scope.agentKey, source: 'GET' },
    });
    throw new ApiError(409, 'MEMORY_INTEGRITY_FAILED', 'Memory integrity check failed');
  }
  await writeAudit(db, audit, {
    action: 'AI.MEMORY_READ',
    entityType: 'AGENT_MEMORY',
    entityId: id,
    metadata: { agentKey: scope.agentKey, type: row.kind },
  });
  return toView(row);
}

export async function updateMemory(
  db: DB,
  scope: MemoryScope,
  id: string,
  patch: UpdateMemoryInput,
  audit: AuditContext,
): Promise<MemoryView> {
  assertAgentCanHoldMemory(scope.agentKey);
  const ownerId = assertOwner(scope.ownerId);
  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.id, id), ownerAgentWhere(scope)))
    .limit(1);
  const row = rows[0];
  if (!row) throw ApiError.notFound('Memory');
  if (!verifyIntegrity(row)) {
    await writeAudit(db, audit, {
      action: 'AI.MEMORY_INTEGRITY_FAILED',
      entityType: 'AGENT_MEMORY',
      entityId: id,
      metadata: { agentKey: scope.agentKey, source: 'UPDATE' },
    });
    throw new ApiError(409, 'MEMORY_INTEGRITY_FAILED', 'Memory integrity check failed');
  }

  const current = row.content as MemoryEnvelope;
  if (typeof patch.expectedRevision === 'number' && patch.expectedRevision !== current.revision) {
    throw new ApiError(409, 'MEMORY_REVISION_MISMATCH', 'Memory was changed by another request', {
      details: { currentRevision: current.revision },
    });
  }

  const type = patch.type ?? (row.kind as MemoryType);
  if (!MEMORY_TYPES.includes(type)) {
    throw ApiError.validation([{ field: 'type', message: 'Unknown memory type', code: 'ENUM' }]);
  }
  const text = patch.text !== undefined ? assertText(patch.text) : current.text;
  const entity =
    patch.entityType !== undefined || patch.entityId !== undefined
      ? assertEntity(patch.entityType ?? null, patch.entityId ?? null)
      : { entityType: current.entityType, entityId: current.entityId };
  if (patch.taskId !== undefined && patch.taskId !== current.taskId) {
    // The task link is written once: re-pointing a note at another task would
    // let a caller relabel history. Omitted means "leave as is".
    throw ApiError.validation([
      { field: 'taskId', message: 'taskId cannot be changed', code: 'IMMUTABLE' },
    ]);
  }

  const now = new Date();
  const revision = current.revision + 1;
  const ttlDays =
    patch.ttlDays !== undefined && patch.ttlDays !== null
      ? resolveTtlDays(type, patch.ttlDays)
      : Math.max(
          1,
          Math.round((new Date(current.expiresAt ?? now).getTime() - now.getTime()) / 86_400_000),
        );
  const envelope: MemoryEnvelope = {
    v: 1,
    text,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
    taskId: current.taskId ?? null,
    entityType: entity.entityType,
    entityId: entity.entityId,
    revision,
    checksum: memoryChecksum({ agentKey: scope.agentKey, ownerId, type, revision, text }),
  };

  await db
    .update(agentMemory)
    .set({ kind: type, content: envelope as never })
    .where(and(eq(agentMemory.id, id), ownerAgentWhere(scope)));

  await writeAudit(db, audit, {
    action: 'AI.MEMORY_UPDATED',
    entityType: 'AGENT_MEMORY',
    entityId: id,
    metadata: { agentKey: scope.agentKey, type, revision, chars: text.length, expiresAt: envelope.expiresAt },
  });

  return toView({ id, agentKey: scope.agentKey, kind: type, content: envelope, createdAt: row.createdAt });
}

/** Deletes one of the caller's own memories. Idempotent from the caller's view. */
export async function forgetMemory(
  db: DB,
  scope: MemoryScope,
  id: string,
  audit: AuditContext,
): Promise<{ id: string; deleted: boolean }> {
  assertAgentCanHoldMemory(scope.agentKey);
  assertOwner(scope.ownerId);
  const deleted = await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.id, id), ownerAgentWhere(scope)))
    .returning({ id: agentMemory.id });
  if (deleted.length === 0) throw ApiError.notFound('Memory');
  await writeAudit(db, audit, {
    action: 'AI.MEMORY_FORGOTTEN',
    entityType: 'AGENT_MEMORY',
    entityId: id,
    metadata: { agentKey: scope.agentKey },
  });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Agent run integration — bounded, deterministic, owner-scoped
// ---------------------------------------------------------------------------

/**
 * The compact recall injected into a run context (`priorContext`). Only the
 * running agent's own memories for the run's owner, newest first, truncated to
 * a fixed character budget so a long note can never crowd out the task.
 */
export async function buildPriorContext(
  db: DB,
  agentKey: string,
  ownerId: string,
  audit: AuditContext,
): Promise<string | undefined> {
  try {
    const scope: MemoryScope = { ownerId, agentKey };
    const rows = await db
      .select()
      .from(agentMemory)
      .where(and(ownerAgentWhere(scope), notExpired()))
      .orderBy(desc(sql`coalesce((${agentMemory.content}->>'updatedAt')::timestamptz, ${agentMemory.createdAt})`))
      .limit(5);
    const lines: string[] = [];
    let used = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!verifyIntegrity(row)) {
        skipped += 1;
        continue;
      }
      const envl = row.content as MemoryEnvelope;
      const line = `- [${row.kind}] ${envl.text.replace(/\s+/g, ' ').trim()} (rev ${envl.revision})`;
      if (used + line.length > env.AI_MEMORY_RUN_CONTEXT_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0 && skipped === 0) return undefined;
    await writeAudit(db, audit, {
      action: 'AI.MEMORY_RECALLED',
      entityType: 'AGENT_MEMORY',
      metadata: { agentKey, count: lines.length, source: 'RUN_CONTEXT', tampered: skipped },
    });
    if (lines.length === 0) return undefined;
    return `Recalled memory for ${agentKey} (${lines.length}):\n${lines.join('\n')}`;
  } catch {
    // Recall is advisory: a failure must never fail the task it informs.
    return undefined;
  }
}

export interface TaskOutcomeMemoryInput {
  agentKey: string;
  ownerId: string;
  taskId: string;
  status: string;
  latencyMs: number;
  taskType?: string | null;
  errorCode?: string | null;
}

/**
 * Task results are a rolling log: when the agent's budget is full, the oldest
 * `task_result` rows are dropped to make room. Owner-authored notes are never
 * evicted this way — a run must not delete what its owner chose to keep.
 */
async function makeRoomForAutoRecord(db: DB, scope: MemoryScope): Promise<void> {
  const live = await liveCount(db, ownerAgentWhere(scope));
  if (live < env.AI_MEMORY_MAX_PER_AGENT) return;
  const excess = live - env.AI_MEMORY_MAX_PER_AGENT + 1;
  const oldest = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(ownerAgentWhere(scope), eq(agentMemory.kind, 'task_result'), notExpired()))
    .orderBy(sql`coalesce((${agentMemory.content}->>'updatedAt')::timestamptz, ${agentMemory.createdAt})`)
    .limit(excess);
  if (oldest.length === 0) return;
  await db.delete(agentMemory).where(inArray(agentMemory.id, oldest.map((row) => row.id)));
}

/**
 * Records one deterministic `task_result` memory per terminal task: status,
 * latency and an error code. It never stores the task's output, an agent's
 * advice or a model guess — those are not facts the platform can vouch for.
 * Idempotent: a task that is settled twice updates its single row.
 */
export async function recordTaskOutcomeMemory(db: DB, input: TaskOutcomeMemoryInput): Promise<void> {
  if (!env.AI_MEMORY_AUTO_RECORD) return;
  if (input.ownerId === 'system' || !input.ownerId) return;
  const text = `Task ${input.taskId} ${input.status} in ${Math.max(0, Math.round(input.latencyMs))}ms` +
    `${input.taskType ? ` (type ${input.taskType})` : ''}` +
    `${input.errorCode ? ` code ${input.errorCode}` : ''}`;
  const scope: MemoryScope = { ownerId: input.ownerId, agentKey: input.agentKey };

  const existing = await db
    .select()
    .from(agentMemory)
    .where(
      and(
        ownerAgentWhere(scope),
        eq(agentMemory.kind, 'task_result'),
        sql`${agentMemory.content}->>'taskId' = ${input.taskId}`,
      ),
    )
    .limit(1);

  const now = new Date();
  const ttlDays = resolveTtlDays('task_result', null);
  const revision = existing[0] ? ((existing[0].content as MemoryEnvelope).revision ?? 1) + 1 : 1;
  const envelope: MemoryEnvelope = {
    v: 1,
    text,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
    taskId: input.taskId,
    entityType: null,
    entityId: null,
    revision,
    checksum: memoryChecksum({
      agentKey: input.agentKey,
      ownerId: input.ownerId,
      type: 'task_result',
      revision,
      text,
    }),
  };

  if (existing[0]) {
    await db
      .update(agentMemory)
      .set({ content: envelope as never })
      .where(and(eq(agentMemory.id, existing[0].id), ownerAgentWhere(scope)));
  } else {
    await purgeExpiredMemories(db, { ownerId: input.ownerId });
    await makeRoomForAutoRecord(db, scope);
    await db.insert(agentMemory).values({
      id: newId(),
      agentKey: input.agentKey,
      scopeOwner: input.ownerId,
      kind: 'task_result',
      content: envelope as never,
      createdAt: now,
    });
  }

  await writeAudit(db, { actorId: input.ownerId }, {
    action: 'AI.MEMORY_RECORDED',
    entityType: 'AGENT_MEMORY',
    entityId: input.taskId,
    metadata: {
      agentKey: input.agentKey,
      type: 'task_result',
      source: 'TASK_RUN',
      status: input.status,
      revision,
    },
  });
}

// ---------------------------------------------------------------------------
// Supervision — aggregates and metadata only, one row at a time
// ---------------------------------------------------------------------------

export interface MemorySummary {
  agents: Array<{
    agentKey: string;
    entries: number;
    owners: number;
    expired: number;
    oldest: string | null;
    newest: string | null;
    byType: Record<string, number>;
  }>;
  totals: { entries: number; owners: number; expired: number };
}

/**
 * Oversight view: counts and ages per agent. Deliberately contains no note text
 * — an administrator supervising the layer does not need to read what every
 * tenant wrote, and the shape of this response makes bulk content export
 * impossible by construction.
 */
export async function memorySummaryForAdmin(db: DB): Promise<MemorySummary> {
  const rows = await db
    .select({
      agentKey: agentMemory.agentKey,
      kind: agentMemory.kind,
      owner: agentMemory.scopeOwner,
      createdAt: agentMemory.createdAt,
      expiresAt: sql<string | null>`${agentMemory.content}->>'expiresAt'`,
    })
    .from(agentMemory);

  const now = Date.now();
  const byAgent = new Map<string, MemorySummary['agents'][number]>();
  const ownersByAgent = new Map<string, Set<string>>();
  const owners = new Set<string>();
  let expiredTotal = 0;
  for (const row of rows) {
    const entry =
      byAgent.get(row.agentKey) ??
      {
        agentKey: row.agentKey,
        entries: 0,
        owners: 0,
        expired: 0,
        oldest: null,
        newest: null,
        byType: {} as Record<string, number>,
      };
    const expired = row.expiresAt ? new Date(row.expiresAt).getTime() <= now : false;
    entry.entries += 1;
    entry.byType[row.kind] = (entry.byType[row.kind] ?? 0) + 1;
    if (expired) {
      entry.expired += 1;
      expiredTotal += 1;
    }
    const created = row.createdAt.toISOString();
    if (!entry.oldest || created < entry.oldest) entry.oldest = created;
    if (!entry.newest || created > entry.newest) entry.newest = created;
    byAgent.set(row.agentKey, entry);
    const agentOwners = ownersByAgent.get(row.agentKey) ?? new Set<string>();
    agentOwners.add(row.owner);
    ownersByAgent.set(row.agentKey, agentOwners);
    owners.add(row.owner);
  }
  for (const [agentKey, entry] of byAgent) {
    entry.owners = ownersByAgent.get(agentKey)?.size ?? 0;
  }
  return {
    agents: [...byAgent.values()].sort((a, b) => a.agentKey.localeCompare(b.agentKey)),
    totals: { entries: rows.length, owners: owners.size, expired: expiredTotal },
  };
}

export interface MemoryMetadataQuery {
  ownerId?: string | null;
  agentKey?: string | null;
  type?: MemoryType | null;
  includeExpired?: boolean;
  limit?: number;
}

export interface MemoryMetadataView {
  id: string;
  agentKey: string;
  ownerId: string;
  type: MemoryType;
  taskId: string | null;
  entityType: string | null;
  entityId: string | null;
  revision: number;
  chars: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  expired: boolean;
  integrity: 'ok' | 'tampered';
}

/** Supervision listing: metadata only. Reading a note needs {@link inspectMemoryForAdmin}. */
export async function listMemoryMetadataForAdmin(
  db: DB,
  query: MemoryMetadataQuery,
): Promise<MemoryMetadataView[]> {
  const conditions = [];
  if (query.ownerId) conditions.push(eq(agentMemory.scopeOwner, query.ownerId));
  if (query.agentKey) conditions.push(eq(agentMemory.agentKey, query.agentKey));
  if (query.type) conditions.push(eq(agentMemory.kind, query.type));
  if (!query.includeExpired) conditions.push(notExpired());

  const rows = await db
    .select()
    .from(agentMemory)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentMemory.createdAt))
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));

  const now = Date.now();
  return rows.map((row) => {
    const envl = row.content as MemoryEnvelope;
    return {
      id: row.id,
      agentKey: row.agentKey,
      ownerId: row.scopeOwner,
      type: row.kind as MemoryType,
      taskId: envl.taskId ?? null,
      entityType: envl.entityType ?? null,
      entityId: envl.entityId ?? null,
      revision: envl.revision,
      chars: typeof envl.text === 'string' ? envl.text.length : 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: envl.updatedAt,
      expiresAt: envl.expiresAt ?? null,
      expired: envl.expiresAt ? new Date(envl.expiresAt).getTime() <= now : false,
      integrity: verifyIntegrity(row) ? 'ok' : 'tampered',
    };
  });
}

/**
 * Reads one note's content for oversight. Requires a stated reason, is scoped
 * to a single id (no bulk read), and is audited with that reason — the
 * supervisor interface is accountable, not unrestricted.
 */
export async function inspectMemoryForAdmin(
  db: DB,
  id: string,
  reason: string,
  audit: AuditContext,
): Promise<MemoryView & { ownerId: string }> {
  const trimmed = reason.trim();
  if (trimmed.length < 10) {
    throw ApiError.validation([
      { field: 'reason', message: 'A reason of at least 10 characters is required', code: 'MIN_LENGTH' },
    ]);
  }
  const rows = await db.select().from(agentMemory).where(eq(agentMemory.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw ApiError.notFound('Memory');
  if (!verifyIntegrity(row)) {
    await writeAudit(db, audit, {
      action: 'AI.MEMORY_INTEGRITY_FAILED',
      entityType: 'AGENT_MEMORY',
      entityId: id,
      metadata: { agentKey: row.agentKey, source: 'ADMIN_INSPECT' },
    });
    throw new ApiError(409, 'MEMORY_INTEGRITY_FAILED', 'Memory integrity check failed');
  }
  await writeAudit(db, audit, {
    action: 'AI.MEMORY_INSPECTED',
    entityType: 'AGENT_MEMORY',
    entityId: id,
    metadata: { agentKey: row.agentKey, ownerId: row.scopeOwner, reason: trimmed },
  });
  return { ...toView(row), ownerId: row.scopeOwner };
}
