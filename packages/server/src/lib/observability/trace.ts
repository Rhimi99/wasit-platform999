import { randomBytes, randomUUID } from 'node:crypto';

/**
 * W3C Trace Context (`traceparent`) handling.
 *
 * We accept an inbound `traceparent` so a request that already carries a trace
 * (from a gateway, another service, or a load test) keeps the same trace id end
 * to end instead of starting a fresh one. When the header is absent or
 * malformed we mint a new trace id.
 *
 * The format is fixed by the spec:
 *   version(2 hex) "-" trace-id(32 hex) "-" parent-id(16 hex) "-" flags(2 hex)
 */

export interface TraceContext {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters — the caller's span id, when supplied. */
  parentId: string | null;
  /** Trace flags byte, e.g. `01` for sampled. */
  flags: string;
  /** Whether the values came from a valid inbound header. */
  inherited: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE = '00000000000000000000000000000000';
const ALL_ZERO_SPAN = '0000000000000000';

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Builds a `traceparent` for an outbound call, given this request's span. */
export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/**
 * Parses an inbound `traceparent`. Invalid headers (wrong shape, all-zero ids,
 * future versions) are rejected so we never adopt a nonsense trace id.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const [, version, traceId, parentId, flags] = match;
  // Version ff is forbidden by the spec; unknown higher versions are treated
  // as incompatible rather than guessed at.
  if (version.toLowerCase() === 'ff') return null;
  if (traceId === ALL_ZERO_TRACE || parentId === ALL_ZERO_SPAN) return null;
  return {
    traceId: traceId.toLowerCase(),
    parentId: parentId.toLowerCase(),
    flags: flags.toLowerCase(),
    inherited: true,
  };
}

/**
 * Resolves the trace for an inbound request: prefer a valid `traceparent`, then
 * a bare `x-trace-id` (simpler clients), otherwise generate one — but always
 * mint a fresh span id for this hop so a child span can be formed later.
 */
export function traceFromHeaders(headers: {
  traceparent?: string | null;
  traceId?: string | null;
}): TraceContext & { spanId: string } {
  const parsed = parseTraceparent(headers.traceparent);
  if (parsed) {
    return { ...parsed, spanId: newSpanId() };
  }
  const bare = headers.traceId?.trim();
  // A bare x-trace-id is not a validated trace-parent, but if it looks like a
  // 32-hex trace id we honour it; otherwise fall back to a generated one.
  if (bare && /^[0-9a-f]{32}$/i.test(bare) && bare.toLowerCase() !== ALL_ZERO_TRACE) {
    return {
      traceId: bare.toLowerCase(),
      parentId: null,
      flags: '01',
      inherited: true,
      spanId: newSpanId(),
    };
  }
  return {
    traceId: randomUUID().replace(/-/g, ''),
    parentId: null,
    flags: '01',
    inherited: false,
    spanId: newSpanId(),
  };
}