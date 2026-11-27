import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import argon2 from 'argon2';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { roles, userRoles, users } from '../src/db/schema/auth.js';
import { mediaAssets } from '../src/db/schema/media.js';
import { aiExecutionSwitches } from '../src/db/schema/ai-execution-switch.js';
import {
  securityActions,
  securityBlocks,
  securityEvents,
  securityIncidents,
} from '../src/db/schema/security.js';
import { resetWcdcCounters } from '../src/lib/wcdc/collector.js';
import { resetWcdcEnforcement } from '../src/lib/wcdc/enforcement.js';
import { resetWcdcMiddlewareCache } from '../src/lib/wcdc/middleware.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';
import { setAiExecutionEnabled } from '../src/lib/ai/kill-switch.js';
import { sweepWcdcData } from '../src/modules/security/service.js';
import { env } from '../src/lib/env.js';
import type { UserRole } from '@wasit/shared';

/**
 * WCDC-01 — the security centre end to end, against a real database.
 *
 * Every signal is produced by a real HTTP request through `createApp()`: no
 * route interception, no mocked detector. Fixtures are the minimum needed to
 * have something to protect (a user, a session, a media row).
 */

const app = createApp();
const createdUserIds: string[] = [];
const PASSWORD = 'WcdcPass!2026-xyz';

/**
 * A real HTTP listener, because WCDC works from the client address and
 * `app.request()` has no socket. The test declares the loopback peer as a
 * trusted proxy — the same production arrangement as nginx in front of the app —
 * so `x-forwarded-for` is honoured and each test can act as a distinct client.
 */
let baseUrl = '';
let server: ReturnType<typeof serve> | null = null;
const savedHops = env.TRUSTED_PROXY_HOPS;
const savedCidrs = env.TRUSTED_PROXY_CIDRS;

