import { env } from '../env';

/**
 * Structured logger.
 *
 * Every record is a single JSON line on stdout, which is what container hosts
 * (Docker, systemd journal, Kubernetes) collect — that is the "centralised
 * logging" story without running a log shipper inside the app. A bounded
 * in-process ring buffer keeps the most recent records so an admin can inspect
 * recent errors without shell access to the host; it is deliberately small and
 * cleared on restart.
 *
 * Levels are filtered by the configured level. Anything below the level is
 * dropped before it is buffered, so the buffer never fills with debug noise.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  traceId?: string;
  [key: string]: unknown;
}

const RING_CAPACITY = 200;
const ring: LogRecord[] = [];

/** Values whose keys look secret are redacted before a record leaves the app. */
const REDACT_KEYS =
  /(password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|recovery[_-]?code)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[env.OBS_LOG_LEVEL];
}

function write(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return;
  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(redact(fields) as Record<string, unknown>),
  };
  if (ring.length >= RING_CAPACITY) ring.shift();
  ring.push(record);

  const line = env.OBS_LOG_FORMAT === 'pretty' ? formatPretty(record) : JSON.stringify(record);
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line);
}

function formatPretty(record: LogRecord): string {
  const { time, level, msg, ...rest } = record;
  const parts = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${parts ? ' ' + parts : ''}`;
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

/**
 * Recent records, newest last. Optional filters keep the admin surface useful
 * without exposing everything in the buffer.
 */
export function recentLogs(filter: { level?: LogLevel; limit?: number } = {}): LogRecord[] {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), RING_CAPACITY);
  const matching = filter.level
    ? ring.filter((record) => record.level === filter.level)
    : [...ring];
  return matching.slice(-limit);
}

/** Test-only: clear the buffer so records do not leak between suites. */
export function clearRecentLogs(): void {
  ring.length = 0;
}