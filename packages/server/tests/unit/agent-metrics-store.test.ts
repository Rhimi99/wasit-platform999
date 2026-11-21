import { describe, it, expect } from 'vitest';
import { metricEventId, METRIC_OUTCOMES } from '../../src/modules/ai/metrics.js';

/**
 * AI-MET-01 — the identity rules that make the metric log idempotent.
 *
 * These are pure functions: the point is that the same settled event always
 * produces the same row id (so a duplicate write is absorbed by the primary
 * key), while a genuine retry or a different outcome stays a distinct event.
 */
describe('AI-MET-01 — metric event identity', () => {
  it('is deterministic for the same event', () => {
    const parts = { agentKey: 'sales-agent', taskId: 'task-1', attempt: 1, outcome: 'succeeded' };
    expect(metricEventId(parts)).toBe(metricEventId({ ...parts }));
  });

  it('is a 36-character UUID-shaped id (fits the varchar(36) primary key)', () => {
    const id = metricEventId({ agentKey: 'sales-agent', taskId: 'task-1', attempt: 1, outcome: 'failed' });
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('separates a retry from the original attempt', () => {
    const base = { agentKey: 'sales-agent', taskId: 'task-1', outcome: 'failed' };
    expect(metricEventId({ ...base, attempt: 1 })).not.toBe(metricEventId({ ...base, attempt: 2 }));
  });

  it('separates agents and tasks that happen to share a suffix', () => {
    expect(metricEventId({ agentKey: 'a', taskId: 'b|c', attempt: 1, outcome: 'failed' })).not.toBe(
      metricEventId({ agentKey: 'a|b', taskId: 'c', attempt: 1, outcome: 'failed' }),
    );
  });

  it('keeps different outcomes of one attempt distinct (no event is lost)', () => {
    const base = { agentKey: 'sales-agent', taskId: 'task-1', attempt: 1 };
    const ids = METRIC_OUTCOMES.map((outcome) => metricEventId({ ...base, outcome }));
    expect(new Set(ids).size).toBe(METRIC_OUTCOMES.length);
  });

  it('declares exactly the four settled outcomes the schema documents', () => {
    expect([...METRIC_OUTCOMES]).toEqual(['succeeded', 'failed', 'rejected', 'blocked']);
  });
});
