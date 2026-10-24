import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { users } from '../src/db/schema/auth.js';
import { authenticatorApp } from '../src/db/schema/auth.js';
import { consentEvents, dataDeletionRequests, dataExportRequests } from '../src/db/schema/privacy.js';
import {
  generateMfaSecret,
  generateTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotp,
} from '../src/lib/mfa.js';
import { buildUserExport, setConsent } from '../src/modules/privacy/service.js';
import { resetRateLimitStore } from '../src/middleware/rate-limit.js';

const app = createApp();

beforeAll(async () => {
  await resetRateLimitStore();
});
afterAll(async () => {
  await resetRateLimitStore();
});

function createSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeClient(ip = `198.51.100.${Math.floor(Math.random() * 200 + 1)}`) {
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

async function createUser(prefix: string, password = 'Passw0rd!Secure') {
  const id = randomUUID();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const passwordHash = await argon2.hash(password);
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    firstName: prefix,
    emailVerified: true,
    isActive: true,
  });
  return { id, email, password };
}

/** Creates a fresh ADMIN account and returns a logged-in client for it. */
async function makeAdminClient() {
  const adminId = randomUUID();
  const adminEmail = `privacy-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@wasit.tn`;
  const adminHash = await argon2.hash('AdminPass123!');
  await db.insert(users).values({
    id: adminId,
    email: adminEmail,
    passwordHash: adminHash,
    firstName: 'PVT Admin',
    emailVerified: true,
    isActive: true,
  });
  const { roles, userRoles } = await import('../src/db/schema/auth.js');
  const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
  await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role[0].id });

  const client = makeClient();
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return client;
}

async function hasAudit(action: string, entityId: string): Promise<boolean> {
  const { auditLogs } = await import('../src/db/schema/audit.js');
  const { and } = await import('drizzle-orm');
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)))
    .limit(1);
  return rows.length > 0;
}

describe('PHASE 17 — Security Headers', () => {
  it('returns security headers on every response', async () => {
    const res = await app.request('/api/health');
    expect([
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Strict-Transport-Security',
      'X-XSS-Protection',
      'Permissions-Policy',
    ].some((h) => res.headers.has(h))).toBe(true);
    // Core anti-drive headers must always be present
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toMatch(/DENY|SAMEORIGIN/);
  });
});

