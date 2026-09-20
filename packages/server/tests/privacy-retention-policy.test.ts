import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { dataDeletionRequests, consentEvents } from '../src/db/schema/privacy.js';
import { profiles } from '../src/db/schema/trade.js';
import { countries } from '../src/db/schema/geo.js';
import { policies, countryPolicyGaps } from '../src/db/schema/engine.js';
import { resolveRetentionForUser, createDeletionRequest } from '../src/modules/privacy/service.js';

import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();
const CODE = 'DATA_RETENTION';
const SCOPE = 'PRIVACY' as const;

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  await resetRateLimitStore();
});

function makeClient(ip = `203.0.113.${Math.floor(Math.random() * 200 + 1)}`) {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { 'x-forwarded-for': ip };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { res, data: data as Record<string, never>, status: res.status };
    },
  };
}

async function createUser(prefix: string, countryId: string | null = null) {
  const id = randomUUID();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const passwordHash = await argon2.hash('Passw0rd!Secure');
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: prefix,
    emailVerified: true,
    isActive: true,
  });
  if (countryId) {
    await db.insert(profiles).values({ userId: id, displayName: prefix, countryId });
  }
  return { id, email, password: 'Passw0rd!Secure' };
}

async function makeAdminClient() {
  const adminId = randomUUID();
  const adminEmail = `ret-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  await db.insert(users).values({
    id: adminId,
    email: adminEmail,
    passwordHash: await argon2.hash('AdminPass123!'),
    firstName: 'Ret Admin',
    emailVerified: true,
    isActive: true,
  });
  const [role] = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role.id });
  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return client;
}

async function hasAudit(action: string, entityId: string): Promise<boolean> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)))
    .limit(1);
  return rows.length > 0;
}

/** A country that exists in the seed data (Tunisia) and a second one (France). */
async function findCountry(code: string) {
  const [row] = await db.select().from(countries).where(eq(countries.code, code)).limit(1);
  if (!row) throw new Error(`country ${code} not seeded`);
  return row;
}

describe('PHASE 17 — Country-aware data retention policy', () => {
  it('seeds a global DATA_RETENTION policy and resolves it when no country applies', async () => {
    const all = await db
      .select()
      .from(policies)
      .where(and(eq(policies.scope, SCOPE), eq(policies.code, CODE)));
    const globalRow = all.find((p) => p.countryId === null);
    expect(globalRow).toBeTruthy();
    expect(Number((globalRow!.rules as { defaultRetentionDays: number }).defaultRetentionDays)).toBe(90);

    const user = await createUser('ret-global');
    const resolved = await resolveRetentionForUser(db, user.id);
    expect(resolved.source).toBe('GLOBAL');
    expect(resolved.rules.defaultRetentionDays).toBe(90);
    expect(resolved.rules.legalHoldFinanciallyRequired).toBe(true);
  });

  it('deletion stores the resolved retention window from the policy (not hardcoded 90)', async () => {
    const user = await createUser('ret-store');
    await createDeletionRequest(db, user.id, user.id, 'test');

    const [row] = await db
      .select()
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);
    expect(row.retentionPolicy).toBeTruthy();
    const policy = row.retentionPolicy as Record<string, unknown>;
    expect(policy.defaultRetentionDays).toBe(90);
    expect(policy.policySource).toBe('GLOBAL');
    // The always-preserved financial/audit records are all present.
    const preserves = policy.preserves as string[];
    expect(preserves).toContain('transaction_ledger');
    expect(preserves).toContain('audit_logs');
    expect(preserves).toContain('disputes');

    // retentionUntil ≈ 90 days out (allow a generous delta for test runtime).
    const days = (row.retentionUntil!.getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('records a DECISION_REQUIRED gap when a country has no override; admin override resolves it', async () => {
    const tn = await findCountry('TN');
    const user = await createUser('ret-tn', tn.id);

    const resolved = await resolveRetentionForUser(db, user.id);
    expect(resolved.source).toBe('GLOBAL');
    expect(resolved.countryCode).toBe('TN');

    const gaps = await db
      .select()
      .from(countryPolicyGaps)
      .where(
        and(
          eq(countryPolicyGaps.countryId, tn.id),
          eq(countryPolicyGaps.scope, SCOPE),
          eq(countryPolicyGaps.code, CODE),
        ),
      );
    expect(gaps.length).toBe(1);
    expect(gaps[0].status).toBe('DECISION_REQUIRED');

    // Admin sets a country override with a different (shorter) window.
    const admin = await makeAdminClient();
    const put = await admin.req('/api/admin/policies/retention', {
      method: 'PUT',
      body: {
        countryId: tn.id,
        name: 'Tunisia Data Retention',
        rules: { defaultRetentionDays: 30, legalHoldFinanciallyRequired: true, preserves: ['support_tickets'] },
        reason: 'Tunisian legal retention window',
      },
    });
    expect(put.status).toBe(200);

    const afterOverride = await resolveRetentionForUser(db, user.id);
    expect(afterOverride.source).toBe('COUNTRY');
    expect(afterOverride.rules.defaultRetentionDays).toBe(30);
    expect(afterOverride.rules.preserves).toContain('support_tickets');

    // The gap is resolved.
    const gapsAfter = await db
      .select()
      .from(countryPolicyGaps)
      .where(
        and(
          eq(countryPolicyGaps.countryId, tn.id),
          eq(countryPolicyGaps.scope, SCOPE),
          eq(countryPolicyGaps.code, CODE),
        ),
      );
    expect(gapsAfter[0].status).toBe('RESOLVED');
  });

  it('country override changes the stored deletion window for that country only', async () => {
    const tn = await findCountry('TN');
    const user = await createUser('ret-tn-window', tn.id);
    await createDeletionRequest(db, user.id, user.id, 'tn-window');

    const [row] = await db
      .select()
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);
    const days = (row.retentionUntil!.getTime() - Date.now()) / 86400_000;
    // TN override is 30 days from the previous test (shared seeded country row).
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect((row.retentionPolicy as Record<string, unknown>).countryCode).toBe('TN');

    // A user with no country still gets the global 90-day window.
    const noCountry = await createUser('ret-none');
    const global = await resolveRetentionForUser(db, noCountry.id);
    expect(global.source).toBe('GLOBAL');
    expect(global.rules.defaultRetentionDays).toBe(90);
  });

  it('rejects an invalid retention policy body with 422 field errors', async () => {
    const admin = await makeAdminClient();
    const res = await admin.req('/api/admin/policies/retention', {
      method: 'PUT',
      body: {
        name: 'Bad',
        rules: { defaultRetentionDays: -5 },
        reason: 'too short',
      },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.data)).toContain('fieldErrors');
  });

  it('requires ADMIN to edit retention policy (403 for a plain user, 401 anonymous)', async () => {
    const user = await createUser('ret-nonadmin');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const forbidden = await client.req('/api/admin/policies/retention', {
      method: 'PUT',
      body: { name: 'X', rules: { defaultRetentionDays: 10 }, reason: 'nope' },
    });
    expect(forbidden.status).toBe(403);

    const anon = await makeClient();
    const unauthorized = await anon.req('/api/admin/policies/retention', {
      method: 'PUT',
      body: { name: 'X', rules: { defaultRetentionDays: 10 }, reason: 'nope' },
    });
    expect(unauthorized.status).toBe(401);
  });

  it('admin lists retention policies and gaps, and resolves merged rules for a country', async () => {
    const tn = await findCountry('TN');
    const admin = await makeAdminClient();
    const list = await admin.req('/api/admin/policies/retention');
    expect(list.status).toBe(200);
    const data = list.data.data as { items: unknown[]; gaps: unknown[]; countries: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.countries)).toBe(true);

    const resolved = await admin.req(`/api/admin/policies/retention/resolved?countryId=${tn.id}`);
    expect(resolved.status).toBe(200);
    const rules = (resolved.data.data as { rules: Record<string, unknown> }).rules;
    expect(Number(rules.defaultRetentionDays)).toBe(30);
  });

  it('editing the global retention policy is audited with old/new values and bumps the version', async () => {
    const [global] = await db
      .select()
      .from(policies)
      .where(and(eq(policies.scope, SCOPE), eq(policies.code, CODE), isNull(policies.countryId)))
      .limit(1);
    const versionBefore = global.version;

    const admin = await makeAdminClient();
    const beforeRules = global.rules as Record<string, unknown>;
    const put = await admin.req('/api/admin/policies/retention', {
      method: 'PUT',
      body: {
        name: 'Data Retention Policy',
        rules: {
          defaultRetentionDays: Number(beforeRules.defaultRetentionDays),
          legalHoldFinanciallyRequired: true,
          preserves: ['audit_logs'],
        },
        reason: 'test audit trail',
      },
    });
    expect(put.status).toBe(200);

    const [after] = await db
      .select()
      .from(policies)
      .where(eq(policies.id, global.id))
      .limit(1);
    expect(after.version).toBe(versionBefore + 1);
    expect(await hasAudit('POLICY.RETENTION.UPDATED', global.id)).toBe(true);
  });

  it('a revoked ANALYTICS consent is recorded after a grant (append-only history)', async () => {
    const user = await createUser('ret-consent');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    await client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'ANALYTICS', granted: true },
    });
    await client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'ANALYTICS', granted: false },
    });
    const events = await db
      .select()
      .from(consentEvents)
      .where(and(eq(consentEvents.userId, user.id), eq(consentEvents.consentType, 'ANALYTICS')));
    expect(events.length).toBe(2);
    expect(events.some((e) => e.action === 'GRANT')).toBe(true);
    expect(events.some((e) => e.action === 'REVOKE')).toBe(true);
  });
});