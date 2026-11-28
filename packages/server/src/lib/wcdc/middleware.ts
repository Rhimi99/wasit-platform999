import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import { sessions } from '../../db/schema/auth';
import type { DB } from '../../db/client';
import { securityBlocks } from '../../db/schema/security';
import { env } from '../env';
import { getContext, getDb } from '../request-context';
import { resolveClientIp, UNKNOWN_CLIENT_KEY } from '../net/client-ip';
import { hashToken } from '../security';
import { SESSION_COOKIE } from '../../middleware/auth';
import { metrics } from '../observability/metrics';
import { logger } from '../observability/logger';
import { distinctCounter, hitCounter, recordSecurityEvent } from './collector';
import { resolveWcdcPolicy, type WcdcPolicy } from './policy';
import { maybeAutoContain } from './response';
import { scanRequest } from './signatures';
import {
  cachedBlockedIps,
  isTightened,
  rememberBlockedIps,
  TIGHTENED_LIMIT,
} from './enforcement';
import { ruleById } from './types';

/**
 * Request-side collection and enforcement.
 *
 * Order matters. A blocked address is refused before any body is read or any
 * route runs; a tightened limit is applied next; only then is the request
 * inspected. Observation happens on the way out too, because most signals
 * (401/403/404/429) only exist once the route has answered.
 *
 * This middleware never decides authorisation: it does not grant, widen or
 * bypass RBAC, MFA, CSRF or rate limiting. It only refuses *more* than they do,
 * and only for a bounded time.
 */

const STAFF_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'RISK', 'DISPUTE']);
const ADMIN_PATH = /^\/api\/admin(\/|$)/;
const RBAC_WRITE_PATH = /^\/api\/admin\/(staff|users)(\/|$)/;
const TENANT_PATH = /^\/api\/(inventory|orders|products|media|ads|rfq|messages|disputes)(\/|$)/;
const MEDIA_PATH = /^\/api\/media(\/|$)/;
const AUDIT_PATH = /^\/api\/admin\/(audit-logs|audit)(\/|$)/;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_SCAN_BYTES = 64 * 1024;

let policyCache: { at: number; value: WcdcPolicy } | null = null;
const POLICY_TTL_MS = 30_000;

/** Test seam: forget the cached policy. */
export function resetWcdcMiddlewareCache(): void {
  policyCache = null;
}

async function policyFor(db: DB): Promise<WcdcPolicy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  const value = await resolveWcdcPolicy(db);
  policyCache = { at: Date.now(), value };
  return value;
}