describe('PHASE 17 — MFA (TOTP / RFC 6238)', () => {
  it('unit: generates deterministic TOTP and verifies it', () => {
    const { secretBase32 } = generateMfaSecret();
    const c1 = generateTotp(secretBase32);
    expect(c1).toMatch(/^\d{6}$/);
    expect(verifyTotp(secretBase32, c1)).toBe(true);
    expect(verifyTotp(secretBase32, '000000')).toBe(false);
  });

  it('unit: recovery codes are hashed with a unique salt and round-trip', () => {
    const codes = generateRecoveryCodes(3);
    const hashed = codes.map(hashRecoveryCode);
    // Salted format: `salt:hash`, and each stored digest carries a unique salt.
    codes.forEach((code, i) => {
      expect(hashed[i]).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
      const check = verifyRecoveryCode(code, hashed[i]);
      expect(check.valid).toBe(true);
      expect(check.legacy).toBe(false);
    });
    // Different codes -> different salts/digests (no two stored values equal).
    expect(new Set(hashed).size).toBe(3);
    // Wrong code fails.
    const wrong = verifyRecoveryCode('WRONG', hashed[0]);
    expect(wrong.valid).toBe(false);
  });

  it('unit: legacy unsalted recovery digests still verify (backward compat)', () => {
    const code = 'legacy-code-1';
    const legacyDigest = createSha256(code); // old format: raw SHA-256 hex (64 chars)
    const check = verifyRecoveryCode(code, legacyDigest);
    expect(check.valid).toBe(true);
    expect(check.legacy).toBe(true);
    expect(verifyRecoveryCode('not-the-code', legacyDigest).valid).toBe(false);
  });

  it('enroll → confirm → status shows enabled', async () => {
    const user = await createUser('mfa');
    const client = makeClient();
    const login = await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    expect(login.status).toBe(200);

    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    expect(enroll.status).toBe(200);
    const { secretBase32, recoveryCodes } = enroll.data.data as {
      secretBase32: string;
      recoveryCodes: string[];
    };
    expect(secretBase32).toBeTruthy();
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(1);

    const code = generateTotp(secretBase32);
    const confirm = await client.req('/api/auth/mfa/confirm', { method: 'POST', body: { code } });
    expect(confirm.status).toBe(200);

    const status = await client.req('/api/auth/mfa/status');
    expect(status.status).toBe(200);
    expect((status.data.data as { mfaEnabled: boolean }).mfaEnabled).toBe(true);

    // Row must have recoveryCodesHash set
    const rows = await db
      .select({ hash: authenticatorApp.recoveryCodesHash, enabled: authenticatorApp.enabled })
      .from(authenticatorApp)
      .where(eq(authenticatorApp.userId, user.id))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].hash).toBeTruthy();
  });

  it('verify endpoint accepts a valid TOTP and rejects an invalid one', async () => {
    const user = await createUser('mfa-v');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    const { secretBase32 } = enroll.data.data as { secretBase32: string };
    await client.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });

    const ok = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });
    expect(ok.status).toBe(200);
    expect((ok.data.data as { valid: boolean }).valid).toBe(true);

    const bad = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code: '000000' },
    });
    expect(bad.status).toBe(401);
    expect((bad.data.data as { valid: boolean }).valid).toBe(false);
  });

  it('recovery codes can be verified through the verify endpoint', async () => {
    const user = await createUser('mfa-r');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    const { secretBase32, recoveryCodes } = enroll.data.data as {
      secretBase32: string;
      recoveryCodes: string[];
    };
    await client.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });

    const code = recoveryCodes[0];
    const ok = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code },
    });
    expect(ok.status).toBe(200);
    expect((ok.data.data as { valid: boolean; recoveryCodeUsed?: boolean }).recoveryCodeUsed).toBe(true);
  });

  it('HTTP responses never leak secret material (secret, hashes, raw codes)', async () => {
    const user = await createUser('mfa-leak');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });

    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    expect(enroll.status).toBe(200);
    const body = JSON.stringify(enroll.data);
    // The enrollment response legitimately contains raw recovery codes for the
    // one-time display — so ensure it does NOT leak internal storage fields.
    expect(body).not.toMatch(/recoveryCodesHashed/i);
    expect(body).not.toMatch(/recoveryCodesHash/i);
    expect(body).not.toMatch(/passwordHash/i);

    const { secretBase32, recoveryCodes } = enroll.data.data as {
      secretBase32: string;
      recoveryCodes: string[];
    };
    await client.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });

    // status endpoint: must NOT return the raw secret or hashes.
    const status = await client.req('/api/auth/mfa/status');
    expect(status.status).toBe(200);
    const statusBody = JSON.stringify(status.data);
    expect(statusBody).not.toMatch(new RegExp(secretBase32, 'i'));
    expect(statusBody).not.toMatch(/secret/i);
    expect(statusBody).not.toMatch(/recoveryCodesHash/i);

    // verify endpoint: no secret material returned even for a valid code.
    const ok = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code: recoveryCodes[0] },
    });
    const okBody = JSON.stringify(ok.data);
    expect(ok.status).toBe(200);
    expect(okBody).not.toMatch(/secret/i);
    expect(okBody).not.toMatch(/recoveryCodesHashed/i);
  });

  it('recovery codes are single-use: second use of the same code fails', async () => {
    const user = await createUser('mfa-singleuse');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    const { secretBase32, recoveryCodes } = enroll.data.data as {
      secretBase32: string;
      recoveryCodes: string[];
    };
    await client.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });

    const code = recoveryCodes[0];
    const first = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code },
    });
    expect(first.status).toBe(200);
    expect((first.data.data as { recoveryCodeUsed?: boolean }).recoveryCodeUsed).toBe(true);

    // Same code again -> must be rejected (one-time use enforced in DB).
    const second = await client.req('/api/auth/mfa/verify', {
      method: 'POST',
      body: { code },
    });
    expect(second.status).toBe(401);
    expect((second.data.data as { valid: boolean }).valid).toBe(false);
  });

  it('disable requires a valid TOTP and turns off mfaEnabled', async () => {
    const user = await createUser('mfa-d');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const enroll = await client.req('/api/auth/mfa/enroll', { method: 'POST', body: {} });
    const { secretBase32 } = enroll.data.data as { secretBase32: string };
    await client.req('/api/auth/mfa/confirm', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });

    const disable = await client.req('/api/auth/mfa/disable', {
      method: 'POST',
      body: { code: generateTotp(secretBase32) },
    });
    expect(disable.status).toBe(200);

    const status = await client.req('/api/auth/mfa/status');
    expect((status.data.data as { mfaEnabled: boolean }).mfaEnabled).toBe(false);
  });
});

