import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '../..');
const read = (p: string): string => readFileSync(resolve(serverRoot, p), 'utf8');

const MIGRATION_0032 = 'src/db/migrations/0032_agent_task_dedupe_indexes.sql';
const SCHEMA_AGENTS = 'src/db/schema/agents.ts';

/**
 * Terminal statuses excluded from the partial unique index. This is the exact
 * set Master settles a task to (`modules/ai/agents.ts`): `succeeded`, `failed`,
 * `rejected`, and `approved` (the approval path ends a task at `approved` with
 * `completedAt` set — so it is terminal, not open).
 */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'rejected', 'approved'] as const;
const TERMINAL_TUPLE_SQL = "('succeeded', 'failed', 'rejected', 'approved')";

/** Statuses that are NOT terminal — an open task still governed by the index. */
const OPEN_STATUSES = ['queued', 'running', 'awaiting_approval'] as const;

interface TaskRow {
  requestedBy: string;
  dedupeKey: string | null;
  status: string;
}

/** Mirrors the SQL predicate: a row is constrained only when open and keyed. */
function isConstrained(row: TaskRow): boolean {
  return row.dedupeKey !== null && !TERMINAL_STATUSES.includes(row.status as never);
}

/**
 * Models the partial unique index. Inserting `candidate` is rejected iff it is
 * constrained and another constrained row already shares its
 * (requested_by, dedupe_key).
 */
function violatesIndex(existing: TaskRow[], candidate: TaskRow): boolean {
  if (!isConstrained(candidate)) return false;
  return existing.some(
    (r) => r.requestedBy === candidate.requestedBy && r.dedupeKey === candidate.dedupeKey && isConstrained(r),
  );
}

const owner = 'user-1';
const key = 'order.placed:42';

describe('agent_tasks dedupe partial unique index — predicate semantics', () => {
  it('rejects a second OPEN task with the same (requested_by, dedupe_key)', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status: 'running' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(true);
  });

  it('allows a new task after the previous one SUCCEEDED', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status: 'succeeded' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(false);
  });

  it('allows a new task after the previous one was APPROVED (terminal)', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status: 'approved' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(false);
  });

  it('allows a new task after the previous one FAILED', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status: 'failed' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(false);
  });

  it('allows a new task after the previous one was REJECTED', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status: 'rejected' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(false);
  });

  it('keeps every open status governed by the index', () => {
    for (const status of OPEN_STATUSES) {
      const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: key, status }];
      expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(true);
      // A terminal row is never blocked by an open one either.
      expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'succeeded' })).toBe(false);
    }
  });

  it('never constrains a NULL dedupe_key', () => {
    const existing: TaskRow[] = [{ requestedBy: owner, dedupeKey: null, status: 'running' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: null, status: 'running' })).toBe(false);
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'running' })).toBe(false);
  });

  it('scopes the key per owner (another owner never collides)', () => {
    const existing: TaskRow[] = [{ requestedBy: 'user-2', dedupeKey: key, status: 'running' }];
    expect(violatesIndex(existing, { requestedBy: owner, dedupeKey: key, status: 'queued' })).toBe(false);
  });
});

describe('migration 0032 — SQL text matches the predicate and guards duplicates', () => {
  const sql = read(MIGRATION_0032);

  it("uses the terminal set ('succeeded','failed','rejected','approved')", () => {
    expect(sql).toContain(TERMINAL_TUPLE_SQL);
  });

  it("does not treat the unbounded 'blocked' status as terminal", () => {
    expect(sql).not.toContain("'blocked'");
  });

  it('refuses to build the index when duplicate open keys exist', () => {
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('HAVING count(*) > 1');
    // It must not mutate data.
    expect(sql).not.toMatch(/\bDELETE\b/);
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });

  it('creates the partial unique index on (requested_by, dedupe_key)', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_dedupe_open_uidx"');
    expect(sql).toContain('"requested_by","dedupe_key"');
  });
});

describe('schema/agents.ts — index predicate matches the migration', () => {
  const src = read(SCHEMA_AGENTS);

  it('declares the same terminal tuple as the migration', () => {
    expect(src).toContain(TERMINAL_TUPLE_SQL);
  });

  it("does not reference 'blocked' as a terminal status", () => {
    expect(src).not.toContain("'blocked'");
  });
});
