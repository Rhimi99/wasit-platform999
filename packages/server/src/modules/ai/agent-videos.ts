/**
 * Agent-rendered video delivery (AI-FIRST-COMPLETION-04).
 *
 * The marketing video agent writes its MP4 into the media store under
 * `agent-videos/<requester>/…` and reports only the storage key. Until now there
 * was no way to fetch that file: the key was useless to the owner and the media
 * module only serves `media_assets` rows. This module closes that gap with an
 * authenticated, ownership-checked, Range-capable download — and a retention
 * purge, so the files do not accumulate forever.
 *
 * Rules:
 *  - The file is addressed by TASK id, never by a caller-supplied key. The key
 *    is read from the stored task result, so a caller cannot request an
 *    arbitrary object from the store.
 *  - Owner or platform staff only. No signed public URL, no static directory.
 *  - Retention is per class (test 7d, draft 30d, approved never), applied by an
 *    explicit purge, never silently on read.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiError, type UserRole } from '@wasit/shared';
import type { DB } from '../../db/client';
import { agentTasks } from '../../db/schema/agents';
import { env } from '../../lib/env';
import { resolveMediaStorage } from '../../lib/media/resolve';

export interface AgentVideoRef {
  taskId: string;
  storageKey: string;
  contentType: string;
  size: number;
  sha256: string | null;
  durationSeconds: number | null;
}

const PLATFORM_VIDEO_ROLES: readonly UserRole[] = ['ADMIN', 'SUPER_ADMIN'];

function parseAdvice(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const advice = (result as { advice?: unknown }).advice;
  if (typeof advice !== 'string') return null;
  try {
    const parsed = JSON.parse(advice);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the video a task produced, enforcing ownership before the storage key
 * is ever used.
 */
export async function resolveTaskVideo(db: DB, taskId: string, requesterId: string, roles: UserRole[]): Promise<AgentVideoRef> {
  const rows = await db
    .select({ id: agentTasks.id, requestedBy: agentTasks.requestedBy, result: agentTasks.result })
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId)))
    .limit(1);

  const task = rows[0];
  if (!task) throw ApiError.notFound('Agent task');

  const isStaff = roles.some((r) => PLATFORM_VIDEO_ROLES.includes(r));
  if (task.requestedBy !== requesterId && !isStaff) {
    // Same response as a missing task: a stranger cannot probe which ids exist.
    throw ApiError.notFound('Agent task');
  }

  const advice = parseAdvice(task.result);
  const video = advice?.video as Record<string, unknown> | null | undefined;
  const storageKey = typeof video?.storageKey === 'string' ? video.storageKey : null;
  if (!storageKey) {
    throw ApiError.conflict('This task did not produce a rendered video');
  }

  const storage = resolveMediaStorage();
  const size = await storage.size(storageKey);
  if (size === null) {
    throw ApiError.notFound('Rendered video');
  }

  return {
    taskId: task.id,
    storageKey,
    contentType: typeof video?.contentType === 'string' ? video.contentType : 'video/mp4',
    size,
    sha256: typeof video?.sha256 === 'string' ? video.sha256 : null,
    durationSeconds: typeof video?.durationSeconds === 'number' ? video.durationSeconds : null,
  };
}

/** Reads a byte range (or the whole object when no range is given). */
export async function readTaskVideo(ref: AgentVideoRef, range?: { start: number; end: number }): Promise<Buffer> {
  const storage = resolveMediaStorage();
  return range ? storage.getRange(ref.storageKey, range.start, range.end) : storage.get(ref.storageKey);
}

/** Parses a single-range `Range: bytes=start-end` header. */
export function parseVideoRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, s, e] = m;
  let start = s ? Number(s) : 0;
  let end = e ? Number(e) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start < 0) start = 0;
  if (end >= size) end = size - 1;
  if (start > end) return null;
  return { start, end };
}

export interface PurgeResult {
  scanned: number;
  deleted: number;
  kept: number;
  bytesFreed: number;
  /** Deletion window actually applied, per class. */
  retention: { testDays: number; draftDays: number };
  storage: string;
  byClass: Record<AgentVideoClass, { scanned: number; deleted: number; bytesFreed: number }>;
  /** Why individual files survived; never contains a storage key. */
  keptReasons: Record<string, number>;
  errors: string[];
}

/**
 * Deletes agent video files whose class-specific retention window has expired.
 *
 * Classification is read from the database, never guessed from the filename:
 *
 *  - APPROVED — the task carries `approvedAt` (a human decision). Never deleted
 *    automatically; removal is an explicit, separate authorisation.
 *  - TEST     — a temporary render (`input.renderTest === true`, `input.mode ===
 *    'test'`, or the `system` owner a script renders under). 7 days.
 *  - DRAFT    — a real render that nobody approved. 30 days.
 *  - UNKNOWN  — no task row, a key that does not match the layout, an owner
 *    mismatch, or a non-terminal task. Kept: with no trustworthy evidence the
 *    file must not be destroyed.
 *
 * Only `agent-videos/` under the local media root is walked, so a purge can
 * never touch a `media_assets` object or an audit row.
 */
