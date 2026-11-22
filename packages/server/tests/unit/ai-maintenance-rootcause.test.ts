import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyseFailures,
  buildReviewReport,
  classifyFamily,
  clusterFailures,
  classifyFailure,
  errorMessage,
  failureSignature,
  proposePatch,
  type FailureSample,
} from '../../src/modules/ai/diagnostics.js';

/**
 * Platform Maintenance & Repair — root-cause analysis.
 *
 * Pure functions over rows, so these tests need no database. They pin the two
 * things that can quietly go wrong in a diagnosis: a signature that does not
 * actually collapse equal causes, and a patch proposal that points at a file
 * which does not exist in this repository.
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sample(overrides: Partial<FailureSample> & { message?: string } = {}): FailureSample {
  const { message, ...rest } = overrides;
  return {
    taskId: rest.taskId ?? 'task-1',
    agentKey: rest.agentKey ?? 'sales-agent',
    taskType: rest.taskType ?? 'sales_analysis',
    error: rest.error ?? { message: message ?? 'something failed' },
    createdAt: rest.createdAt ?? new Date('2026-11-20T10:00:00Z'),
  };
}

describe('failure classification', () => {
  it('reads the message out of every shape the task error is written in', () => {
    expect(errorMessage({ message: 'boom' })).toBe('boom');
    expect(errorMessage({ error: { message: 'nested boom' } })).toBe('nested boom');
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(null)).toBe('');
    expect(errorMessage({ taskId: 't1', taskStatus: 'failed', error: { message: 'deep' } })).toBe('deep');
  });

  it('maps each known cause to its family', () => {
    const cases: Array<[string, string]> = [
      ['Insufficient stock for product 7', 'INSUFFICIENT_STOCK'],
      ['Too Many Requests from principal', 'RATE_LIMIT'],
      ['AI budget exceeded for this period', 'BUDGET'],
      ['Upstream timed out after 30s', 'TIMEOUT'],
      ['Agent tried to read table users outside its scope', 'SCOPE_VIOLATION'],
      ['Task is awaiting_approval', 'APPROVAL'],
      ['Validation failed on field windowDays', 'VALIDATION'],
      ['Unauthorized: session expired', 'AUTH'],
      ['Provider anthropic returned 500', 'PROVIDER'],
      ['Category not found', 'NOT_FOUND'],
      ['Duplicate key value violates unique constraint', 'CONFLICT'],
      ['کلام غیر معروف qwerty', 'UNKNOWN'],
    ];
    for (const [message, family] of cases) {
      expect(classifyFamily(message), message).toBe(family);
    }
  });

  it('collapses identifiers, emails and numbers so equal causes share a signature', () => {
    const a = failureSignature('Insufficient stock for product 550e8400-e29b-41d4-a716-446655440000 (qty 3)');
    const b = failureSignature('Insufficient stock for product 123e4567-e89b-12d3-a456-426614174000 (qty 12)');
    expect(a).toBe(b);
    expect(a).not.toMatch(/[0-9a-f]{8}-/);

    const c = failureSignature('user ali@example.com failed');
    const d = failureSignature('user sami@wasit.tn failed');
    expect(c).toBe(d);
  });

  it('never returns an empty signature', () => {
    expect(failureSignature('')).toBe('(empty error)');
    expect(failureSignature('   ')).toBe('(empty error)');
  });
});

describe('clustering', () => {
  it('groups by signature, ranks by frequency, and sets confidence from evidence', () => {
    const rows = [
      sample({ taskId: 't1', message: 'Insufficient stock for product 111' }),
      sample({ taskId: 't2', message: 'Insufficient stock for product 222' }),
      sample({ taskId: 't3', message: 'Insufficient stock for product 333' }),
      sample({ taskId: 't4', message: 'Upstream timed out after 30s' }),
    ].map(classifyFailure);

    const clusters = clusterFailures(rows);
    expect(clusters.length).toBe(2);

    const [dominant, second] = clusters;
    expect(dominant!.family).toBe('INSUFFICIENT_STOCK');
    expect(dominant!.occurrences).toBe(3);
    expect(dominant!.share).toBe(0.75);
    expect(dominant!.confidence).toBe('high');
    expect(dominant!.agents).toEqual(['sales-agent']);
    expect(dominant!.taskTypes).toEqual(['sales_analysis']);
    expect(dominant!.samples.length).toBe(3);

    expect(second!.family).toBe('TIMEOUT');
    expect(second!.occurrences).toBe(1);
    expect(second!.confidence).toBe('low');
  });

  it('never asserts a cause for an unknown family', () => {
    const clusters = clusterFailures([
      classifyFailure(sample({ message: 'strange thing happened' })),
      classifyFailure(sample({ taskId: 't2', message: 'strange thing happened' })),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.family).toBe('UNKNOWN');
    expect(clusters[0]!.confidence).toBe('low');
    expect(proposePatch(clusters[0]!)).toMatchObject({
      area: 'undetermined',
      likelyFiles: [],
      changeType: 'investigation',
    });
  });

  it('collects every agent and task type that shares a cause', () => {
    const rows = [
      classifyFailure(sample({ taskId: 'a', agentKey: 'sales-agent', taskType: 'sales_analysis', message: 'budget exceeded' })),
      classifyFailure(sample({ taskId: 'b', agentKey: 'ads-agent', taskType: 'ads_review', message: 'budget exceeded' })),
    ];
    const clusters = clusterFailures(rows);
    expect(clusters[0]!.agents).toEqual(['ads-agent', 'sales-agent']);
    expect(clusters[0]!.taskTypes).toEqual(['ads_review', 'sales_analysis']);
    expect(clusters[0]!.confidence).toBe('medium');
  });
});

describe('patch proposals', () => {
  const rows = [
    sample({ taskId: 't1', message: 'Insufficient stock for product 111' }),
    sample({ taskId: 't2', message: 'Insufficient stock for product 222' }),
    sample({ taskId: 't3', message: 'Insufficient stock for product 333' }),
  ];
  const analysis = analyseFailures(rows, { days: 7, from: '2026-11-13T00:00:00Z', to: '2026-11-20T00:00:00Z' });

  it('proposes a patch that always waits for the GM', () => {
    const proposal = proposePatch(analysis.clusters[0]!);
    expect(proposal.requiresGmApproval).toBe(true);
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.changeType).toBe('behaviour');
    expect(proposal.testsToAdd.length).toBeGreaterThan(0);
    expect(proposal.rollback.length).toBeGreaterThan(0);
  });

  it('only points at files that exist in this repository', () => {
    const families = [
      'Insufficient stock for product 1',
      'Too many requests',
      'budget exceeded',
      'timed out',
      'outside its scope',
      'awaiting approval',
      'validation failed',
      'unauthorized',
      'provider error',
      'not found',
      'duplicate key',
    ];
    const clusters = clusterFailures(
      families.map((message, index) => classifyFailure(sample({ taskId: `f${index}`, message }))),
    );
    for (const cluster of clusters) {
      const proposal = proposePatch(cluster);
      for (const file of proposal.likelyFiles) {
        expect(existsSync(resolve(PKG_ROOT, file)), `${cluster.family} → ${file}`).toBe(true);
      }
    }
  });

  it('keeps the highest-risk areas behind an explicit approval and never auto-applies them', () => {
    const scope = clusterFailures([classifyFailure(sample({ message: 'read table users outside its scope' }))])[0]!;
    const proposal = proposePatch(scope);
    expect(proposal.riskClass).toBe('high');
    expect(proposal.requiresGmApproval).toBe(true);
  });
});

describe('review report', () => {
  it('states each step of the repair chain, including the ones it cannot do', () => {
    const analysis = analyseFailures(
      [
        sample({ taskId: 't1', message: 'Insufficient stock for product 111' }),
        sample({ taskId: 't2', message: 'Insufficient stock for product 222' }),
      ],
      { days: 7, from: '2026-11-13T00:00:00Z', to: '2026-11-20T00:00:00Z' },
    );
    const report = buildReviewReport(analysis, analysis.clusters.map(proposePatch));

    const state = (step: string) => report.checklist.find((s) => s.step === step)?.state;
    expect(state('diagnose')).toBe('done');
    expect(state('root_cause')).toBe('done');
    expect(state('patch_proposal')).toBe('done');
    expect(state('review_report')).toBe('done');
    expect(state('isolated_tests')).toBe('blocked');
    expect(state('apply_patch')).toBe('pending_approval');

    expect(report.appliesChanges).toBe(false);
    expect(report.approvalsRequired).toEqual(['code.apply_patch', 'code.merge']);
    expect(report.summary).toContain('INSUFFICIENT_STOCK');
  });

  it('says there is nothing to repair when the window is empty', () => {
    const analysis = analyseFailures([], { days: 7, from: '2026-11-13T00:00:00Z', to: '2026-11-20T00:00:00Z' });
    expect(analysis.dominant).toBeNull();
    expect(analysis.sampleSize).toBe(0);

    const report = buildReviewReport(analysis, []);
    expect(report.summary).toContain('nothing to repair');
    expect(report.checklist.find((s) => s.step === 'patch_proposal')?.state).toBe('blocked');
  });
});
