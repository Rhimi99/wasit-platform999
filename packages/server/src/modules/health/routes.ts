import { Hono } from 'hono';
import { pingDb } from '../../db/client.js';
import { getDb } from '../../lib/request-context.js';
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
    timestamp: new Date().toISOString(),
  }),
);