import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { env } from '../src/lib/env.js';
import {
  PRODUCTION_MEDIA_DIR_NAME,
  TEST_MEDIA_DIR_NAME,
  assertIsolatedMediaDir,
  isTestRuntime,
} from '../src/lib/media/isolation.js';
import { LocalMediaStorage } from '../src/lib/media/local-storage.js';
import { resolveMediaStorage } from '../src/lib/media/resolve.js';
import { testMediaDirPath } from './test-media-dir';

/**
 * Proves the suite can never write rendered media into the real store.
 *
 * Deliberately DB-free: run it without provisioning a database via
 *   SKIP_DB_SETUP=1 npx vitest run tests/media-storage-isolation.test.ts
 * (TEST_DATABASE_URL is still validated by vitest.config.ts, never contacted.)
 */

const productionDir = path.resolve(PRODUCTION_MEDIA_DIR_NAME);
const testDir = testMediaDirPath();

function listing(dir: string): string[] {
  return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [];
}

describe('media storage isolation', () => {
  it('runs in a test runtime', () => {
    expect(isTestRuntime()).toBe(true);
  });

  it('pins the suite to the dedicated test store', () => {
    expect(path.resolve(env.MEDIA_STORAGE_DIR)).toBe(testDir);
    expect(path.basename(testDir)).toBe(TEST_MEDIA_DIR_NAME);
    expect(testDir).not.toBe(productionDir);
  });

  it('refuses the production store while tests are running', () => {
    expect(() => assertIsolatedMediaDir(PRODUCTION_MEDIA_DIR_NAME)).toThrow(
      /production media store/,
    );
    expect(() => new LocalMediaStorage(PRODUCTION_MEDIA_DIR_NAME)).toThrow(
      /production media store/,
    );
  });

  it('accepts the test store and an explicit temporary directory', () => {
    expect(() => assertIsolatedMediaDir(TEST_MEDIA_DIR_NAME)).not.toThrow();
    expect(() => new LocalMediaStorage(testDir)).not.toThrow();
    expect(() => new LocalMediaStorage(path.join(testDir, 'tmp-subdir'))).not.toThrow();
  });

  it('is inert outside a test runtime', () => {
    const productionEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete productionEnv.VITEST;
    expect(isTestRuntime(productionEnv)).toBe(false);
    expect(() => assertIsolatedMediaDir(PRODUCTION_MEDIA_DIR_NAME, productionEnv)).not.toThrow();
  });

  it('writes rendered media only into the test store, never the real one', async () => {
    const before = listing(productionDir);
    const storage = resolveMediaStorage();
    const key = `videos/isolation-probe-${process.pid}.mp4`;

    await storage.put({ key, body: Buffer.from('probe'), contentType: 'video/mp4' });
    try {
      expect(existsSync(path.join(testDir, key))).toBe(true);
      expect(existsSync(path.join(productionDir, key))).toBe(false);
      expect(listing(productionDir)).toEqual(before);
    } finally {
      await storage.delete(key);
    }
    expect(existsSync(path.join(testDir, key))).toBe(false);
  });
});
