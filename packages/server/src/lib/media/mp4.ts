/**
 * Measures the real duration of an MP4 by reading its `moov/mvhd` header.
 *
 * This exists so the platform validates the **actual** rendered asset rather
 * than trusting the requested number. The renderer is local and deterministic,
 * but a provider swap (a future async vendor) must not be able to claim a
 * duration the bytes do not carry — every generated video is checked here
 * before it is persisted as READY.
 *
 * Only the ISO-BMFF boxes needed for the header are parsed; the media payload
 * is never decoded.
 */

/** Reads a 32-bit big-endian box size, promoting 64-bit (`size === 1`) boxes. */
function readBoxSize(buf: Buffer, offset: number): number | null {
  if (offset + 8 > buf.length) return null;
  const size = buf.readUInt32BE(offset);
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    const large = buf.readBigUInt64BE(offset + 8);
    // Durations here are far below Number.MAX_SAFE_INTEGER; a giant box is a
    // malformed file, not a real asset.
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(large);
  }
  // size === 0 means "extends to end of file".
  if (size === 0) return buf.length - offset;
  return size;
}

/** Parses the `mvhd` box inside `moov` and returns duration in seconds. */
function readMvhdDurationSeconds(buf: Buffer, moovStart: number, moovSize: number): number | null {
  const end = Math.min(moovStart + moovSize, buf.length);
  let p = moovStart + 8; // skip the `moov` box header itself
  while (p + 8 <= end) {
    const size = readBoxSize(buf, p);
    if (size === null || size < 8) return null;
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'mvhd') {
      const version = buf[p + 8];
      const base = p + 12; // version(1) + flags(3)
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (base + 28 > buf.length) return null;
        timescale = buf.readUInt32BE(base + 16);
        duration = Number(buf.readBigUInt64BE(base + 20));
      } else {
        if (base + 16 > buf.length) return null;
        timescale = buf.readUInt32BE(base + 8);
        duration = buf.readUInt32BE(base + 12);
      }
      if (!timescale || !Number.isFinite(duration)) return null;
      return duration / timescale;
    }
    p += size;
  }
  return null;
}

/**
 * Returns the measured duration in seconds, or `null` when it cannot be read
 * (not an MP4, truncated, or no `moov`). Callers must treat `null` as a
 * verification failure, never as a pass.
 */
export function measureMp4DurationSeconds(buf: Buffer): number | null {
  if (buf.length < 16 || buf.subarray(4, 8).toString('ascii') !== 'ftyp') return null;
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = readBoxSize(buf, offset);
    if (size === null || size < 8) return null;
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'moov') return readMvhdDurationSeconds(buf, offset, size);
    offset += size;
  }
  return null;
}
