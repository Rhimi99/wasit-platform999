import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  describeIdentity,
  evaluateProductionGate,
  isProtectedDatabaseName,
  readDatabaseIdentity,
  type DatabaseIdentity,
} from '../src/lib/db-target-guard.js';
import { db } from '../src/db/client.js';

const run = promisify(execFile);

const PROD: DatabaseIdentity = { name: 'wasit_prod', host: '10.0.0.12', port: 5432, user: 'wasit' };

function gate(identity: Partial<DatabaseIdentity>, env: { nodeEnv?: string; declaredName?: string; declaredHost?: string }) {
  return evaluateProductionGate({
    identity: { ...PROD, ...identity },
    nodeEnv: env.nodeEnv,
    declaredName: env.declaredName,
    declaredHost: env.declaredHost,
  });
}

describe('GM-ACCESS-04 — protected names', () => {
  it('treats every test, demo, dev, staging and system database as protected', () => {
    for (const name of [
      'wasit_test',
      'wasit_demo',
      'wasit_dev',
      'wasit_staging',
      'postgres',
      'template0',
      'template1',
      'template42',
      '_restore_20260101',
      '_drill_x',
      'anything_test',
      'anything_demo',
      'WASIT_TEST',
      '  wasit_demo  ',
    ]) {
      expect(isProtectedDatabaseName(name), name).toBe(true);
    }
  });

  it('does not protect a production-looking name', () => {
    for (const name of ['wasit_prod', 'wasit_production', 'wasit', 'wasit_live']) {
      expect(isProtectedDatabaseName(name), name).toBe(false);
    }
  });
});

describe('GM-ACCESS-04 — the gate refuses anything it cannot prove is production', () => {
  it('refuses when the deployment does not declare production', () => {
    for (const nodeEnv of [undefined, '', 'development', 'test', 'staging', 'PRODUCTION ']) {
      const decision = gate({}, { nodeEnv, declaredName: 'wasit_prod' });
      // Only the exact value "production" (case-insensitive) passes; the trailing
      // space case is trimmed and therefore allowed, so it is excluded here.
      if ((nodeEnv ?? '').trim().toLowerCase() === 'production') continue;
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ code: 'NOT_PRODUCTION_ENV' });
    }
  });

  it('refuses when no production database name is declared', () => {
    for (const declaredName of [undefined, '', '   ']) {
      const decision = gate({}, { nodeEnv: 'production', declaredName });
      expect(decision.allowed).toBe(false);
      expect(decision).toMatchObject({ code: 'PRODUCTION_NAME_UNDECLARED' });
    }
  });

  it('refuses wasit_test, wasit_demo and postgres even when the deployment declares them', () => {
    for (const name of ['wasit_test', 'wasit_demo', 'postgres']) {
      const decision = gate({ name }, { nodeEnv: 'production', declaredName: name });
      expect(decision.allowed, name).toBe(false);
      expect(decision).toMatchObject({ code: 'PROTECTED_DATABASE' });
    }
  });

  it('refuses when the declaration and the server disagree', () => {
    const decision = gate({ name: 'wasit_prod' }, { nodeEnv: 'production', declaredName: 'wasit_live' });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ code: 'DATABASE_MISMATCH' });
  });

  it('refuses when the optional host pin does not match the server', () => {
    const decision = gate({ host: '10.0.0.99' }, { nodeEnv: 'production', declaredName: 'wasit_prod', declaredHost: '10.0.0.12' });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ code: 'HOST_MISMATCH' });
  });

  it('never leaks a credential in the refusal message', () => {
    const decision = gate({ name: 'wasit_test' }, { nodeEnv: 'production', declaredName: 'wasit_test' });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.message).not.toMatch(/postgres(ql)?:\/\//);
    expect(decision.message).not.toContain('@');
  });
});

