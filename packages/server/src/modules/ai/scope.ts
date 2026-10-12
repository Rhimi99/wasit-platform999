import { ApiError, type UserRole } from '@wasit/shared';
import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client';

/**
 * Owner scope for agent data (metrics + memory).
 *
 * Every read/write against `agent_metrics` / `agent_memory` must be scoped to a
 * single owner. The owner is the authenticated **user id** of whoever caused the
 * task — never a seller entity, never a company, and never the shared scheduler
 * principal. A caller that cannot produce such an id is refused with `NO_SCOPE`
 * rather than silently widened to a platform-wide read.
 */

/** A user id that has been validated as a real owner. Branded so a bare string
 * cannot be passed where a validated owner is required. */
export type OwnerId = string & { readonly __brand: 'OwnerId' };

/** The scheduler principal. It is *not* a data owner: it may never read another
 * user's memory, and any row it writes is attributed to no owner. */
export const SYSTEM_PRINCIPAL = 'system';

/** The refusal code surfaced when no trustworthy owner can be established. */
export const NO_SCOPE = 'NO_SCOPE';

export interface AgentScopeCtx {
  /** The single owner whose rows this operation may touch. */
  readonly owner: OwnerId;
  /**
   * Platform scope: may read **aggregate** metrics across owners. It never grants
   * access to another owner's memory content. It is set ONLY by
   * {@link deriveScope} after {@link resolvePlatformScope} confirms, server-side,
   * that the user holds an admin role (`ADMIN`/`SUPER_ADMIN`). It must never be
   * taken from request input — the `ScopeSource.platform` boolean is a hint that
   * is ignored.
   */
  readonly isPlatform: boolean;
}

/** Inputs a scope may be derived from. These are trusted *sources*, not claims:
 * `userId` comes from `ctx.user.id` (routes) or `__userId` (executor). There is
 * deliberately no `platform` field: platform scope is never caller-supplied. */
export interface ScopeSource {
  userId?: string | null;
}

/**
 * Scopes produced by {@link deriveScope}/{@link derivePlatformScope}. A context
 * object that was hand-built (e.g. by forging `isPlatform: true`) is not in this
 * set and is rejected by {@link assertValidScope}. TypeScript types vanish at
 * runtime, so this WeakSet is the actual barrier.
 */
const VALID_SCOPES = new WeakSet<object>();

/** Thrown whenever an operation is attempted without a trustworthy owner. */
export class NoScopeError extends ApiError {
  constructor(message = 'No owned data scope for this operation — refusing to run.') {
    super(403, 'FORBIDDEN', message, { details: { code: NO_SCOPE } });
    this.name = 'NoScopeError';
  }
}

function isRealUser(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0 && id !== SYSTEM_PRINCIPAL;
}

/**
 * Derives an owner-only {@link AgentScopeCtx} from a trusted user id, or throws
 * {@link NoScopeError} when no owner can be established.
 *
 * The scheduler principal (`system`) is never a valid owner, so a scheduled task
 * that carries no user id is refused rather than granted a shared bucket.
 * Platform scope is **never** set here: a caller must call
 * {@link derivePlatformScope}, which verifies the permission server-side.
 */
export function deriveScope(source: ScopeSource): AgentScopeCtx {
  if (!isRealUser(source.userId)) throw new NoScopeError();
  const ctx: AgentScopeCtx = { owner: source.userId as OwnerId, isPlatform: false };
  VALID_SCOPES.add(ctx);
  return ctx;
}

/** Narrowing helper for call sites that prefer a result over an exception. */
export function tryDeriveScope(source: ScopeSource): AgentScopeCtx | null {
  try {
    return deriveScope(source);
  } catch {
    return null;
  }
}

/** The minimal role shape needed to authorize platform scope. */
export interface PlatformRoleSource {
  roles: readonly UserRole[];
}

/**
 * Server-side authorization for platform scope.
 *
 * Returns `true` only when the supplied, already-authenticated roles include an
 * admin role (`ADMIN`/`SUPER_ADMIN`). Platform-wide access is deliberately
 * restricted to admins: holding `analytics:read:all` is NOT sufficient here, so
 * support/risk/dispute roles can no longer read across owners. Roles must come
 * from a trusted, server-side identity check (e.g. the session), never from
 * request input. The scheduler principal is never granted platform scope here.
 *
 * A route wiring this in must pass the roles it resolved server-side; it must
 * never forward a `platform` flag from the request body.
 */
export function resolvePlatformScope(source: PlatformRoleSource): boolean {
  const roles = source.roles ?? [];
  return roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
}

/**
 * Builds a scope that may read platform-wide **aggregates**, after verifying the
 * caller's roles server-side. Use this instead of hand-setting `isPlatform`.
 */
export function derivePlatformScope(source: ScopeSource, authz: PlatformRoleSource): AgentScopeCtx {
  if (!isRealUser(source.userId)) throw new NoScopeError();
  if (!resolvePlatformScope(authz)) throw new NoScopeError('Platform scope not granted for this user.');
  const ctx: AgentScopeCtx = { owner: source.userId as OwnerId, isPlatform: true };
  VALID_SCOPES.add(ctx);
  return ctx;
}

/**
 * Runtime guard every repository operation must call. Rejects a context that was
 * not produced by {@link deriveScope}/{@link derivePlatformScope} — e.g. an
 * object literal with `isPlatform: true` — and any missing owner. This is the
 * actual enforcement; a TypeScript type alone is not a security barrier.
 */
export function assertValidScope(ctx: AgentScopeCtx | null | undefined): AgentScopeCtx {
  if (!ctx || typeof ctx !== 'object' || !VALID_SCOPES.has(ctx as object)) {
    throw new NoScopeError('Scope was not derived from a trusted source — refusing to run.');
  }
  if (!isRealUser((ctx as AgentScopeCtx).owner)) throw new NoScopeError();
  return ctx;
}

/**
 * Server-side platform check used by repositories that need to confirm platform
 * scope from the database rather than a role array (mirrors the executor's
 * `canReadPlatformData`). Kept for call sites that only have a user id.
 * Grants only to admins (`ADMIN`/`SUPER_ADMIN`).
 */
export async function userHasPlatformScope(db: DB, userId: string): Promise<boolean> {
  if (!isRealUser(userId)) return false;
  const res = await db.execute<{ role_name: string }>(sql`
    select r.name as role_name
    from user_roles ur
    join roles r on r.id = ur.role_id
    where ur.user_id = ${userId}
  `);
  const rows = (res as unknown as { rows: { role_name: string }[] }).rows ?? [];
  return resolvePlatformScope({ roles: rows.map((r) => r.role_name as UserRole) });
}
