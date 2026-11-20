import type { Context } from 'hono';
import type { DB } from '../db/client';
import type { UserRole } from '@wasit/shared';

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  isActive: boolean;
  /** Whether the account has an enabled second factor (TOTP). */
  mfaEnabled: boolean;
  roles: UserRole[];
}

export interface AppContext {
  db: DB;
  user: AuthUser | null;
  traceId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface TraceInfo {
  traceId: string;
  /** This hop's span id; parent of any downstream span. */
  spanId: string;
  parentId: string | null;
  flags: string;
  /** True when the trace id was adopted from an inbound header. */
  inherited: boolean;
}

const AppContextKey = Symbol('wasit.appContext');
const DbInstanceKey = Symbol('wasit.dbInstance');
const TraceKey = Symbol('wasit.traceId');
const TraceInfoKey = Symbol('wasit.traceInfo');

export function setDb(c: Context, db: DB): void {
  c.set(DbInstanceKey as never, db);
}

export function getDb(c: Context): DB {
  return c.get(DbInstanceKey as never);
}

export function setContext(c: Context, ctx: AppContext): void {
  c.set(AppContextKey as never, ctx);
}

/**
 * Replaces the authenticated user on the request context, preserving the rest of
 * the context. Used by the auth middleware to attach a user without rebuilding
 * the whole context object (which would drop the db/trace fields).
 */
export function setAuthUser(c: Context, user: AuthUser): void {
  const ctx = c.get(AppContextKey as never) as AppContext | undefined;
  if (!ctx) return;
  c.set(AppContextKey as never, { ...ctx, user });
}

export function getContext(c: Context): AppContext {
  return c.get(AppContextKey as never);
}

export function setTraceId(c: Context, traceId: string): void {
  c.set(TraceKey as never, traceId);
}

export function getTraceId(c: Context): string {
  return c.get(TraceKey as never) ?? 'unknown';
}

export function setTraceInfo(c: Context, info: TraceInfo): void {
  c.set(TraceInfoKey as never, info);
}

/**
 * The full trace context for the request, or null outside a request (e.g. in
 * the scheduler). Used to enrich logs and to build outbound `traceparent`
 * headers for future service-to-service calls.
 */
export function getTraceInfo(c: Context): TraceInfo | null {
  return c.get(TraceInfoKey as never) ?? null;
}

/**
 * Outbound propagation header for this request, or null when not in a request.
 * Downstream services can adopt the same trace id.
 */
export function outboundTraceparent(c: Context): string | null {
  const info = getTraceInfo(c);
  if (!info) return null;
  return `00-${info.traceId}-${info.spanId}-${info.flags}`;
}