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
 *  - Retention is a policy (`AGENT_VIDEO_RETENTION_DAYS`), applied by an
 *    explicit purge, never silently on read.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
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
  bytesFreed: number;
  olderThanDays: number;
}

/**
 * Deletes agent video files older than the retention window.
 *
 * Walks only `agent-videos/` inside the media root — never the whole store — so
 * a purge can never touch a `media_assets` object.
 */
export async function purgeAgentVideos(options: { olderThanDays?: number; now?: Date } = {}): Promise<PurgeResult> {
  const olderThanDays = options.olderThanDays ?? env.AGENT_VIDEO_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - olderThanDays * 86_400_000;
  const root = path.resolve(env.MEDIA_STORAGE_DIR, 'agent-videos');

  const result: PurgeResult = { scanned: 0, deleted: 0, bytesFreed: 0, olderThanDays };

  /** Returns how many files inside `dir` survived the purge. */
  async function walk(dir: string): Promise<number> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let remaining = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const kept = await walk(full);
        if (kept > 0) remaining += kept;
        else await rm(full, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      result.scanned += 1;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.mtimeMs < cutoff) {
        result.deleted += 1;
        result.bytesFreed += info.size;
        await rm(full, { force: true }).catch(() => undefined);
      } else {
        remaining += 1;
      }
    }
    return remaining;
  }

  await walk(root);
  return result;
}
