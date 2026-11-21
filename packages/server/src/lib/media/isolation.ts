import path from 'node:path';

/** Store used by the test suite for generated media. Cleaned up after a run. */
export const TEST_MEDIA_DIR_NAME = '.wasit-media-test';

/** Default store holding real (user/production) assets. Never written by tests. */
export const PRODUCTION_MEDIA_DIR_NAME = '.wasit-media';

/**
 * True when the current process is a test run.
 *
 * Evaluated per call, never cached, so a spec can prove the production
 * behaviour by passing its own environment object.
 */
export function isTestRuntime(envVars: NodeJS.ProcessEnv = process.env): boolean {
  return envVars.NODE_ENV === 'test' || envVars.VITEST === 'true' || envVars.VITEST === '1';
}

/**
 * Refuses to point a test run at the real media store.
 *
 * The suite renders real MP4 files. Without this guard a missing or leaked
 * `MEDIA_STORAGE_DIR` drops those renders next to user assets, where a later
 * cleanup cannot tell test output from real work. Only the default store is
 * refused: an explicit temporary directory stays valid for focused unit tests.
 */
export function assertIsolatedMediaDir(
  dir: string,
  envVars: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTestRuntime(envVars)) return;

  const target = path.resolve(dir);
  const production = path.resolve(PRODUCTION_MEDIA_DIR_NAME);
  if (target === production) {
    throw new Error(
      `Refusing to use the production media store (${target}) in a test run. ` +
        `Set MEDIA_STORAGE_DIR=${TEST_MEDIA_DIR_NAME} (vitest.config.ts does this) ` +
        'or pass a dedicated temporary directory.',
    );
  }
}
