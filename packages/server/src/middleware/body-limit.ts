import type { Context, Next } from 'hono';
import { ApiError } from '@wasit/shared';
import { env } from '../lib/env';

/**
 * Application-level request body cap (011.4).
 *
 * nginx already caps the body at the edge, but a deployment that exposes the API
 * directly (or runs behind a different proxy) would otherwise let an arbitrarily
 * large payload be buffered into memory before a route's schema rejects it. This
 * rejects an oversized request with a structured 413 *before* any handler — or
 * the JSON parse — runs.
 *
 * The cap is read per request from live config so an operator can tune
 * `MAX_REQUEST_BODY_BYTES` without a rebuild. It is sized well above the largest
 * legitimate JSON body (long AI prompts). The one wider allowance is the
 * product-image upload, which carries a real binary; `resolveMax` lets the app
 * grant that route exactly its own ceiling (image bytes + multipart envelope)
 * while every other route keeps the JSON cap. The rejection carries the same
 * error envelope as every other error and never echoes the size or any internal
 * detail.
 */
export function requestBodyLimit(
  resolveMax: (path: string) => number = () => env.MAX_REQUEST_BODY_BYTES,
) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const raw = c.req.raw;
    if (!raw.body) return next();

    const max = resolveMax(c.req.path);
    const contentLength = raw.headers.get('content-length');
    if (contentLength !== null && !raw.headers.has('transfer-encoding')) {
      if (Number.parseInt(contentLength, 10) > max) return tooLarge();
      return next();
    }

    // No reliable length header (chunked or a streamed body): buffer and measure,
    // then rebuild the request so the handler still reads the full body.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = raw.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
    c.req.raw = new Request(raw, {
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    return next();
  };
}

function tooLarge(): Response {
  const err = ApiError.payloadTooLarge();
  return new Response(
    JSON.stringify({
      success: false,
      error: { code: err.code, message: err.message, statusCode: err.statusCode },
    }),
    { status: 413, headers: { 'content-type': 'application/json' } },
  );
}
