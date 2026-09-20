import type { Context, Next } from 'hono';
import { getTraceInfo } from '../lib/request-context';
import { logger } from '../lib/observability/logger';
import { metrics } from '../lib/observability/metrics';

/**
 * Request observability: one structured log line and one metrics sample per
 * request, tagged with the trace id.
 *
 * This replaces Hono's built-in `logger()`, which prints an unstructured line
 * with no trace id. Running both would double-log every request.
 *
 * The metric route label must stay low-cardinality, so an unmatched path is
 * normalised (ids and numbers collapse to placeholders) instead of being used
 * verbatim — otherwise `/api/products/<uuid>` would create one time series per
 * product.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;

function routeLabel(c: Context): string {
  const matched = c.req.routePath;
  if (matched && matched !== '*' && matched !== '/*') return matched;
  const segments = c.req.path.split('/').filter(Boolean);
  const normalised = segments.map((segment) => {
    if (UUID_RE.test(segment) || HEX_RE.test(segment)) return ':id';
    if (/^\d+$/.test(segment)) return ':n';
    return segment;
  });
  return '/' + normalised.join('/');
}

export function observabilityMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const startedAt = process.hrtime.bigint();
    await next();
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

    const route = routeLabel(c);
    const method = c.req.method;
    const status = c.res.status;
    const trace = getTraceInfo(c);
    const traceId = trace?.traceId ?? 'unknown';
    // Hono exposes the matched route through c.res for some paths, but routePath
    // on the request is the reliable source inside middleware.
    const durationMs = Number((durationSeconds * 1000).toFixed(2));

    metrics.incCounter('wasit_http_requests_total', { method, route, status: String(status) });
    metrics.observeHistogram('wasit_http_request_duration_seconds', durationSeconds, {
      method,
      route,
    });
    if (status >= 500) {
      metrics.incCounter('wasit_http_errors_total', { route, status: String(status) });
      logger.error('request failed', {
        traceId,
        method,
        route,
        status,
        durationMs,
        spanId: trace?.spanId,
      });
    } else {
      logger.info('request', {
        traceId,
        method,
        route,
        status,
        durationMs,
        spanId: trace?.spanId,
      });
    }
  };
}