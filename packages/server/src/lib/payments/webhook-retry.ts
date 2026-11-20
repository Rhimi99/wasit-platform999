import { ApiError } from '@wasit/shared';

/**
 * OBS-01 — webhook failure classification and the bounded retry policy.
 *
 * The provider is the retry driver: WASIT never re-applies a financial side
 * effect on its own timer. A delivery may only retry a previously failed event
 * once its backoff slot has elapsed, and only while the attempt budget lasts.
 * Everything here is pure so the policy can be unit-tested without a database.
 */

/**
 * Why an apply attempt failed, and therefore whether retrying can ever help.
 *
 * - `TRANSIENT`  the target is not ready yet (intent/order missing) or the
 *                dependency is momentarily unavailable — a later delivery may
 *                succeed.
 * - `PERMANENT`  the event itself is malformed or was rejected — the same
 *                payload will be rejected again, so retrying is pointless.
 * - `CONFLICT`   the money state disagrees with the event (amount mismatch,
 *                missing transaction). Retrying the same payload cannot fix it;
 *                a human must look.
 * - `CAPABILITY` the provider cannot assert this kind of evidence at all.
 * - `STALE`      the event arrived too late and would move money backwards. It
 *                is acknowledged, recorded and never applied.
 */
export type WebhookFailureClass = 'TRANSIENT' | 'PERMANENT' | 'CONFLICT' | 'CAPABILITY' | 'STALE';

export interface WebhookRetryPolicy {
  /** Attempts allowed before the event is dead-lettered. Never unbounded. */
  maxAttempts: number;
  /** Delay before the second attempt. */
  baseDelayMs: number;
  /** Ceiling for the exponential growth. */
  maxDelayMs: number;
  /** Multiplier applied per attempt. */
  factor: number;
  /** How long a processing claim is exclusive before another delivery may take it over. */
  claimLeaseMs: number;
  /** Operator replays allowed for one dead-lettered event. */
  maxReplays: number;
}

export const DEFAULT_WEBHOOK_RETRY_POLICY: WebhookRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60 * 1000,
  factor: 2,
  claimLeaseMs: 60_000,
  maxReplays: 3,
};

export interface WebhookFailureDescription {
  failureClass: WebhookFailureClass;
  /** False means the attempt budget is spent: dead-letter on this attempt. */
  retryable: boolean;
  code: string;
  message: string;
}

/**
 * Classifies an apply error. The default for an unrecognised error is
 * `TRANSIENT`: a database or network hiccup is far more likely than a permanent
 * defect, and the attempt budget still bounds it.
 */
export function classifyWebhookFailure(err: unknown): WebhookFailureDescription {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof ApiError) {
    // Settlement evidence is a provider capability, not a payload problem.
    // The reason is carried in the field errors, not in the generic message.
    const haystack = [err.message, ...(err.fieldErrors ?? []).map((f) => f.message)].join(' | ');
    if (/cannot assert settlement/i.test(haystack)) {
      return { failureClass: 'CAPABILITY', retryable: false, code: err.code, message };
    }

    switch (err.code) {
      case 'SERVICE_UNAVAILABLE':
      case 'RATE_LIMITED':
        return { failureClass: 'TRANSIENT', retryable: true, code: err.code, message };
      // The provider may deliver before the intent or the order row exists.
      case 'NOT_FOUND':
        return { failureClass: 'TRANSIENT', retryable: true, code: err.code, message };
      case 'CONFLICT':
      case 'INVALID_OPERATION':
        return { failureClass: 'CONFLICT', retryable: false, code: err.code, message };
      case 'VALIDATION_ERROR':
      case 'VALIDATION_FAILED':
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
      case 'PAYMENT_REQUIRED':
        return { failureClass: 'PERMANENT', retryable: false, code: err.code, message };
      default:
        return err.statusCode >= 500
          ? { failureClass: 'TRANSIENT', retryable: true, code: err.code, message }
          : { failureClass: 'PERMANENT', retryable: false, code: err.code, message };
    }
  }

  return { failureClass: 'TRANSIENT', retryable: true, code: 'UNKNOWN_ERROR', message };
}

/**
 * Exponential backoff: `base * factor^(attempt-1)`, capped at `maxDelayMs`.
 * `attempt` is the number of the attempt that just failed (1-based).
 */
export function computeBackoffMs(attempt: number, policy: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY_POLICY): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.max(0, policy.baseDelayMs);
  const factor = Math.max(1, policy.factor);
  // `**` can overflow to Infinity for a large attempt; the cap handles it.
  const raw = base * factor ** (n - 1);
  return Math.min(Math.round(raw), Math.max(0, policy.maxDelayMs));
}

export function computeNextAttemptAt(
  now: Date,
  attempt: number,
  policy: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY_POLICY,
): Date {
  return new Date(now.getTime() + computeBackoffMs(attempt, policy));
}

/** A failed event may be retried only once its backoff slot has elapsed. */
export function isRetryDue(nextAttemptAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!nextAttemptAt) return true;
  return nextAttemptAt.getTime() <= now.getTime();
}

/** The attempt budget is spent when the cap is reached or the failure is not retryable. */
export function shouldDeadLetter(attempts: number, retryable: boolean, policy: WebhookRetryPolicy = DEFAULT_WEBHOOK_RETRY_POLICY): boolean {
  return !retryable || attempts >= Math.max(1, policy.maxAttempts);
}
