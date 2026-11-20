import { describe, it, expect } from 'vitest';
import { ApiError } from '@wasit/shared';
import {
  DEFAULT_WEBHOOK_RETRY_POLICY,
  classifyWebhookFailure,
  computeBackoffMs,
  computeNextAttemptAt,
  isRetryDue,
  shouldDeadLetter,
} from '../../src/lib/payments/webhook-retry.js';

/**
 * OBS-01 — the retry policy is pure, so its bounds and its classification are
 * pinned here without a database.
 */
describe('OBS-01 — webhook failure classification', () => {
  it('treats a missing target as TRANSIENT and retryable', () => {
    const d = classifyWebhookFailure(ApiError.notFound('Payment intent'));
    expect(d.failureClass).toBe('TRANSIENT');
    expect(d.retryable).toBe(true);
    expect(d.code).toBe('NOT_FOUND');
  });

  it('treats a provider outage and a throttle as TRANSIENT', () => {
    expect(classifyWebhookFailure(ApiError.serviceUnavailable('down')).failureClass).toBe('TRANSIENT');
    expect(classifyWebhookFailure(ApiError.serviceUnavailable('down')).retryable).toBe(true);
    const limited = new ApiError(429, 'RATE_LIMITED', 'slow down');
    expect(classifyWebhookFailure(limited).failureClass).toBe('TRANSIENT');
    expect(classifyWebhookFailure(limited).retryable).toBe(true);
  });

  it('treats a state conflict as non-retryable (a human must look)', () => {
    const d = classifyWebhookFailure(ApiError.conflict('Payment intent has no transaction'));
    expect(d.failureClass).toBe('CONFLICT');
    expect(d.retryable).toBe(false);
  });

  it('treats a malformed or rejected payload as PERMANENT', () => {
    const d = classifyWebhookFailure(ApiError.validation([{ field: 'type', message: 'bad', code: 'VALIDATION_FAILED' }]));
    expect(d.failureClass).toBe('PERMANENT');
    expect(d.retryable).toBe(false);
  });

  it('treats a settlement-capability claim as CAPABILITY, not retryable', () => {
    const d = classifyWebhookFailure(
      ApiError.validation([{ field: 'type', message: "Provider 'manual' cannot assert settlement", code: 'VALIDATION_FAILED' }]),
    );
    expect(d.failureClass).toBe('CAPABILITY');
    expect(d.retryable).toBe(false);
  });

  it('defaults an unknown error to TRANSIENT — infrastructure hiccups are retryable', () => {
    const d = classifyWebhookFailure(new Error('connection terminated unexpectedly'));
    expect(d.failureClass).toBe('TRANSIENT');
    expect(d.retryable).toBe(true);
    expect(d.code).toBe('UNKNOWN_ERROR');
  });

  it('classifies a 5xx ApiError as TRANSIENT and a 4xx (other) as PERMANENT', () => {
    expect(classifyWebhookFailure(new ApiError(502, 'INTERNAL_ERROR', 'bad gateway')).failureClass).toBe('TRANSIENT');
    expect(classifyWebhookFailure(new ApiError(400, 'INTERNAL_ERROR', 'bad request')).failureClass).toBe('PERMANENT');
  });
});

describe('OBS-01 — exponential backoff and bounded attempts', () => {
  const policy = { ...DEFAULT_WEBHOOK_RETRY_POLICY, baseDelayMs: 1_000, maxDelayMs: 10_000, factor: 2 };

  it('grows the delay exponentially from the configured base', () => {
    expect(computeBackoffMs(1, policy)).toBe(1_000);
    expect(computeBackoffMs(2, policy)).toBe(2_000);
    expect(computeBackoffMs(3, policy)).toBe(4_000);
    expect(computeBackoffMs(4, policy)).toBe(8_000);
  });

  it('caps the delay so a long-lived event never waits unboundedly', () => {
    expect(computeBackoffMs(5, policy)).toBe(10_000);
    expect(computeBackoffMs(60, policy)).toBe(10_000);
  });

  it('treats attempt 0 and negative attempts as the first attempt', () => {
    expect(computeBackoffMs(0, policy)).toBe(1_000);
    expect(computeBackoffMs(-3, policy)).toBe(1_000);
  });

  it('computes the next attempt timestamp from the failure time', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    expect(computeNextAttemptAt(now, 2, policy).toISOString()).toBe('2026-11-20T10:00:02.000Z');
  });

  it('allows a retry only once the slot has elapsed', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    expect(isRetryDue(new Date('2026-11-20T09:59:59.000Z'), now)).toBe(true);
    expect(isRetryDue(new Date('2026-11-20T10:00:00.000Z'), now)).toBe(true);
    expect(isRetryDue(new Date('2026-11-20T10:00:01.000Z'), now)).toBe(false);
    expect(isRetryDue(null, now)).toBe(true);
  });

  it('dead-letters at the attempt cap and immediately for a non-retryable failure', () => {
    expect(shouldDeadLetter(4, true, policy)).toBe(false);
    expect(shouldDeadLetter(5, true, policy)).toBe(true);
    expect(shouldDeadLetter(1, false, policy)).toBe(true);
  });

  it('ships bounds that are finite and internally consistent', () => {
    const p = DEFAULT_WEBHOOK_RETRY_POLICY;
    expect(p.maxAttempts).toBeGreaterThan(0);
    expect(p.maxAttempts).toBeLessThanOrEqual(50);
    expect(p.maxDelayMs).toBeGreaterThanOrEqual(p.baseDelayMs);
    expect(p.factor).toBeGreaterThanOrEqual(1);
    expect(p.claimLeaseMs).toBeGreaterThan(0);
    expect(p.maxReplays).toBeGreaterThanOrEqual(0);
  });
});