async function blockedIps(db: DB): Promise<Set<string>> {
  const cached = cachedBlockedIps();
  if (cached) return cached;
  try {
    const rows = await db
      .select({ target: securityBlocks.target })
      .from(securityBlocks)
      .where(
        and(
          eq(securityBlocks.kind, 'IP'),
          isNull(securityBlocks.revokedAt),
          gt(securityBlocks.expiresAt, new Date()),
        ),
      );
    const ips = new Set(rows.map((r) => r.target));
    rememberBlockedIps(ips);
    return ips;
  } catch (error) {
    logger.warn('wcdc: block list unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail open for *reading* the block list: the route guards still apply, and
    // a database outage that blocks every request would be the bigger incident.
    return new Set();
  }
}

const SCANNED_CONTENT_TYPES = ['application/json', 'application/x-www-form-urlencoded'];

/**
 * Reads a textual body for inspection without consuming the request's own body.
 * Multipart uploads are skipped on purpose: reading binary parts as text is
 * both expensive and a false-positive machine, and the upload routes validate
 * their own input.
 */
async function bodyForScan(c: Context): Promise<string | null> {
  if (!STATE_CHANGING.has(c.req.method.toUpperCase())) return null;
  const contentType = c.req.header('content-type') ?? '';
  if (!SCANNED_CONTENT_TYPES.some((type) => contentType.includes(type))) return null;
  // Only bodies with a declared, small length are cloned. A chunked upload with
  // no length would otherwise be buffered here before the body-limit middleware
  // downstream ever sees it, turning the inspector into a memory amplifier.
  const declaredHeader = c.req.header('content-length');
  const declared = declaredHeader ? Number(declaredHeader) : Number.NaN;
  if (!Number.isFinite(declared) || declared > MAX_SCAN_BYTES) return null;
  try {
    const text = await c.req.raw.clone().text();
    // `+` is the space in form encoding; without this a form payload reads as
    // `' OR 1=1` glued with plus signs and slips past the SQL signatures.
    const normalized = contentType.includes('x-www-form-urlencoded') ? text.replace(/\+/g, ' ') : text;
    return normalized.length > MAX_SCAN_BYTES ? normalized.slice(0, MAX_SCAN_BYTES) : normalized;
  } catch {
    return null;
  }
}

function extractLoginEmail(path: string, body: string | null): string | null {
  if (path !== '/api/auth/login' || !body) return null;
  try {
    const parsed = JSON.parse(body) as { email?: unknown };
    return typeof parsed.email === 'string' && parsed.email.length > 3
      ? parsed.email.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function sessionHashOf(c: Context): string | null {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? hashToken(token) : null;
}

function resourceIdIn(path: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path);
  return match ? match[1] : null;
}

async function errorMessageOf(c: Context): Promise<string> {
  try {
    const body = (await c.res.clone().json()) as { error?: { message?: string; code?: string } };
    return `${body.error?.code ?? ''} ${body.error?.message ?? ''}`.toLowerCase();
  } catch {
    return '';
  }
}

function baseFields(c: Context, ip: string) {
  const ctx = getContext(c);
  const user = ctx?.user ?? null;
  return {
    actorId: user?.id ?? null,
    actorRoles: user?.roles ?? null,
    ipAddress: ip,
    userAgent: c.req.header('user-agent') ?? null,
    method: c.req.method.toUpperCase(),
    route: c.req.path,
    sessionHash: sessionHashOf(c),
    traceId: ctx?.traceId ?? null,
  };
}

async function noteMediaRefusal(c: Context, db: DB, ip: string, status: number): Promise<void> {
  const tamper = ruleById('MEDIA_LINK_TAMPER');
  if (!tamper) return;
  const base = baseFields(c, ip);
  const { hits } = hitCounter(`media-refused:${ip}`, tamper.windowSeconds);
  if (hits < tamper.threshold) return;
  await recordSecurityEvent(db, {
    ...base,
    ruleId: tamper.id,
    source: 'MEDIA',
    statusCode: status,
    metadata: { denials: hits, windowSeconds: tamper.windowSeconds },
    fingerprintParts: [tamper.id, ip],
  });
}

async function noteTenantProbe(c: Context, db: DB, ip: string, status: number): Promise<void> {
  const id = resourceIdIn(c.req.path);
  const probe = ruleById('CROSS_TENANT_PROBE');
  if (!probe || !id) return;
  const base = baseFields(c, ip);
  const { size } = distinctCounter(`tenant:${base.actorId ?? ip}`, id, probe.windowSeconds);
  if (size < probe.threshold) return;
  await recordSecurityEvent(db, {
    ...base,
    ruleId: probe.id,
    source: 'HTTP',
    statusCode: status,
    // The ids are not stored; only how many distinct records were tried.
    metadata: { distinctResources: size, windowSeconds: probe.windowSeconds },
    fingerprintParts: [probe.id, base.actorId ?? ip],
  });
}

async function observeOutcome(
  c: Context,
  db: DB,
  ip: string,
  status: number,
  message: string,
  loginEmail: string | null,
): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const base = baseFields(c, ip);

  if (status === 429) {
    const rule = ruleById('RATE_LIMIT_ABUSE');
    if (!rule) return;
    const { hits } = hitCounter(`rl429:${ip}`, rule.windowSeconds);
    if (hits === rule.threshold) {
      const result = await recordSecurityEvent(db, {
        ...base,
        ruleId: rule.id,
        source: 'HTTP',
        statusCode: status,
        metadata: { rejections: hits, windowSeconds: rule.windowSeconds },
        fingerprintParts: [rule.id, ip],
      });
      if (result?.opened) await autoContain(db, rule.id, ip, result.incidentId);
    }
    return;
  }

  if (status === 401 && path.startsWith('/api/auth')) {
    const brute = ruleById('AUTH_BRUTEFORCE');
    if (!brute) return;
    const { hits } = hitCounter(`auth-fail:${ip}`, brute.windowSeconds);
    if (hits === brute.threshold) {
      const result = await recordSecurityEvent(db, {
        ...base,
        ruleId: brute.id,
        source: 'AUTH',
        statusCode: status,
        metadata: { failures: hits, windowSeconds: brute.windowSeconds },
        fingerprintParts: [brute.id, ip],
      });
      if (result?.opened) await autoContain(db, brute.id, ip, result.incidentId);
    }
    const email = loginEmail;
    if (email) {
      const stuffing = ruleById('CREDENTIAL_STUFFING');
      if (!stuffing) return;
      const { size } = distinctCounter(`stuffing:${ip}`, email, stuffing.windowSeconds);
      if (size === stuffing.threshold) {
        await recordSecurityEvent(db, {
          ...base,
          ruleId: stuffing.id,
          source: 'AUTH',
          statusCode: status,
          // Only a count is stored; the addresses tried are never written.
          metadata: { distinctAccounts: size, windowSeconds: stuffing.windowSeconds },
          fingerprintParts: [stuffing.id, ip],
        });
      }
    }
    return;
  }

  if (status === 403) {
    if (message.includes('origin could not be verified') || message.includes('csrf')) {
      await recordSecurityEvent(db, {
        ...base,
        ruleId: 'CSRF_VIOLATION',
        source: 'HTTP',
        statusCode: status,
        metadata: { method, origin: c.req.header('origin') ?? null },
        fingerprintParts: ['CSRF_VIOLATION', base.actorId ?? ip, method],
      });
      return;
    }

    if (AUDIT_PATH.test(path) && STATE_CHANGING.has(method)) {
      await recordSecurityEvent(db, {
        ...base,
        ruleId: 'AUDIT_TAMPER_ATTEMPT',
        source: 'ADMIN',
        statusCode: status,
        metadata: { attemptedMethod: method },
        fingerprintParts: ['AUDIT_TAMPER_ATTEMPT', base.actorId ?? ip, path],
      });
      return;
    }

    if (RBAC_WRITE_PATH.test(path) && STATE_CHANGING.has(method)) {
      await recordSecurityEvent(db, {
        ...base,
        ruleId: 'RBAC_TAMPER_ATTEMPT',
        source: 'ADMIN',
        statusCode: status,
        metadata: { attemptedMethod: method },
        fingerprintParts: ['RBAC_TAMPER_ATTEMPT', base.actorId ?? ip, path],
      });
      return;
    }

    if (ADMIN_PATH.test(path)) {
      const probe = ruleById('PRIVILEGE_PROBE');
      if (!probe) return;
      const { hits } = hitCounter(`probe:${base.actorId ?? ip}`, probe.windowSeconds);
      if (hits === probe.threshold) {
        await recordSecurityEvent(db, {
          ...base,
          ruleId: probe.id,
          source: 'ADMIN',
          statusCode: status,
          metadata: { denials: hits, windowSeconds: probe.windowSeconds },
          fingerprintParts: [probe.id, base.actorId ?? ip],
        });
      }
      return;
    }

    if (MEDIA_PATH.test(path)) {
      await noteMediaRefusal(c, db, ip, status);
      return;
    }

    if (TENANT_PATH.test(path)) {
      await noteTenantProbe(c, db, ip, status);
    }
    return;
  }

  // A forged or expired media link is refused as 401 when the token does not
  // verify, 403 when the token is valid for someone else, and 404 when the asset
  // is gone; an attacker learns nothing from the difference, and all three are
  // the same signal here.
  if ((status === 401 || status === 404) && MEDIA_PATH.test(path)) {
    await noteMediaRefusal(c, db, ip, status);
    return;
  }

  // A record that is not yours is refused as 403 or hidden as 404, depending on
  // the route; both mean the same thing, so both feed the same counter.
  if (status === 404 && TENANT_PATH.test(path)) {
    await noteTenantProbe(c, db, ip, status);
    return;
  }

  if ((status === 415 || status === 422) && MEDIA_PATH.test(path)) {
    const upload = ruleById('UPLOAD_REJECTED');
    if (!upload) return;
    const { hits } = hitCounter(`upload:${base.actorId ?? ip}`, upload.windowSeconds);
    if (hits === upload.threshold) {
      await recordSecurityEvent(db, {
        ...base,
        ruleId: upload.id,
        source: 'MEDIA',
        statusCode: status,
        metadata: { rejections: hits, windowSeconds: upload.windowSeconds },
        fingerprintParts: [upload.id, base.actorId ?? ip],
      });
    }
    return;
  }

  if (status === 404 && AUDIT_PATH.test(path)) {
    await recordSecurityEvent(db, {
      ...base,
      ruleId: 'AUDIT_TAMPER_ATTEMPT',
      source: 'ADMIN',
      statusCode: status,
      metadata: { attemptedMethod: method, note: 'no such audit mutation route' },
      fingerprintParts: ['AUDIT_TAMPER_ATTEMPT', base.actorId ?? ip, path],
    });
    return;
  }

  // Runs after the route so it reads the identity the route guards resolved. It
  // must not resolve the session itself: loading the user before the rate limiter
  // would move that limiter's subject from the address to the account and change
  // which requests it counts.
  if (base.actorId && getCookie(c, SESSION_COOKIE)) await sessionAnomaly(c, db, ip);
}

async function autoContain(db: DB, ruleId: string, ip: string, incidentId: string): Promise<void> {
  try {
    const policy = await policyFor(db);
    await maybeAutoContain(db, policy, {
      ruleId,
      ipAddress: ip === UNKNOWN_CLIENT_KEY ? null : ip,
      incidentId,
      reason: `Automatic containment: ${ruleId} threshold reached`,
    });
  } catch (error) {
    logger.error('wcdc: automatic containment failed', {
      ruleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sessionAnomaly(c: Context, db: DB, ip: string): Promise<void> {
  const hash = sessionHashOf(c);
  if (!hash) return;
  const user = getContext(c)?.user ?? null;
  if (!user || !user.roles.some((role) => STAFF_ROLES.has(role))) return;

  const key = `session-ip:${hash}`;
  // The address recorded at sign-in is the baseline; without it the first
  // authenticated request from anywhere would look "new" and the second address
  // would never be compared to anything.
  const [row] = await db
    .select({ ip: sessions.ipAddress })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hash), isNull(sessions.revokedAt)))
    .limit(1);
  if (row?.ip) distinctCounter(key, row.ip, 900);
  const { size } = distinctCounter(key, ip, 900);
  if (size < 2) return;
  const rule = ruleById('SESSION_ANOMALY');
  if (!rule) return;
  await recordSecurityEvent(db, {
    ...baseFields(c, ip),
    ruleId: rule.id,
    source: 'AUTH',
    // The address that triggered the observation is recorded; the other one is
    // already on the earlier events for this session hash.
    metadata: { distinctAddresses: size, windowSeconds: 900 },
    fingerprintParts: [rule.id, hash],
  });
}

export function wcdcGuard(): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (env.WCDC_ENABLED !== 'on') return next();
    if (!c.req.path.startsWith('/api/')) return next();

    const db = getDb(c);
    const ip = resolveClientIp(c) ?? UNKNOWN_CLIENT_KEY;

    if (ip !== UNKNOWN_CLIENT_KEY) {
      const blocked = await blockedIps(db);
      if (blocked.has(ip)) {
        metrics.incCounter('wasit_wcdc_blocked_requests_total', { kind: 'ip' });
        // One record per address per minute, so a flood cannot grow the table.
        if (hitCounter(`blocked:${ip}`, 60).hits === 1) {
          await recordSecurityEvent(db, {
            ...baseFields(c, ip),
            ruleId: 'RATE_BURST',
            source: 'HTTP',
            statusCode: 403,
            metadata: { refusedBy: 'active-ip-block' },
            fingerprintParts: ['blocked-ip', ip],
          });
        }
        return c.json(
          { success: false, error: { code: 'SECURITY_BLOCKED', message: 'Request blocked by security policy' } },
          403,
        );
      }

      if (isTightened(ip)) {
        const { hits } = hitCounter(`tight:${ip}`, TIGHTENED_LIMIT.windowSeconds);
        if (hits > TIGHTENED_LIMIT.max) {
          metrics.incCounter('wasit_wcdc_blocked_requests_total', { kind: 'tightened' });
          c.header('Retry-After', String(TIGHTENED_LIMIT.windowSeconds));
          return c.json(
            {
              success: false,
              error: { code: 'SECURITY_THROTTLED', message: 'Request limit is temporarily tightened' },
            },
            429,
          );
        }
      }

      const policy = await policyFor(db);
      const burst = hitCounter(`burst:${ip}`, policy.burstWindowSeconds);
      if (burst.hits === policy.burstMax) {
        const result = await recordSecurityEvent(db, {
          ...baseFields(c, ip),
          ruleId: 'RATE_BURST',
          source: 'HTTP',
          metadata: { requests: burst.hits, windowSeconds: policy.burstWindowSeconds },
          fingerprintParts: ['RATE_BURST', ip],
        });
        if (result?.opened) await autoContain(db, 'RATE_BURST', ip, result.incidentId);
      }
    }

    const body = await bodyForScan(c);
    // The body can only be cloned before the route reads it, so the login email
    // is captured here and handed to the outcome observer.
    const loginEmail = extractLoginEmail(c.req.path, body);
    const hits = scanRequest({
      path: c.req.path,
      query: new URL(c.req.url).search.slice(0, 2_048),
      body,
    });
    for (const hit of hits) {
      await recordSecurityEvent(db, {
        ...baseFields(c, ip),
        ruleId: hit.rule,
        source: 'HTTP',
        // The payload itself is never stored: only the pattern that matched and
        // the field it came from.
        metadata: { pattern: hit.pattern, field: hit.field },
        fingerprintParts: [hit.rule, hit.pattern, getContext(c)?.user?.id ?? ip],
      });
    }

    // A route guard throws (401/403/422/429) rather than returning, and the
    // app-level error handler builds the response afterwards — so `c.res` is not
    // set on that path. The status and message come from the error itself,
    // otherwise every refusal would be invisible to the collector.
    try {
      await next();
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      await observeOutcome(c, db, ip, status, message, loginEmail);
      throw error;
    }

    await observeOutcome(c, db, ip, c.res.status, c.res.status === 403 ? await errorMessageOf(c) : '', loginEmail);
  };
}