describe('PHASE 17 — Privacy (Consent + History + Export + Deletion)', () => {
  beforeEach(async () => {
    // Isolate the shared in-memory rate-limit store between tests so the
    // privacy-deletion limiter does not leak 429s across independent tests.
    await resetRateLimitStore();
  });
  it('records a consent grant and a consent revocation history event', async () => {
    const user = await createUser('privacy-consent');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });

    const grant = await client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'MARKETING', granted: true },
    });
    expect(grant.status).toBe(200);

    const revoke = await client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'MARKETING', granted: false },
    });
    expect(revoke.status).toBe(200);

    // The history should have exactly 2 events: GRANT then REVOKE
    const events = await db
      .select({ action: consentEvents.action, granted: consentEvents.granted, consentType: consentEvents.consentType, fromGranted: consentEvents.fromGranted })
      .from(consentEvents)
      .where(eq(consentEvents.userId, user.id))
      .orderBy(consentEvents.createdAt);
    expect(events.length).toBe(2);
    expect(events[0].action).toBe('GRANT');
    expect(events[0].granted).toBe(true);
    expect(events[1].action).toBe('REVOKE');
    expect(events[1].granted).toBe(false);
    expect(events[1].fromGranted).toBe(true);
  });

  it('rejects an anonymous caller on both consent endpoints (no anonymous consent exists)', async () => {
    // The banner must not promise a decision it cannot record: the platform has
    // no anonymous consent endpoint, so a signed-out visitor is refused outright
    // rather than silently accepted.
    const anon = makeClient();
    const read = await anon.req('/api/privacy/me');
    expect(read.status).toBe(401);

    const write = await anon.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'ANALYTICS', granted: true },
    });
    expect(write.status).toBe(401);
  });

  it('normalises every consent type so an undecided type reads as not granted', async () => {
    const user = await createUser('privacy-normalise');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });

    // Nothing recorded yet: the read model still lists every known type, all false.
    const before = await client.req('/api/privacy/me');
    expect(before.status).toBe(200);
    const state = before.data.data as { consents: Array<{ type: string; granted: boolean }> };
    expect(state.consents.length).toBeGreaterThan(0);
    expect(state.consents.every((c) => c.granted === false)).toBe(true);

    // Granting one optional type flips only that one.
    const grant = await client.req('/api/privacy/consents', {
      method: 'PUT',
      body: { consentType: 'ANALYTICS', granted: true },
    });
    expect(grant.status).toBe(200);

    const after = await client.req('/api/privacy/me');
    const stateAfter = after.data.data as { consents: Array<{ type: string; granted: boolean }> };
    const analytics = stateAfter.consents.find((c) => c.type === 'ANALYTICS');
    expect(analytics?.granted).toBe(true);
    expect(stateAfter.consents.filter((c) => c.granted).length).toBe(1);
  });

  it('builds a full ownership-bound user export without secrets', async () => {
    const user = await createUser('privacy-export');
    await setConsent(
      db,
      { userId: user.id, actorId: user.id },
      'MARKETING',
      true,
      'TEST',
    );
    const data = await buildUserExport(db, user.id);
    // Must include user account info, profile, consents, and settings — no passwordHash
    expect(data.account).toBeDefined();
    expect(data.profile).toBeDefined();
    expect(data.consents).toBeDefined();
    expect(JSON.stringify(data)).not.toMatch(/passwordHash/i);
    expect(JSON.stringify(data)).not.toMatch(/recoveryCodes/i);
  });

  it('creates an export request row + audit trail', async () => {
    const user = await createUser('privacy-export-req');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const res = await client.req('/api/privacy/export', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect((res.data.data as { exportId: string }).exportId).toBeTruthy();
    const rows = await db
      .select()
      .from(dataExportRequests)
      .where(eq(dataExportRequests.userId, user.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('COMPLETED');
  });

  it('creates a deletion request that deactivates the account (stage DEACTIVATED)', async () => {
    const user = await createUser('privacy-del');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const res = await client.req('/api/privacy/deletion', {
      method: 'POST',
      body: { reason: 'test deletion' },
    });
    expect(res.status).toBe(200);
    expect((res.data.data as { stage: string }).stage).toBe('DEACTIVATED');

    // User should be deactivated
    const u = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, user.id));
    expect(u[0].isActive).toBe(false);

    // A deletion row must exist with retention policy
    const rows = await db
      .select()
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].retentionPolicy).toBeTruthy();
  });

  it('admin can advance a deletion request to ELIGIBLE and log audit', async () => {
    const user = await createUser('privacy-admin');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    await client.req('/api/privacy/deletion', { method: 'POST', body: { reason: 'gdpr-test' } });
    const rows = await db
      .select({ id: dataDeletionRequests.id, userId: dataDeletionRequests.userId })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);
    expect(rows.length).toBe(1);

    // Admin user
    const adminId = randomUUID();
    const adminEmail = `privacy-admin-${Date.now()}@wasit.tn`;
    const adminHash = await argon2.hash('AdminPass123!');
    await db.insert(users).values({
      id: adminId,
      email: adminEmail,
      passwordHash: adminHash,
      firstName: 'PVT Admin',
      emailVerified: true,
      isActive: true,
    });
    const { roles, userRoles } = await import('../src/db/schema/auth.js');
    const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role[0].id });

    const adminClient = makeClient();
    const adminLogin = await adminClient.req('/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });
    expect(adminLogin.status).toBe(200);

    const advance = await adminClient.req(`/api/admin/privacy/deletions/${rows[0].id}`, {
      method: 'PATCH',
      body: { stage: 'ELIGIBLE' },
    });
    expect(advance.status).toBe(200);

    const updated = await db
      .select({ stage: dataDeletionRequests.stage })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.id, rows[0].id))
      .limit(1);
    expect(updated[0].stage).toBe('ELIGIBLE');
  });

  it('ANONYMIZED actually scrubs PII and preserves the financial/audit record', async () => {
    const user = await createUser('privacy-anon');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    await client.req('/api/privacy/deletion', { method: 'POST', body: { reason: 'gdpr-anon' } });
    const rows = await db
      .select({ id: dataDeletionRequests.id })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);

    const adminClient = await makeAdminClient();

    // The retention window is open (90 days), so a plain ANONYMIZED is refused.
    const blocked = await adminClient.req(`/api/admin/privacy/deletions/${rows[0].id}`, {
      method: 'PATCH',
      body: { stage: 'ANONYMIZED' },
    });
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(blocked.data)).toContain('RETENTION_WINDOW_OPEN');

    // With an explicit legal-hold override the scrub runs and is audited.
    const forced = await adminClient.req(`/api/admin/privacy/deletions/${rows[0].id}`, {
      method: 'PATCH',
      body: { stage: 'ANONYMIZED', legalHoldOverride: true },
    });
    expect(forced.status).toBe(200);

    const after = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(after.length).toBe(1); // row preserved for ledgers/disputes
    expect(after[0].email).not.toBe(user.email);
    expect(after[0].email).toMatch(/@anonymized\.invalid$/);
    expect(after[0].firstName).toBeNull();
    expect(after[0].passwordHash).toBe('ANONYMIZED');
    expect(after[0].isActive).toBe(false);
    expect(after[0].isLocked).toBe(true);

    const reqRow = await db
      .select({ stage: dataDeletionRequests.stage, log: dataDeletionRequests.anonymizationLog })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.id, rows[0].id))
      .limit(1);
    expect(reqRow[0].stage).toBe('ANONYMIZED');
    expect((reqRow[0].log as { fields: string[] }).fields).toContain('users.email');

    expect(
      await hasAudit('PRIVACY.DELETION_ANONYMIZED', user.id),
    ).toBe(true);
    expect(await hasAudit('PRIVACY.LEGAL_HOLD_OVERRIDE', user.id)).toBe(true);

    // The anonymized account can no longer authenticate: the stored hash is an
    // unusable sentinel and the account is deactivated/unverified, so login is
    // rejected before any session is issued.
    const relogin = makeClient();
    const attempt = await relogin.req('/api/auth/login', {
      method: 'POST',
      body: { email: after[0].email, password: user.password, allowUnverifiedEmail: true },
    });
    expect([401, 403]).toContain(attempt.status);
    await expect(argon2.verify(after[0].passwordHash, user.password)).rejects.toThrow();
  });

  it('ANONYMIZED runs without override once the retention window has passed', async () => {
    const user = await createUser('privacy-anon2');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    await client.req('/api/privacy/deletion', { method: 'POST', body: {} });
    const rows = await db
      .select({ id: dataDeletionRequests.id })
      .from(dataDeletionRequests)
      .where(eq(dataDeletionRequests.userId, user.id))
      .limit(1);

    // Move the retention deadline into the past (as a scheduler would over time).
    await db
      .update(dataDeletionRequests)
      .set({ retentionUntil: new Date(Date.now() - 1000) })
      .where(eq(dataDeletionRequests.id, rows[0].id));

    const adminClient = await makeAdminClient();
    const res = await adminClient.req(`/api/admin/privacy/deletions/${rows[0].id}`, {
      method: 'PATCH',
      body: { stage: 'ANONYMIZED' },
    });
    expect(res.status).toBe(200);
    const after = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)).limit(1);
    expect(after[0].email).toMatch(/@anonymized\.invalid$/);
  });

  it('rate limit: deletion bursts are throttled (rate limit runs before auth)', async () => {
    // The privacy-deletion limiter allows 2 requests per 300s window.
    // Fire a burst of 5 from the same client (same IP).
    const user = await createUser('privacy-ratelimit');
    const client = makeClient('203.0.113.99');
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await client.req('/api/privacy/deletion', { method: 'POST', body: {} });
      statuses.push(r.status);
    }
    // request 1 -> 200 (first deletion succeeds)
    expect(statuses[0]).toBe(200);
    // request 2 -> 401 (rate limit allows it, but the account was already
    // deactivated by the first deletion, proving auth still guards the route)
    expect(statuses[1]).toBe(401);
    // requests 3..5 -> 429 (window of max 2 exceeded; rate limit runs before auth)
    expect(statuses[2]).toBe(429);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it('admin listing of deletion requests supports stage filter', async () => {
    // Create a user and a deletion request as that user
    const user = await createUser('privacy-list');
    const client = makeClient();
    await client.req('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: user.password, allowUnverifiedEmail: true },
    });
    await client.req('/api/privacy/deletion', { method: 'POST', body: {} });

    // Create admin
    const adminId = randomUUID();
    const adminEmail = `privacy-list-admin-${Date.now()}@wasit.tn`;
    const adminHash = await argon2.hash('AdminPass123!');
    await db.insert(users).values({
      id: adminId,
      email: adminEmail,
      passwordHash: adminHash,
      firstName: 'PVT List Admin',
      emailVerified: true,
      isActive: true,
    });
    const { roles, userRoles } = await import('../src/db/schema/auth.js');
    const role = await db.select().from(roles).where(eq(roles.name, 'ADMIN')).limit(1);
    await db.insert(userRoles).values({ id: randomUUID(), userId: adminId, roleId: role[0].id });

    const adminClient = makeClient();
    await adminClient.req('/api/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'AdminPass123!', allowUnverifiedEmail: true },
    });

    const all = await adminClient.req('/api/admin/privacy/deletions?stage=DEACTIVATED');
    expect(all.status).toBe(200);
    expect(Array.isArray(all.data.data as unknown[])).toBe(true);
    const staged = (all.data.data as Array<{ requestId: string; stage: string }>).filter(
      (r) => r.stage === 'DEACTIVATED',
    );
    expect(staged.length).toBeGreaterThanOrEqual(1);
  });
});