describe('GM-ACCESS-04 — the gate accepts a correctly declared production target', () => {
  it('allows production when the deployment declares the same database', () => {
    expect(gate({}, { nodeEnv: 'production', declaredName: 'wasit_prod' })).toEqual({ allowed: true });
  });

  it('allows a differently named production database when it is declared', () => {
    expect(gate({ name: 'wasit_live' }, { nodeEnv: 'production', declaredName: 'wasit_live' })).toEqual({ allowed: true });
  });

  it('allows when the optional host pin matches', () => {
    expect(gate({}, { nodeEnv: 'production', declaredName: 'wasit_prod', declaredHost: '10.0.0.12' })).toEqual({ allowed: true });
  });

  it('treats the name and environment case-insensitively', () => {
    expect(gate({ name: 'WASIT_PROD' }, { nodeEnv: 'Production', declaredName: 'wasit_prod' })).toEqual({ allowed: true });
  });
});

describe('GM-ACCESS-04 — identity comes from the server, not the connection string', () => {
  it('reads the live database identity', async () => {
    const identity = await readDatabaseIdentity(db);
    expect(identity.name).toMatch(/_test$/);
    expect(identity.user.length).toBeGreaterThan(0);
    expect(identity.host.length).toBeGreaterThan(0);
    expect(identity.port === null || typeof identity.port === 'number').toBe(true);
  });

  it('describes the target without any credential', () => {
    const line = describeIdentity(PROD);
    expect(line).toBe('database "wasit_prod" on 10.0.0.12:5432 as wasit');
    expect(line).not.toContain('password');
  });
});

/**
 * End-to-end: the real CLI process, pointed at the test database, must refuse
 * before it touches anything. These run the shipped script, not a copy of the
 * logic, so a missing call site in `main()` would fail them.
 */
describe('GM-ACCESS-04 — the CLI itself refuses a non-production database', () => {
  const script = join(process.cwd(), 'src/scripts/gm-access.ts');
  // Hoisted to the workspace root by npm workspaces.
  const tsx = join(process.cwd(), '..', '..', 'node_modules', '.bin', 'tsx');
  // Deliberately nonexistent: the guard must refuse before any file is read.
  const secretFile = join(process.cwd(), 'tests', '.gm-guard-probe-absent.txt');
  // `lib/env.ts` refuses to boot a production process on the committed default
  // secret, so the probe supplies its own; nothing here is a real credential.
  const bootSecret = randomBytes(32).toString('hex');

  async function runCli(args: string[], env: Record<string, string>) {
    try {
      const { stdout, stderr } = await run(tsx, [script, ...args], {
        cwd: process.cwd(),
        // A deliberately minimal environment: the probe must boot as a
        // production process, so the suite's own demo flags (DEMO_PAYMENT_MODE,
        // raised rate limits, test media dir) are not inherited into it.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          DOTENV_CONFIG_PATH: '/nonexistent/.env',
          JWT_SECRET: bootSecret,
          DATABASE_URL: process.env.DATABASE_URL ?? '',
          ...env,
        },
        timeout: 60_000,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('refuses set-password on wasit_test even when NODE_ENV claims production', async () => {
    const result = await runCli(
      ['set-password', '--email', 'nobody@wasit.tn', '--reason', 'guard probe, must refuse', '--confirm', '--password-file', secretFile],
      { NODE_ENV: 'production', WASIT_PRODUCTION_DB_NAME: 'wasit_test' },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test, demo, development, staging or system database');
    expect(result.stdout).not.toContain('Password replaced');
    // Refused before the account lookup, so the reason it was given never reached
    // the database and no audit row could have been written.
    expect(result.stderr).not.toContain('No account with that address');
  });

  it('refuses reset-factor on wasit_test when the deployment declares no production name', async () => {
    const result = await runCli(
      ['reset-factor', '--email', 'nobody@wasit.tn', '--reason', 'guard probe, must refuse', '--confirm'],
      { NODE_ENV: 'production' },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('WASIT_PRODUCTION_DB_NAME is not set');
  });

  it('refuses set-password in development even when the name is declared', async () => {
    const result = await runCli(
      ['set-password', '--email', 'nobody@wasit.tn', '--reason', 'guard probe, must refuse', '--confirm', '--password-file', secretFile],
      { NODE_ENV: 'development', WASIT_PRODUCTION_DB_NAME: 'wasit_test' },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not "production"');
  });

  it('leaves status ungated, so an operator can inspect a test deployment', async () => {
    const result = await runCli(['status', '--email', 'nobody@wasit.tn'], { NODE_ENV: 'test' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No account with that address');
  });
});
