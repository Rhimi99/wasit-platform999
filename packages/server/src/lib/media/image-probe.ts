/**
 * Image sniffing and dimension probing.
 *
 * Uploads are judged by their bytes, never by the client's filename or
 * declared content type: a `.png` that is really HTML, an SVG carrying script,
 * or a PE executable must all be refused. Only three raster formats are
 * accepted (JPEG, PNG, WebP) and the stored extension is derived from the
 * sniffed type, so the uploaded name never reaches the filesystem.
 */

export const SUPPORTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];

export const IMAGE_EXTENSIONS: Record<SupportedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** A 40 MP ceiling: above this a resize would cost more than it is worth. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Sanity bound on a single side, so absurd headers cannot reach the decoder. */
export const MAX_IMAGE_DIMENSION = 20_000;

export interface ImageProbe {
  mimeType: SupportedImageMime;
  extension: string;
  width: number;
  height: number;
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * Identifies a raster image from its magic bytes.
 *
 * Returns null for anything else — including SVG and HTML, which are the two
 * most common ways to smuggle script through an "image" upload.
 */
export function sniffImageType(buf: Buffer): SupportedImageMime | null {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  // IHDR must be the first chunk: length(4) type(4) width(4) height(4).
  if (buf.length < 24 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    if (buf.length < 30) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf.length < 25) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Reads the declared dimensions out of the image header.
 *
 * A file whose header cannot be parsed is not a usable image: the upload is
 * refused rather than stored as an unrenderable blob.
 */
export function probeImage(buf: Buffer): ImageProbe | null {
  const mimeType = sniffImageType(buf);
  if (!mimeType) return null;

  const size =
    mimeType === 'image/png' ? pngSize(buf) : mimeType === 'image/jpeg' ? jpegSize(buf) : webpSize(buf);
  if (!size) return null;

  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1) return null;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return null;
  if (width * height > MAX_IMAGE_PIXELS) return null;

  return { mimeType, extension: IMAGE_EXTENSIONS[mimeType], width, height };
}

/** True when a filename tries to smuggle a path segment. */
export function hasPathTraversal(filename: string): boolean {
  return filename.includes('/') || filename.includes('\\') || filename.includes('\0') || filename.includes('..');
}
