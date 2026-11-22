import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { purgeAgentVideos, classifyAgentVideo, parseAgentVideoKey } from '../src/modules/ai/agent-videos.js';
import { db } from '../src/db/client.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { env } from '../src/lib/env.js';

/**
 * AI-FIRST-COMPLETION-05 — per-class agent video retention.
 *
 * The policy is test 7d / draft 30d / approved never, and it is decided from the
 * task row, never from the filename. These cases pin every branch, including the
 * ones where the safe answer is "keep": an orphan file, a key whose owner does
 * not match the task, and a task that is still running.
 */
const DAY = 86_400_000;
const createdTaskIds: string[] = [];
const ownerId = randomUUID();
const otherId = randomUUID();

async function insertTask(
  overrides: Partial<{ status: string; input: Record<string, unknown>; approvedAt: Date | null; requestedBy: string }> = {},
): Promise<string> {
  const id = randomUUID();
  createdTaskIds.push(id);
  await db.insert(agentTasks).values({
    id,
    agentKey: 'marketing-video-agent',
    requestedBy: overrides.requestedBy ?? ownerId,
    input: overrides.input ?? {},
    status: overrides.status ?? 'succeeded',
    approvedAt: overrides.approvedAt ?? null,
  });
  return id;
}

async function writeVideo(owner: string, taskId: string, ageDays: number, bytes = 1024): Promise<string> {
  const dir = path.join(env.MEDIA_STORAGE_DIR, 'agent-videos', owner);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}-abcdef123456.mp4`);
  await writeFile(file, Buffer.alloc(bytes, 7));
  const when = new Date(Date.now() - ageDays * DAY);
  await utimes(file, when, when);
  return file;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true).catch(() => false);
}

describe('AFC-05 — agent video retention by class', () => {
  beforeAll(async () => {
    await db.delete(agentTasks).where(inArray(agentTasks.requestedBy, [ownerId, otherId]));
  });

  afterAll(async () => {
    await db.delete(agentTasks).where(inArray(agentTasks.id, createdTaskIds));
  });

  it('parses only the executor layout', () => {
    const id = randomUUID();
    expect(parseAgentVideoKey(`agent-videos/${ownerId}/${id}-deadbeef.mp4`)).toEqual({ owner: ownerId, taskId: id });
    expect(parseAgentVideoKey('agent-videos/x/notes.mp4')).toBeNull();
    expect(parseAgentVideoKey('media/agent-videos/x/a.mp4')).toBeNull();
  });

  it('classifies from the task row, and keeps what it cannot prove', () => {
    const id = randomUUID();
    const parsed = { owner: ownerId, taskId: id };
    const base = { requestedBy: ownerId, status: 'succeeded', input: {}, approvedAt: null };

    expect(classifyAgentVideo(parsed, { ...base, approvedAt: new Date() }).klass).toBe('APPROVED');
    expect(classifyAgentVideo(parsed, { ...base, input: { renderTest: true } }).klass).toBe('TEST');
    expect(classifyAgentVideo(parsed, { ...base, input: { mode: 'test' } }).klass).toBe('TEST');
    expect(classifyAgentVideo({ owner: 'system', taskId: id }, { ...base, requestedBy: 'system' }).klass).toBe('TEST');
    expect(classifyAgentVideo(parsed, base).klass).toBe('DRAFT');

    expect(classifyAgentVideo(parsed, { ...base, status: 'running' }).klass).toBe('UNKNOWN');
    expect(classifyAgentVideo(parsed, { ...base, requestedBy: otherId }).klass).toBe('UNKNOWN');
    expect(classifyAgentVideo(parsed, undefined).klass).toBe('UNKNOWN');
    expect(classifyAgentVideo(null, base).klass).toBe('UNKNOWN');
  });

  it('applies 7d to tests, 30d to drafts, and never to approved videos', async () => {
    const testOld = await writeVideo(ownerId, await insertTask({ input: { renderTest: true } }), 8);
    const testFresh = await writeVideo(ownerId, await insertTask({ input: { renderTest: true } }), 6);
    const draftOld = await writeVideo(ownerId, await insertTask(), 31);
    const draftFresh = await writeVideo(ownerId, await insertTask(), 29);
    const approvedOld = await writeVideo(ownerId, await insertTask({ approvedAt: new Date() }), 400);
    const running = await writeVideo(ownerId, await insertTask({ status: 'running' }), 400);
    const orphan = await writeVideo(ownerId, randomUUID(), 400);
    const mismatched = await writeVideo(otherId, await insertTask({ requestedBy: ownerId }), 400);

    const result = await purgeAgentVideos(db);

    expect(await exists(testOld)).toBe(false);
    expect(await exists(draftOld)).toBe(false);
    for (const survivor of [testFresh, draftFresh, approvedOld, running, orphan, mismatched]) {
      expect(await exists(survivor)).toBe(true);
    }

    expect(result.byClass.TEST.deleted).toBe(1);
    expect(result.byClass.DRAFT.deleted).toBe(1);
    expect(result.byClass.APPROVED.deleted).toBe(0);
    expect(result.byClass.UNKNOWN.deleted).toBe(0);
    expect(result.keptReasons.no_task_row).toBeGreaterThanOrEqual(1);
    expect(result.keptReasons.owner_mismatch).toBeGreaterThanOrEqual(1);
    expect(result.keptReasons.task_not_terminal).toBeGreaterThanOrEqual(1);
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('never touches media_assets files or audit rows', async () => {
    const mediaDir = path.join(env.MEDIA_STORAGE_DIR, 'media');
    await mkdir(mediaDir, { recursive: true });
    const asset = path.join(mediaDir, 'afc05-asset.mp4');
    await writeFile(asset, Buffer.alloc(512, 3));
    const old = new Date(Date.now() - 500 * DAY);
    await utimes(asset, old, old);

    const auditBefore = await db.select({ id: auditLogs.id }).from(auditLogs);
    await purgeAgentVideos(db);
    const auditAfter = await db.select({ id: auditLogs.id }).from(auditLogs);

    expect(await exists(asset)).toBe(true);
    expect(auditAfter.length).toBe(auditBefore.length);
  }, 30_000);

  it('is idempotent and leaves no empty owner directory behind', async () => {
    const first = await purgeAgentVideos(db);
    const second = await purgeAgentVideos(db);
    expect(second.deleted).toBe(0);
    expect(second.bytesFreed).toBe(0);
    expect(second.scanned).toBe(first.scanned);

    const root = path.join(env.MEDIA_STORAGE_DIR, 'agent-videos');
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      expect((await readdir(path.join(root, entry.name))).length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('honours explicit windows for a one-off run', async () => {
    const draft = await writeVideo(ownerId, await insertTask(), 10);
    const result = await purgeAgentVideos(db, { testDays: 7, draftDays: 9 });
    expect(result.retention).toEqual({ testDays: 7, draftDays: 9 });
    expect(await exists(draft)).toBe(false);
  }, 30_000);
});
