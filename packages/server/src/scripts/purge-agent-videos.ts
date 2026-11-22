/**
 * Deletes agent-rendered videos older than AGENT_VIDEO_RETENTION_DAYS.
 *
 * Intended for the deployment scheduler (cron / platform job). It only walks
 * `agent-videos/` inside the media store, so `media_assets` objects are never
 * touched. Run it from `packages/server`:
 *
 *   npx tsx src/scripts/purge-agent-videos.ts [--days 7] [--dry-run]
 */
import { purgeAgentVideos } from '../modules/ai/agent-videos.js';
import { env } from '../lib/env.js';
import { closeDb } from '../db/client.js';

async function main(): Promise<void> {
  const daysArg = process.argv.indexOf('--days');
  const olderThanDays = daysArg > -1 ? Number(process.argv[daysArg + 1]) : env.AGENT_VIDEO_RETENTION_DAYS;
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new Error('--days must be a positive integer');
  }

  if (process.argv.includes('--dry-run')) {
    console.log(`[purge-agent-videos] dry run: retention ${olderThanDays} day(s), dir ${env.MEDIA_STORAGE_DIR}/agent-videos`);
    return;
  }

  const result = await purgeAgentVideos({ olderThanDays });
  console.log(
    `[purge-agent-videos] scanned=${result.scanned} deleted=${result.deleted} bytesFreed=${result.bytesFreed} retention=${result.olderThanDays}d`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error('[purge-agent-videos] failed:', error instanceof Error ? error.message : error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
