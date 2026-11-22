import { readFileSync } from 'node:fs';
import { env } from '../env';

export interface BackupStatus {
  configured: boolean;
  heartbeat: string;
  lastSuccessAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
}

/**
 * Backup freshness, read from the heartbeat the backup script writes.
 *
 * The operator-visible half of the `backup_stale` alert: a deployment can see
 * whether its schedule is alive without querying the filesystem directly.
 * Shared by `/api/health/channels` and the operational snapshot so both report
 * the same numbers from the same source.
 */
export function backupStatus(): BackupStatus {
  const path = env.BACKUP_HEARTBEAT_FILE;
  const maxAgeHours = env.BACKUP_MAX_AGE_HOURS;
  if (!path) {
    return { configured: false, heartbeat: '', lastSuccessAt: null, ageHours: null, maxAgeHours };
  }
  try {
    const at = (JSON.parse(readFileSync(path, 'utf8')) as { at?: string }).at ?? null;
    const ageHours = at ? Number(((Date.now() - new Date(at).getTime()) / 3_600_000).toFixed(2)) : null;
    return { configured: true, heartbeat: path, lastSuccessAt: at, ageHours, maxAgeHours };
  } catch {
    return { configured: true, heartbeat: path, lastSuccessAt: null, ageHours: null, maxAgeHours };
  }
}
