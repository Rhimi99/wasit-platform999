import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { pingDb } from '../../db/client.js';
import { getDb } from '../../lib/request-context.js';
import { env } from '../../lib/env.js';
import { mailStatus } from '../../lib/mail/resolve.js';
import { smsStatus } from '../../lib/sms/resolve.js';
import { rateLimitStoreStatus } from '../../lib/rate-limit/resolve.js';
import { alertStatus } from '../../lib/observability/resolve-notifier.js';
import { describeMediaProviders } from '../../lib/media/resolve.js';
import { readCacheStatus } from '../../lib/cache/resolve.js';

export const healthRoutes = new Hono();

healthRoutes.get('/live', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

healthRoutes.get('/ready', async (c) => {
  try {
    await pingDb();
    return c.json({ status: 'ready', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    return c.json(
      { status: 'not_ready', db: 'disconnected', error: (err as Error).message },
      503 as never,
    );
  }
});

// Backup freshness, read from the heartbeat the backup script writes. This is
// the operator-visible half of the `backup_stale` alert: a deployment can see
// whether its schedule is alive without querying the filesystem directly.
function backupStatus(): {
  configured: boolean;
  heartbeat: string;
  lastSuccessAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
} {
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

// Outbound channel configuration (no credentials). Useful to confirm that a
// deployment has a real transport before relying on email/SMS verification.
// `observability.alerts` reports the active alert notifier so an operator can
// confirm delivery is wired before relying on it.
healthRoutes.get('/channels', async (c) =>
  c.json({
    status: 'ok',
    mail: mailStatus(),
    sms: smsStatus(),
    rateLimit: rateLimitStoreStatus(getDb(c)),
    cache: await readCacheStatus(),
    observability: { alerts: alertStatus() },
    media: await describeMediaProviders(),
    backup: backupStatus(),
    timestamp: new Date().toISOString(),
  }),
);