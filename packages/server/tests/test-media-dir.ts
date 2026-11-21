import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import {
  PRODUCTION_MEDIA_DIR_NAME,
  TEST_MEDIA_DIR_NAME,
} from '../src/lib/media/isolation.js';

export function testMediaDirPath(): string {
  return path.resolve(process.cwd(), TEST_MEDIA_DIR_NAME);
}

/**
 * Only the dedicated test store may be deleted. Checked at the point of
 * deletion, not just at construction, so a wrong cwd can never widen the target
 * to the production store or one of its subdirectories.
 */
function assertSafeTarget(): string {
  const dir = testMediaDirPath();
  const production = path.resolve(PRODUCTION_MEDIA_DIR_NAME);
  if (
    path.basename(dir) !== TEST_MEDIA_DIR_NAME ||
    dir === production ||
    dir.startsWith(production + path.sep)
  ) {
    throw new Error(`Refusing to clean '${dir}': it is not the dedicated test media store`);
  }
  return dir;
}

export async function resetTestMediaDir(): Promise<string> {
  const dir = assertSafeTarget();
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeTestMediaDir(): Promise<void> {
  await rm(assertSafeTarget(), { recursive: true, force: true });
}
