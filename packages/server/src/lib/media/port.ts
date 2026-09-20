/**
 * Media storage port — the only surface the media service depends on.
 *
 * Assets are written to **private** storage and are never exposed as static
 * files. A concrete driver (local FS today, an object store later) implements
 * this interface; nothing driver-specific may leak beyond this directory.
 */
export interface PutObjectInput {
  /** Opaque, storage-safe key (no user text, no path separators). */
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

export interface MediaStorage {
  readonly id: string;
  /** Whether the driver is usable right now (base dir exists/writable). */
  isAvailable(): Promise<boolean>;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  /** Partial read used by HTTP Range requests for in-platform video preview. */
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  /** Byte size of a stored object, or null when it does not exist. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}