function makeClient(ip: string, cookie?: string) {
  let current = cookie ?? '';
  return {
    ip,
    get cookie() {
      return current;
    },
    set cookie(value: string) {
      current = value;
    },
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip, ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (current) headers.Cookie = current;
      const res = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) current = setCookie.split(';')[0];
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function createUser(role: UserRole, tag: string, ip: string) {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `wcdc-${tag}-${randomUUID()}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash(PASSWORD),
    firstName: tag,
    isActive: true,
    emailVerified: true,
  });
  const [roleRow] = await db.select().from(roles).where(eq(roles.name, role)).limit(1);
  if (roleRow) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: roleRow.id });
  const client = makeClient(ip);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD, allowUnverifiedEmail: true },
  });
  expect(login.status, `login ${role}`).toBe(200);
  return { id, email, client };
}

async function incidentsFor(ruleId: string) {
  return db.select().from(securityIncidents).where(eq(securityIncidents.ruleId, ruleId));
}

async function waitForIncident(ruleId: string, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    const rows = await incidentsFor(ruleId);
    if (rows.length > 0 || Date.now() - started > timeoutMs) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let superAdmin: Awaited<ReturnType<typeof createUser>>;
let secondGm: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let customer: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  env.TRUSTED_PROXY_HOPS = 1;
  env.TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128';
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    const started = server as unknown as { on: (event: string, cb: () => void) => void };
    if ((server as unknown as { listening?: boolean }).listening) return resolve();
    started.on('listening', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  superAdmin = await createUser('SUPER_ADMIN', 'gm', '198.51.100.1');
  secondGm = await createUser('SUPER_ADMIN', 'gm2', '198.51.100.2');
  admin = await createUser('ADMIN', 'admin', '198.51.100.3');
  customer = await createUser('CUSTOMER', 'cust', '198.51.100.4');
});

beforeEach(async () => {
  resetWcdcCounters();
  resetWcdcEnforcement();
  resetWcdcMiddlewareCache();
  await resetRateLimitStore();
});

afterAll(async () => {
  env.TRUSTED_PROXY_HOPS = savedHops;
  env.TRUSTED_PROXY_CIDRS = savedCidrs;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await db.update(aiExecutionSwitches).set({ stopped: false }).where(eq(aiExecutionSwitches.scope, 'GLOBAL'));
  await setAiExecutionEnabled(db, true);
  if (createdUserIds.length > 0) {
    await db.delete(userRoles).where(inArray(userRoles.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('WCDC access control', () => {
  it('refuses an anonymous caller and a customer', async () => {
    const anon = makeClient('198.51.100.50');
    expect((await anon.req('/api/admin/security/overview')).status).toBe(401);
    expect((await customer.client.req('/api/admin/security/overview')).status).toBe(403);
    expect((await customer.client.req('/api/admin/security/incidents')).status).toBe(403);
  });

  it('lets an ADMIN read the centre but not contain anything', async () => {
    const overview = await admin.client.req('/api/admin/security/overview');
    expect(overview.status).toBe(200);
    expect(overview.data.success).toBe(true);
    expect(overview.data.data.counts).toBeDefined();

    const [incident] = await db.select().from(securityIncidents).limit(1);
    const respond = await admin.client.req(`/api/admin/security/incidents/${incident?.id ?? randomUUID()}/respond`, {
      method: 'POST',
      body: { action: 'BLOCK_IP', target: '203.0.113.77', reason: 'admin should not be able to contain' },
    });
    expect(respond.status).toBe(403);
  });

  it('gives the GM the catalogue, the overview and the edge status', async () => {
    const rules = await superAdmin.client.req('/api/admin/security/rules');
    expect(rules.status).toBe(200);
    expect(rules.data.data.rules.length).toBeGreaterThan(10);
    expect(rules.data.data.forbiddenActions).toContain('GRANT_PERMISSION');

    const overview = await superAdmin.client.req('/api/admin/security/overview');
    expect(overview.status).toBe(200);
    expect(['CALM', 'ELEVATED', 'HIGH', 'CRITICAL']).toContain(overview.data.data.posture.level);

    const external = await superAdmin.client.req('/api/admin/security/external');
    expect(external.status).toBe(200);
    // The platform does not pretend its own code absorbs a volumetric flood.
    expect(external.data.data.coversVolumetricDdos).toBe(false);
  });
});

describe('WCDC detection from real requests', () => {
  it('records a SQL injection payload without storing the payload', async () => {
    const client = makeClient('198.51.100.11');
    await client.req("/api/search?q=1%20UNION%20SELECT%20password%20FROM%20users");
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'SQL_INJECTION'))
      .orderBy(desc(securityEvents.occurredAt))
      .limit(1);
    expect(event).toBeDefined();
    expect(event.severity).toBe('CRITICAL');
    expect(event.incidentId).toBeTruthy();
    expect(JSON.stringify(event.metadata)).not.toContain('password FROM users');
    expect(event.metadata).toMatchObject({ pattern: 'union-select', field: 'query' });
    expect(await incidentsFor('SQL_INJECTION')).not.toHaveLength(0);
  });

  it('records an XSS payload in a request body', async () => {
    const client = makeClient('198.51.100.12');
    await client.req('/api/search', {
      method: 'POST',
      body: { q: '<script>alert(document.cookie)</script>' },
    });
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'XSS'))
      .limit(1);
    expect(event).toBeDefined();
    expect(JSON.stringify(event.metadata)).not.toContain('<script>');
  });

  it('records a path traversal attempt', async () => {
    const client = makeClient('198.51.100.13');
    await client.req('/api/search?q=..%2F..%2F..%2Fetc%2Fpasswd');
    expect(await waitForIncident('PATH_TRAVERSAL')).not.toHaveLength(0);
  });

  it('detects a brute-force pattern and a credential-stuffing pattern', async () => {
    const brute = makeClient('198.51.100.14');
    for (let i = 0; i < 5; i += 1) {
      const res = await brute.req('/api/auth/login', {
        method: 'POST',
        body: { email: 'nobody@wasit.tn', password: `wrong-${i}` },
      });
      expect([401, 429]).toContain(res.status);
    }
    expect(await waitForIncident('AUTH_BRUTEFORCE')).not.toHaveLength(0);

    const stuffing = makeClient('198.51.100.15');
    for (let i = 0; i < 6; i += 1) {
      await stuffing.req('/api/auth/login', {
        method: 'POST',
        body: { email: `target-${i}@wasit.tn`, password: 'guessing-again' },
      });
    }
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'CREDENTIAL_STUFFING'))
      .limit(1);
    expect(event).toBeDefined();
    // The addresses tried are never written down.
    expect(JSON.stringify(event.metadata)).not.toContain('target-0@wasit.tn');
  });

  it('detects privilege probing and an RBAC tamper attempt', async () => {
    const probe = makeClient('198.51.100.16');
    const probeClient = await createUser('CUSTOMER', 'probe', '198.51.100.16');
    for (let i = 0; i < 3; i += 1) {
      const res = await probeClient.client.req('/api/admin/stats');
      expect(res.status).toBe(403);
    }
    expect(await waitForIncident('PRIVILEGE_PROBE')).not.toHaveLength(0);
    expect(probe.ip).toBe('198.51.100.16');

    const tamper = await probeClient.client.req('/api/admin/staff', {
      method: 'POST',
      body: { email: 'x@wasit.tn', role: 'SUPER_ADMIN' },
    });
    expect(tamper.status).toBe(403);
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'RBAC_TAMPER_ATTEMPT'))
      .limit(1);
    expect(event).toBeDefined();
  });

  it('detects repeated access to records that are not the caller’s', async () => {
    const client = await createUser('CUSTOMER', 'tenant', '198.51.100.17');
    const first = randomUUID();
    const second = randomUUID();
    const a = await client.client.req(`/api/orders/${first}`);
    const b = await client.client.req(`/api/orders/${second}`);
    expect([403, 404]).toContain(a.status);
    expect([403, 404]).toContain(b.status);
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'CROSS_TENANT_PROBE'))
      .limit(1);
    expect(event).toBeDefined();
    // Only a count is stored; the record ids are not.
    expect(JSON.stringify(event.metadata)).not.toContain(first);
  });

  it('detects a staff session used from a second address', async () => {
    const gm = await createUser('SUPER_ADMIN', 'sessiongm', '198.51.100.18');
    const second = makeClient('198.51.100.19', gm.client.cookie);
    const res = await second.req('/api/admin/security/overview');
    expect(res.status).toBe(200);
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'SESSION_ANOMALY'))
      .limit(1);
    expect(event).toBeDefined();
    expect(event.sessionHash).toBeTruthy();
    // The session token itself never reaches the table.
    expect(JSON.stringify(event)).not.toContain('wasit_session');
  });

  it('detects rejected uploads and forged media links', async () => {
    const merchant = await createUser('MERCHANT', 'upload', '198.51.100.20');
    for (let i = 0; i < 3; i += 1) {
      const res = await merchant.client.req('/api/media/product-images', {
        method: 'POST',
        body: { productId: randomUUID(), file: 'not-a-file' },
      });
      expect(res.status).toBe(422);
    }
    expect(await waitForIncident('UPLOAD_REJECTED')).not.toHaveLength(0);

    const anon = makeClient('198.51.100.21');
    for (let i = 0; i < 3; i += 1) {
      await anon.req(`/api/media/assets/${randomUUID()}/content?token=forged`);
    }
    expect(await waitForIncident('MEDIA_LINK_TAMPER')).not.toHaveLength(0);
  });

  it('detects an attempt to modify the audit trail', async () => {
    const res = await superAdmin.client.req('/api/admin/audit-logs', { method: 'DELETE' });
    expect([403, 404, 405]).toContain(res.status);
    const [event] = await db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.ruleId, 'AUDIT_TAMPER_ATTEMPT'))
      .limit(1);
    expect(event).toBeDefined();
    expect(event.severity).toBe('CRITICAL');
  });

  it('turns an existing agent refusal into an incident, once', async () => {
    const auditId = randomUUID();
    await db.insert(auditLogs).values({
      id: auditId,
      actorId: null,
      actorType: 'SYSTEM',
      action: 'AI.TOOL_REFUSED',
      entityType: 'agent_tool',
      entityId: randomUUID(),
      metadata: { code: 'SCOPE_DENIED' },
    });

    const first = await superAdmin.client.req('/api/admin/security/scan', {
      method: 'POST',
      body: { windowMinutes: 60 },
    });
    expect(first.status).toBe(200);
    expect(first.data.data.recorded).toBeGreaterThanOrEqual(1);
    expect(await incidentsFor('AGENT_SCOPE_VIOLATION')).not.toHaveLength(0);

    const second = await superAdmin.client.req('/api/admin/security/scan', {
      method: 'POST',
      body: { windowMinutes: 60 },
    });
    expect(second.status).toBe(200);
    // Same audit row, second pass: nothing new. No false success.
    expect(second.data.data.recorded).toBe(0);
  });

  it('detects a request flood from one address', async () => {
    // Read the effective threshold instead of hard-coding it: the burst rule is
    // tunable from the policy engine and from the environment.
    const rules = await superAdmin.client.req('/api/admin/security/rules');
    const burst = (rules.data.data.rules as Array<{ id: string; effectiveThreshold: number }>).find(
      (rule) => rule.id === 'RATE_BURST',
    );
    const threshold = burst?.effectiveThreshold ?? 120;

    const flood = makeClient('198.51.100.22');
    for (let i = 0; i < threshold + 1; i += 1) {
      await flood.req('/api/health/live');
    }
    expect(await waitForIncident('RATE_BURST')).not.toHaveLength(0);
  });
});

describe('WCDC response and containment', () => {
  async function latestIncident() {
    const [incident] = await db
      .select()
      .from(securityIncidents)
      .orderBy(desc(securityIncidents.lastSeenAt))
      .limit(1);
    return incident;
  }

  it('blocks an address and then refuses its requests', async () => {
    const incident = await latestIncident();
    const res = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'BLOCK_IP', target: '203.0.113.9', reason: 'test block' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('EXECUTED');

    const blocked = makeClient('203.0.113.9');
    const refused = await blocked.req('/api/health/live');
    expect(refused.status).toBe(403);
    expect(refused.data.error.code).toBe('SECURITY_BLOCKED');

    const [block] = await db
      .select()
      .from(securityBlocks)
      .where(eq(securityBlocks.target, '203.0.113.9'))
      .limit(1);
    expect(block).toBeDefined();
    expect(new Date(block.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('tightens the limit for one address', async () => {
    const incident = await latestIncident();
    const res = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'RATE_LIMIT_TIGHTEN', target: '203.0.113.10', reason: 'test tighten' },
    });
    expect(res.status).toBe(200);

    const client = makeClient('203.0.113.10');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await client.req('/api/health/live')).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('requires a second GM to revoke a session, and refuses self-approval', async () => {
    const victim = await createUser('CUSTOMER', 'victim', '198.51.100.30');
    const incident = await latestIncident();
    const request = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'REVOKE_SESSION', target: victim.id, reason: 'suspected takeover' },
    });
    expect(request.status).toBe(200);
    expect(request.data.data.status).toBe('REQUIRES_APPROVAL');

    const selfApprove = await superAdmin.client.req(`/api/admin/security/actions/${request.data.data.id}/approve`, {
      method: 'POST',
    });
    expect(selfApprove.status).toBe(403);

    const approved = await secondGm.client.req(`/api/admin/security/actions/${request.data.data.id}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(200);
    expect(approved.data.data.status).toBe('EXECUTED');

    const after = await victim.client.req('/api/auth/me');
    expect(after.status).toBe(401);
  });

  it('quarantines a media asset only after approval, and the download then refuses', async () => {
    const assetId = randomUUID();
    await db.insert(mediaAssets).values({
      id: assetId,
      ownerUserId: customer.id,
      kind: 'IMAGE',
      status: 'READY',
      title: 'wcdc quarantine fixture',
      storageKey: `fixtures/${assetId}.png`,
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: 10,
    });
    const incident = await latestIncident();
    const request = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'QUARANTINE_ASSET', target: assetId, reason: 'suspicious binary' },
    });
    expect(request.data.data.status).toBe('REQUIRES_APPROVAL');

    const approved = await secondGm.client.req(`/api/admin/security/actions/${request.data.data.id}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(200);

    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1);
    expect(asset.status).toBe('QUARANTINED');

    const download = await makeClient('198.51.100.31').req(`/api/media/assets/${assetId}/content?token=whatever`);
    expect([401, 403, 404]).toContain(download.status);
  });

  it('refuses an operation that would change its own authority', async () => {
    const before = await db
      .select({ userId: userRoles.userId, roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, superAdmin.id));
    const incident = await latestIncident();
    const res = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'GRANT_PERMISSION', target: customer.id, reason: 'self escalation attempt' },
    });
    expect(res.status).toBe(403);

    const [refused] = await db
      .select()
      .from(securityActions)
      .where(eq(securityActions.status, 'REFUSED'))
      .limit(1);
    expect(refused).toBeDefined();
    expect(refused.actionType).toBe('FORBIDDEN_OPERATION');
    expect((refused.result as { requestedAction?: string }).requestedAction).toBe('GRANT_PERMISSION');

    const after = await db
      .select({ userId: userRoles.userId, roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, superAdmin.id));
    expect(after).toEqual(before);
  });

  it('pauses the AI fleet only through the existing kill switch and only after approval', async () => {
    const incident = await latestIncident();
    const request = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'AI_KILL_SWITCH', reason: 'agent anomaly drill' },
    });
    expect(request.data.data.status).toBe('REQUIRES_APPROVAL');

    const approved = await secondGm.client.req(`/api/admin/security/actions/${request.data.data.id}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(200);

    const [row] = await db
      .select()
      .from(aiExecutionSwitches)
      .where(eq(aiExecutionSwitches.scope, 'GLOBAL'))
      .limit(1);
    expect(row.stopped).toBe(true);
    await setAiExecutionEnabled(db, true);
  });
});