export async function purgeAgentVideos(
  db: DB,
  options: { testDays?: number; draftDays?: number; now?: Date } = {},
): Promise<PurgeResult> {
  const testDays = options.testDays ?? env.AGENT_VIDEO_TEST_RETENTION_DAYS;
  const draftDays = options.draftDays ?? env.AGENT_VIDEO_DRAFT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const root = path.resolve(env.MEDIA_STORAGE_DIR, 'agent-videos');
  const storage = resolveMediaStorage();

  const result: PurgeResult = {
    scanned: 0,
    deleted: 0,
    kept: 0,
    bytesFreed: 0,
    retention: { testDays, draftDays },
    storage: storage.id,
    byClass: {
      TEST: { scanned: 0, deleted: 0, bytesFreed: 0 },
      DRAFT: { scanned: 0, deleted: 0, bytesFreed: 0 },
      APPROVED: { scanned: 0, deleted: 0, bytesFreed: 0 },
      UNKNOWN: { scanned: 0, deleted: 0, bytesFreed: 0 },
    },
    keptReasons: {},
    errors: [],
  };

  if (storage.id !== 'local') {
    // Enumerating an opaque object store is not implemented, and guessing would
    // mean deleting blind. Report instead of acting.
    result.errors.push(`storage "${storage.id}" cannot be enumerated; nothing was deleted`);
    return result;
  }

  const files: Array<{ full: string; key: string; size: number; mtimeMs: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      files.push({
        full,
        key: path.relative(path.resolve(env.MEDIA_STORAGE_DIR), full).split(path.sep).join('/'),
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  };
  await walk(root);

  const taskIds = files
    .map((f) => parseAgentVideoKey(f.key)?.taskId ?? null)
    .filter((id): id is string => id !== null);
  const tasks = new Map<string, { requestedBy: string; status: string; input: unknown; approvedAt: Date | null }>();
  if (taskIds.length > 0) {
    const rows = await db
      .select({
        id: agentTasks.id,
        requestedBy: agentTasks.requestedBy,
        status: agentTasks.status,
        input: agentTasks.input,
        approvedAt: agentTasks.approvedAt,
      })
      .from(agentTasks)
      .where(inArray(agentTasks.id, taskIds));
    for (const row of rows) tasks.set(row.id, row);
  }

  const keep = (reason: string): void => {
    result.kept += 1;
    result.keptReasons[reason] = (result.keptReasons[reason] ?? 0) + 1;
  };

  for (const file of files) {
    result.scanned += 1;
    const parsed = parseAgentVideoKey(file.key);
    const task = parsed ? tasks.get(parsed.taskId) : undefined;

    const classification = classifyAgentVideo(parsed, task);
    result.byClass[classification.klass].scanned += 1;

    if (classification.klass === 'UNKNOWN') {
      keep(classification.reason);
      continue;
    }
    if (classification.klass === 'APPROVED') {
      keep('approved');
      continue;
    }

    const windowDays = classification.klass === 'TEST' ? testDays : draftDays;
    const cutoff = now.getTime() - windowDays * 86_400_000;
    if (file.mtimeMs >= cutoff) {
      keep(`${classification.klass.toLowerCase()}_within_window`);
      continue;
    }

    try {
      await rm(file.full, { force: true });
      result.deleted += 1;
      result.bytesFreed += file.size;
      result.byClass[classification.klass].deleted += 1;
      result.byClass[classification.klass].bytesFreed += file.size;
    } catch (error) {
      result.errors.push(`${classification.klass}: ${error instanceof Error ? error.message : String(error)}`);
      keep('delete_failed');
    }
  }

  return result;
}

/** Storage layout written by the video executor: `agent-videos/<owner>/<taskId>-<hash>.mp4`. */
export function parseAgentVideoKey(key: string): { owner: string; taskId: string } | null {
  const m = /^agent-videos\/([^/]+)\/([0-9a-fA-F-]{36})-[0-9a-zA-Z]+\.mp4$/.exec(key);
  return m ? { owner: m[1], taskId: m[2] } : null;
}

export type AgentVideoClass = 'TEST' | 'DRAFT' | 'APPROVED' | 'UNKNOWN';

interface Classification {
  klass: AgentVideoClass;
  reason: string;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'rejected']);

export function classifyAgentVideo(
  parsed: { owner: string; taskId: string } | null,
  task: { requestedBy: string; status: string; input: unknown; approvedAt: Date | null } | undefined,
): Classification {
  if (!parsed) return { klass: 'UNKNOWN', reason: 'unrecognised_key' };
  if (!task) return { klass: 'UNKNOWN', reason: 'no_task_row' };
  if (task.requestedBy !== parsed.owner) return { klass: 'UNKNOWN', reason: 'owner_mismatch' };
  if (task.approvedAt) return { klass: 'APPROVED', reason: 'approved' };
  if (!TERMINAL_STATUSES.has(task.status)) return { klass: 'UNKNOWN', reason: 'task_not_terminal' };

  const input = task.input && typeof task.input === 'object' ? (task.input as Record<string, unknown>) : {};
  if (input.renderTest === true || input.mode === 'test' || parsed.owner === 'system') {
    return { klass: 'TEST', reason: 'test_render' };
  }
  return { klass: 'DRAFT', reason: 'draft' };
}

