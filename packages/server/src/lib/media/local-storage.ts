import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import type { MediaStorage, PutObjectInput, StoredObject } from './port.js';

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

/** Rejects path-traversal / odd keys before they ever touch the filesystem. */
function validateKey(key: string): void {
  const segments = key.split('/');
  const valid =
    segments.length > 0 &&
    segments.every((seg) => seg !== '.' && seg !== '..' && SEGMENT_RE.test(seg));
  if (!valid || key.includes('..') || key.startsWith('/')) {
    throw new Error(`Invalid media storage key: ${key}`);
  }
}

/**
 * Local filesystem media store, rooted at `MEDIA_STORAGE_DIR`.
 *
 * Security: keys are opaque and validated against a strict charset, and every
 * resolved path is re-checked to stay inside the root — a crafted key can never
 * read or overwrite a file outside the store.
 */
export class LocalMediaStorage implements MediaStorage {
  readonly id = 'local';
  constructor(private readonly baseDir: string = env.MEDIA_STORAGE_DIR) {}

  private resolveKey(key: string): string {
    validateKey(key);
    const root = path.resolve(this.baseDir);
    const full = path.resolve(root, key);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`Media storage key escapes the store root: ${key}`);
    }
    return full;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await mkdir(path.resolve(this.baseDir), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const full = this.resolveKey(input.key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
    return { key: input.key, size: input.body.length, contentType: input.contentType };
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolveKey(key);
    return readFile(full);
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const full = this.resolveKey(key);
    const length = end - start + 1;
    const handle = await open(full, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const s = await stat(this.resolveKey(key));
      return s.size;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }
}

/** Exposed for drivers that stream large objects (kept internal to the port). */
export function streamObject(key: string, baseDir = env.MEDIA_STORAGE_DIR): NodeJS.ReadableStream {
  validateKey(key);
  return createReadStream(path.resolve(baseDir, key));
}