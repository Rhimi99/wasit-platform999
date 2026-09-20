import type { Context, Next } from 'hono';
import { ApiError } from '@wasit/shared';
import { getTraceId, getTraceInfo } from '../lib/request-context';
import { logger } from '../lib/observability/logger';

/** Converts a thrown error into a structured JSON error response. */
export function errorBody(err: unknown, c: Context): Response {
  const traceId = getTraceId(c);
  if (err instanceof ApiError) {
    err.traceId = traceId;
    return c.json(err.toBody(), err.statusCode as never);
  }
  // Validation errors from zod
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
    const fieldErrors = (err as { issues?: Array<{ path: (string | number)[]; message: string; code: string }> })
      .issues?.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
    const apiErr = ApiError.validation(fieldErrors ?? []);
    apiErr.traceId = traceId;
    return c.json(apiErr.toBody(), 422 as never);
  }
  // Unhandled errors are the ones worth a structured, paged record. The trace
  // id ties the log line back to the response the client saw.
  const trace = getTraceInfo(c);
  logger.error('unhandled error', {
    traceId,
    spanId: trace?.spanId,
    method: c.req.method,
    path: c.req.path,
    errorName: err instanceof Error ? err.name : typeof err,
    errorMessage: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  const apiErr = ApiError.internal('Internal server error');
  apiErr.traceId = traceId;
  return c.json(apiErr.toBody(), 500 as never);
}

/** Middleware that still delegates to next(); errors are handled by app.onError. */
export async function errorHandlerMiddleware(c: Context, next: Next): Promise<Response | void> {
  await next();
}