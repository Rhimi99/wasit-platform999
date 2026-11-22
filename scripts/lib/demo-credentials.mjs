/**
 * Demo credential lookup for operational scripts.
 *
 * Since DEMO-SEC-03 every demo account has its own random password. Scripts
 * must never embed one: they ask for the password of the account they are about
 * to log in as, and this module resolves it from the process environment or the
 * git-ignored `.env.demo` file. Nothing is printed or logged here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ACCOUNT_KEYS = {
  'customer1@wasit.tn': 'DEMO_ACCOUNT_PASSWORD_CUSTOMER1',
  'merchanta@wasit.tn': 'DEMO_ACCOUNT_PASSWORD_MERCHANTA',
  'suppliera@wasit.tn': 'DEMO_ACCOUNT_PASSWORD_SUPPLIERA',
  'companya@wasit.tn': 'DEMO_ACCOUNT_PASSWORD_COMPANYA',
  'demo@wasit.tn': 'DEMO_ACCOUNT_PASSWORD_DEMO',
  'admin@wasit.tn': 'DEMO_STAFF_PASSWORD_ADMIN',
  'admin2@wasit.tn': 'DEMO_STAFF_PASSWORD_ADMIN2',
};

let fileCache = null;

function readEnvFile() {
  if (fileCache) return fileCache;
  const file = process.env.DEMO_ENV_FILE ?? path.join(ROOT, '.env.demo');
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2];
    }
  } catch {
    // No file: only the process environment can supply credentials.
  }
  fileCache = values;
  return values;
}

/** Password for a demo account, or throws when it is not configured. */
export function demoPasswordFor(email) {
  const key = ACCOUNT_KEYS[email.toLowerCase()];
  if (!key) throw new Error(`No demo credential mapping for ${email}`);
  const fromEnv = (process.env[key] ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = (readEnvFile()[key] ?? '').trim();
  if (fromFile) return fromFile;
  throw new Error(`Demo credential ${key} is not set (env or .env.demo)`);
}

export const DEMO_ACCOUNTS = Object.keys(ACCOUNT_KEYS);