describe('WCDC trail integrity', () => {
  it('links every event to an incident and audits every action', async () => {
    const orphans = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(sql`${securityEvents.incidentId} is null`);
    expect(Number(orphans[0].n)).toBe(0);

    const audited = await db
      .select({ action: auditLogs.action, n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(sql`${auditLogs.action} like 'SECURITY.%'`)
      .groupBy(auditLogs.action);
    const actions = audited.map((row) => row.action);
    expect(actions).toContain('SECURITY.ACTION_EXECUTED');
    expect(actions).toContain('SECURITY.ACTION_APPROVED');
    expect(actions).toContain('SECURITY.ACTION_REFUSED');
    expect(actions).toContain('SECURITY.SCAN_RUN');
  });

  it('never writes a password, a session token or a raw payload into a security row', async () => {
    const rows = await db.select().from(securityEvents).limit(500);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('wasit_session');
    expect(serialized).not.toContain('<script>');
    expect(serialized).not.toContain('UNION SELECT');
  });

  it('keeps the security centre closed to a non-staff account even with an id in hand', async () => {
    const [incident] = await db.select().from(securityIncidents).limit(1);
    const res = await customer.client.req(`/api/admin/security/incidents/${incident.id}`);
    expect(res.status).toBe(403);
  });

  it('reports a policy source honestly', async () => {
    const overview = await superAdmin.client.req('/api/admin/security/overview');
    expect(['default', 'policy']).toContain(overview.data.data.policy.source);
    if (overview.data.data.policy.source === 'default') {
      expect(overview.data.data.policy.policyId).toBeNull();
    }
    expect(['off', 'limited']).toContain(overview.data.data.policy.autoContainment);
  });
});

describe('WCDC auto-containment limits', () => {
  it('does not contain anything when the policy is off', async () => {
    const { maybeAutoContain } = await import('../src/lib/wcdc/response.js');
    const [incident] = await db.select().from(securityIncidents).limit(1);
    const outcome = await maybeAutoContain(
      db,
      {
        autoContainment: 'off',
        blockTtlMinutes: 60,
        tightenTtlMinutes: 30,
        burstMax: 60,
        burstWindowSeconds: 10,
        source: 'default',
        policyId: null,
        policyVersion: null,
      },
      { ruleId: 'RATE_BURST', ipAddress: '203.0.113.55', incidentId: incident.id, reason: 'test' },
    );
    expect(outcome).toBeNull();
    const rows = await db
      .select()
      .from(securityBlocks)
      .where(eq(securityBlocks.target, '203.0.113.55'));
    expect(rows).toHaveLength(0);
  });

  it('never contains an account-level rule even when the policy allows limited action', async () => {
    const { maybeAutoContain } = await import('../src/lib/wcdc/response.js');
    const [incident] = await db.select().from(securityIncidents).limit(1);
    const outcome = await maybeAutoContain(
      db,
      {
        autoContainment: 'limited',
        blockTtlMinutes: 60,
        tightenTtlMinutes: 30,
        burstMax: 60,
        burstWindowSeconds: 10,
        source: 'policy',
        policyId: randomUUID(),
        policyVersion: 1,
      },
      { ruleId: 'AUTH_BRUTEFORCE', ipAddress: '203.0.113.56', incidentId: incident.id, reason: 'test' },
    );
    expect(outcome).toBeNull();
  });
});

/**
 * The review of WCDC-01 found these gaps; each case is the regression guard for
 * the fix that closed it.
 */
describe('WCDC-01 — controls an operator can actually see and undo', () => {
  async function latestIncident() {
    const [row] = await db
      .select()
      .from(securityIncidents)
      .orderBy(desc(securityIncidents.lastSeenAt))
      .limit(1);
    return row;
  }

  it('lists an active block and lifts it, and the address is served again', async () => {
    const incident = await latestIncident();
    const target = '203.0.113.61';
    const block = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'BLOCK_IP', target, reason: 'review: liftable block' },
    });
    expect(block.status).toBe(200);

    const listed = await superAdmin.client.req('/api/admin/security/blocks');
    expect(listed.status).toBe(200);
    const row = (listed.data.data.items as Array<{ id: string; target: string; active: boolean }>).find(
      (item) => item.target === target,
    );
    expect(row).toBeDefined();
    expect(row?.active).toBe(true);

    // Reading is one thing, lifting is a GM decision.
    expect((await admin.client.req(`/api/admin/security/blocks/${row?.id}/revoke`, { method: 'POST' })).status).toBe(403);

    const lifted = await superAdmin.client.req(`/api/admin/security/blocks/${row?.id}/revoke`, { method: 'POST' });
    expect(lifted.status).toBe(200);
    expect(lifted.data.data.status).toBe('EXECUTED');

    const fromBlockedAddress = await makeClient(target).req('/api/health/live');
    expect(fromBlockedAddress.status).toBe(200);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'SECURITY.BLOCK_LIFTED'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit[0]).toBeDefined();
  });

  it('refuses to revoke the sessions of an account that does not exist', async () => {
    const incident = await latestIncident();
    const request = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'REVOKE_SESSION', target: randomUUID(), reason: 'typo in the account id' },
    });
    expect(request.data.data.status).toBe('REQUIRES_APPROVAL');

    const approved = await secondGm.client.req(`/api/admin/security/actions/${request.data.data.id}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(404);

    const [row] = await db
      .select()
      .from(securityActions)
      .where(eq(securityActions.id, request.data.data.id))
      .limit(1);
    expect(row.status).toBe('FAILED');
  });

  it('runs an incident-scoped action without asking for a target', async () => {
    const incident = await latestIncident();
    const res = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'ESCALATE', reason: 'review: escalate from the incident itself' },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.status).toBe('EXECUTED');

    const [row] = await db
      .select()
      .from(securityActions)
      .where(eq(securityActions.id, res.data.data.id))
      .limit(1);
    expect(row.target).toBe(incident.id);
  });

  it('audits a refused self-approval and refuses a second approval', async () => {
    const victim = await createUser('CUSTOMER', 'review-victim', '198.51.100.41');
    const incident = await latestIncident();
    const request = await superAdmin.client.req(`/api/admin/security/incidents/${incident.id}/respond`, {
      method: 'POST',
      body: { action: 'REVOKE_SESSION', target: victim.id, reason: 'review: four-eyes' },
    });
    const actionId = request.data.data.id as string;

    expect((await superAdmin.client.req(`/api/admin/security/actions/${actionId}/approve`, { method: 'POST' })).status).toBe(403);
    const refusedAudit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'SECURITY.APPROVAL_REFUSED'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(refusedAudit[0]).toBeDefined();
    expect(refusedAudit[0].entityId).toBe(actionId);

    expect((await secondGm.client.req(`/api/admin/security/actions/${actionId}/approve`, { method: 'POST' })).status).toBe(200);
    // The row is claimed before the action runs, so a replay cannot run it twice.
    expect((await secondGm.client.req(`/api/admin/security/actions/${actionId}/approve`, { method: 'POST' })).status).toBe(409);
  });

  it('scans a form-encoded body, not only JSON', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': '198.51.100.42',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: "admin' OR 1=1 --", password: 'x' }).toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db
      .select()
      .from(securityEvents)
      .where(and(eq(securityEvents.ruleId, 'SQL_INJECTION'), eq(securityEvents.ipAddress, '198.51.100.42')));
    expect(rows.length).toBeGreaterThan(0);
    expect((rows[0].metadata as { field?: string }).field).toBe('body');
  });

  it('prunes events past the retention window and reports what it removed', async () => {
    const stale = randomUUID();
    await db.insert(securityEvents).values({
      id: stale,
      occurredAt: new Date(Date.now() - 200 * 24 * 3600 * 1000),
      source: 'HTTP',
      category: 'DDOS',
      ruleId: 'RATE_BURST',
      severity: 'LOW',
      fingerprint: 'deadbeefdeadbeef',
    });
    const result = await sweepWcdcData(db);
    expect(result.prunedEvents).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(securityEvents).where(eq(securityEvents.id, stale));
    expect(left).toHaveLength(0);
  });
});
