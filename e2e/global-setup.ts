import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';
import { CONSENT_STORAGE_KEY, consentRecord, E2E_WEB_URL } from './helpers';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const WEB_URL = E2E_WEB_URL;
// Dev default only. Rotated deployments (DEMO-SEC-03) export a unique password
// per account, and the fixture must follow it instead of assuming the published
// one — otherwise rotation silently breaks every role-based spec.
const PASSWORD = 'Passw0rd!2026';

const CREDENTIALS = {
  customer: process.env.DEMO_ACCOUNT_PASSWORD_CUSTOMER1 ?? PASSWORD,
  supplier: process.env.DEMO_ACCOUNT_PASSWORD_SUPPLIERA ?? PASSWORD,
  merchant: process.env.DEMO_ACCOUNT_PASSWORD_MERCHANTA ?? PASSWORD,
  company: process.env.DEMO_ACCOUNT_PASSWORD_COMPANYA ?? PASSWORD,
  admin: process.env.DEMO_STAFF_PASSWORD_ADMIN ?? process.env.DEMO_STAFF_PASSWORD ?? PASSWORD,
  admin2: process.env.DEMO_STAFF_PASSWORD_ADMIN2 ?? process.env.DEMO_STAFF_PASSWORD ?? PASSWORD,
} as const;

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
    const password = CREDENTIALS[role as keyof typeof CREDENTIALS];
    const ctx = await request.newContext({ baseURL: API_URL });
    let res = await ctx.post('/api/auth/login', { data: { email, password } });
    if (res.status() === 401) {
      // A previous interrupted run (e.g. the password-recovery spec) may have left a
      // demo account on a different password. Repair it through the real reset flow so
      // the fixture is deterministic without touching data or schema by hand.
      const forgot = await ctx.post('/api/auth/forgot-password', { data: { email } });
      const token = (await forgot.json())?.data?.devResetToken;
      if (!token) throw new Error(`Cannot repair password for ${email}: no dev reset token`);
      const reset = await ctx.post('/api/auth/reset-password', { data: { token, newPassword: password } });
      if (!reset.ok()) throw new Error(`Cannot repair password for ${email}: HTTP ${reset.status()}`);
      res = await ctx.post('/api/auth/login', { data: { email, password } });
    }
    if (!res.ok()) {
      throw new Error(`Login failed for ${role} (${email}): HTTP ${res.status()}`);
    }
    // Seed the stored consent decision into the state itself, so contexts created
    // straight from this file (e.g. `browser.newContext({ storageState })`) also
    // start as a returning visitor and never render the fixed consent banner over
    // the sidebar's bottom controls. The origin key must equal the web URL exactly
    // or the browser ignores the entry.
    const state = await ctx.storageState();
    state.origins = [
      ...(state.origins ?? []),
      {
        origin: WEB_URL,
        localStorage: [{ name: CONSENT_STORAGE_KEY, value: JSON.stringify(consentRecord()) }],
      },
    ];
    fs.writeFileSync(path.join(authDir, `${role}.json`), JSON.stringify(state, null, 2));
    await ctx.dispose();
  }
}