import type { Context, Next } from 'hono';
import { db } from '../db/client';
import { setContext, setDb, setTraceId, setTraceInfo } from '../lib/request-context';
import { traceFromHeaders } from '../lib/observability/trace';
import { resolveClientIp } from '../lib/net/client-ip';

export async function coreMiddleware(c: Context, next: Next): Promise<Response | void> {
  // Adopt an inbound W3C trace when present so a request keeps one trace id
  // across a gateway/other services; otherwise generate one.
  const trace = traceFromHeaders({
    traceparent: c.req.header('traceparent'),
    traceId: c.req.header('x-trace-id'),
  });
  setTraceId(c, trace.traceId);
  setTraceInfo(c, {
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentId: trace.parentId,
    flags: trace.flags,
    inherited: trace.inherited,
  });
  setDb(c, db);

  const ipAddress = resolveClientIp(c);
  const userAgent = c.req.header('user-agent') ?? null;

  setContext(c, {
    db,
    user: null,
    traceId: trace.traceId,
    ipAddress,
    userAgent,
  });

  c.header('X-Trace-Id', trace.traceId);
  return next();
}