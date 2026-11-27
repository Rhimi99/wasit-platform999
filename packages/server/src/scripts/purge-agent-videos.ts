/**
 * Applies the agent-video retention policy. Runs from the deployment scheduler
 * (systemd timer / cron), never from a timer inside the Node process.
 *
 * Retention is per class and read from the database (see `purgeAgentVideos`):
 * temporary test renders expire after `AGENT_VIDEO_TEST_RETENTION_DAYS` (7),
 * drafts after `AGENT_VIDEO_DRAFT_RETENTION_DAYS` (30), approved videos never.
 * A file with no trustworthy classification is kept.
 *
 * Idempotent: a second run finds nothing to delete. Writes one audit row per
 * run that actually removed something, and prints a single JSON line so the
 * scheduler log is machine-readable.
 *
 *   npx tsx src/scripts/purge-agent-videos.ts [--test-days 7] [--draft-days 30]
 *        [--dry-run] [--json]
 */
import { purgeAgentVideos } from '../modules/ai/agent-videos.js';
import { writeAudit } from '../lib/audit.js';
import { db, closeDb } from '../db/client.js';
import { env } from '../lib/env.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): number | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const parsed = Number(args[i + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number of days`);
  return parsed;
};

async function main(): Promise<void> {
  const testDays = value('test-days');
  const draftDays = value('draft-days');
  const dryRun = flag('dry-run');
  const json = flag('json');

  const startedAt = Date.now();
  const result = await purgeAgentVideos(db, {
    testDays: testDays ?? env.AGENT_VIDEO_TEST_RETENTION_DAYS,
    draftDays: draftDays ?? env.AGENT_VIDEO_DRAFT_RETENTION_DAYS,
  });

  if (!dryRun && result.deleted > 0) {
    await writeAudit(
      db,
      { actorId: null, actorType: 'SYSTEM' },
      {
        action: 'AI.AGENT_VIDEO_PURGED',
        entityType: 'AGENT_VIDEO',
        metadata: {
          scanned: result.scanned,
          deleted: result.deleted,
          kept: result.kept,
          bytesFreed: result.bytesFreed,
          byClass: result.byClass,
          retention: result.retention,
          errors: result.errors.length,
        },
      },
    );
  }

  const report = {
    job: 'purge-agent-videos',
    ok: result.errors.length === 0,
    dryRun,
    durationMs: Date.now() - startedAt,
    ...result,
  };

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(
      `[purge-agent-videos] ${dryRun ? 'dry-run ' : ''}scanned=${result.scanned} deleted=${result.deleted} ` +
        `kept=${result.kept} bytesFreed=${result.bytesFreed} ` +
        `test=${result.retention.testDays}d draft=${result.retention.draftDays}d errors=${result.errors.length}`,
    );
    for (const error of result.errors) console.error(`[purge-agent-videos] error: ${error}`);
  }

  if (result.errors.length > 0) process.exitCode = 1;
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error('[purge-agent-videos] failed:', error instanceof Error ? error.message : error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
