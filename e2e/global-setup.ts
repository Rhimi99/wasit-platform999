import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { COOKIE_CONSENT_DECIDED_KEY } from './helpers';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173';
const PASSWORD = 'Passw0rd!2026';

const ROLES = {
  customer: 'customer1@wasit.tn',
  supplier: 'suppliera@wasit.tn',
  merchant: 'merchanta@wasit.tn',
  company: 'companya@wasit.tn',
  admin: 'admin@wasit.tn',
  admin2: 'admin2@wasit.tn',
} as const;

/**
 * 1. Seeds the dev database through the project's own idempotent demo seeder
 *    (documented in AGENTS.md / DEPLOYMENT.md) — real services, no mocks, no drop.
 * 2. Authenticates each demo role through the REAL POST /api/auth/login and stores
 *    the resulting session cookie as Playwright `storageState`, so role-based specs
 *    do not each re-drive the login form (which would trip the production-default
 *    login rate limiter). The login form itself is still exercised by auth.spec.ts.
 */
export default async function globalSetup(): Promise<void> {
  const api = await request.newContext({ baseURL: API_URL });
  const ready = await api.get('/api/health/ready');
  if (!ready.ok()) {
    throw new Error(`Backend not ready at ${API_URL}: HTTP ${ready.status()}`);
  }
  await api.dispose();

  execSync('npx tsx src/scripts/seed-demo.ts', {
    cwd: 'packages/server',
    stdio: 'inherit',
    // Restore declared demo stock so the spec that orders a product starts from
    // a known quantity rather than whatever previous runs left behind.
    env: { ...process.env, SEED_RESET_STOCK: '1' },
  });

  const authDir = path.resolve(process.cwd(), 'e2e/.auth');
  fs.mkdirSync(authDir, { recursive: true });

  for (const [role, email] of Object.entries(ROLES)) {
    const ctx = await request.newContext({ baseURL: API_URL });
    let res = await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } });
    if (res.status() === 401) {
      // A previous interrupted run (e.g. the password-recovery spec) may have left a
      // demo account on a different password. Repair it through the real reset flow so
      // the fixture is deterministic without touching data or schema by hand.
      const forgot = await ctx.post('/api/auth/forgot-password', { data: { email } });
      const token = (await forgot.json())?.data?.devResetToken;
      if (!token) throw new Error(`Cannot repair password for ${email}: no dev reset token`);
      const reset = await ctx.post('/api/auth/reset-password', { data: { token, newPassword: PASSWORD } });
      if (!reset.ok()) throw new Error(`Cannot repair password for ${email}: HTTP ${reset.status()}`);
      res = await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } });
    }
    if (!res.ok()) {
      throw new Error(`Login failed for ${role} (${email}): HTTP ${res.status()}`);
    }
    await ctx.storageState({ path: path.join(authDir, `${role}.json`) });
    await ctx.dispose();

    // The shared role sessions are returning accounts, so record the
    // cookie-consent notice as already answered in their stored localStorage.
    // Specs that build a context from `storageFor(role)` directly bypass the
    // `suppressCookieConsent` fixture, so the marker has to live in the state
    // file itself; without it the bottom-fixed notice would cover page furniture
    // in those specs. First-visit behaviour is asserted by cookie-consent.spec.ts.
    const statePath = path.join(authDir, `${role}.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.origins = [
      ...(state.origins ?? []).filter((o: { origin: string }) => o.origin !== WEB_URL),
      { origin: WEB_URL, localStorage: [{ name: COOKIE_CONSENT_DECIDED_KEY, value: '1' }] },
    ];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}