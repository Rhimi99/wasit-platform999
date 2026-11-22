import { describe, it, expect } from 'vitest';
import {
  buildDisputeSummary,
  buildDisputeTriage,
  buildResolutionPaths,
  computeDeadlines,
  financialEffectFor,
  type DisputeFacts,
  type DisputePolicySnapshot,
} from '../../src/modules/ai/dispute-summary.js';

/**
 * The dispute assistant's reasoning, tested without a database.
 *
 * These cases pin the things that make the agent honest: it never decides, it
 * never invents a money effect the policy does not name, its deadlines come from
 * the policy, and its recommendation follows the facts rather than a fixed
 * sentence.
 */

const NOW = new Date('2026-11-20T12:00:00.000Z');

const policy: DisputePolicySnapshot = {
  rules: {
    responseWindowDays: 7,
    evidenceDeadlineDays: 14,
    decisionDeadlineDays: 30,
    decisionEffects: {
      IN_FAVOR_OF_BUYER: { effect: 'REFUND_BUYER' },
      IN_FAVOR_OF_SELLER: { effect: 'NONE' },
      REJECTED: { effect: 'NONE' },
    },
  },
  source: 'GLOBAL',
  countryCode: null,
  policyId: 'policy-1',
  version: 3,
  capturedAt: NOW.toISOString(),
};

function facts(over: Partial<DisputeFacts> = {}): DisputeFacts {
  const createdAt = new Date('2026-11-18T12:00:00.000Z');
  return {
    dispute: {
      id: 'd-1',
      disputeNumber: 'DSP-1',
      status: 'OPEN',
      reasonCode: 'NOT_DELIVERED',
      description: 'المنتج لم يصلني رغم أن الطلب مدفوع ومؤكد منذ أسبوعين كاملين.',
      decision: 'NONE',
      assignedToId: null,
      appealAllowed: true,
      openedById: 'buyer-1',
      createdAt,
      decidedAt: null,
    },
    order: {
      id: 'o-1',
      orderNumber: 'ORD-1',
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      refundStatus: 'NONE',
      grandTotal: 250,
      currencyCode: 'TND',
      createdAt,
    },
    messages: [],
    evidence: [],
    events: [],
    appeals: [],
    policy,
    parties: { buyerId: 'buyer-1', sellerId: 'seller-1' },
    now: NOW,
    ...over,
  };
}

describe('dispute deadlines come from the policy', () => {
  it('computes the three deadlines from the rule values', () => {
    const d = computeDeadlines(new Date('2026-11-01T00:00:00.000Z'), policy.rules, NOW, 'OPEN');
    expect(d.responseDueAt).toBe('2026-11-08T00:00:00.000Z');
    expect(d.evidenceDueAt).toBe('2026-11-15T00:00:00.000Z');
    expect(d.decisionDueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(d.responseOverdue).toBe(true);
    expect(d.evidenceOverdue).toBe(true);
    expect(d.decisionOverdue).toBe(false);
  });

  it('invents no deadline when the policy sets none', () => {
    const d = computeDeadlines(new Date('2026-11-01T00:00:00.000Z'), {}, NOW, 'OPEN');
    expect(d.responseDueAt).toBeNull();
    expect(d.decisionOverdue).toBe(false);
  });

  it('stops counting overdue once the dispute is terminal', () => {
    const d = computeDeadlines(new Date('2026-01-01T00:00:00.000Z'), policy.rules, NOW, 'DECIDED');
    expect(d.decisionOverdue).toBe(false);
    expect(d.responseOverdue).toBe(false);
  });
});

describe('financial effects are policy values, never guesses', () => {
  it('reads the named effect', () => {
    expect(financialEffectFor(policy, 'IN_FAVOR_OF_BUYER')).toBe('REFUND_BUYER');
    expect(financialEffectFor(policy, 'IN_FAVOR_OF_SELLER')).toBe('NONE');
  });

  it('reports null for a decision the policy does not name (SPLIT)', () => {
    expect(financialEffectFor(policy, 'SPLIT')).toBeNull();
    const paths = buildResolutionPaths(facts());
    const split = paths.find((p) => p.decision === 'SPLIT')!;
    expect(split.available).toBe(false);
    expect(split.financialEffect).toBeNull();
    expect(split.rationale).toContain('DECISION_REQUIRED');
  });

  it('marks the paths the policy does name as available', () => {
    const paths = buildResolutionPaths(facts());
    expect(paths.filter((p) => p.available).map((p) => p.decision)).toEqual([
      'IN_FAVOR_OF_BUYER',
      'IN_FAVOR_OF_SELLER',
      'REJECTED',
    ]);
  });
});

describe('gaps reflect the actual record', () => {
  it('flags an unassigned dispute, missing evidence and a short description', () => {
    const summary = buildDisputeSummary(
      facts({
        dispute: { ...facts().dispute, description: 'لم يصل' },
      }),
    );
    const codes = summary.gaps.map((g) => g.code);
    expect(codes).toContain('UNASSIGNED');
    expect(codes).toContain('NO_EVIDENCE');
    expect(codes).toContain('SHORT_DESCRIPTION');
    expect(codes).toContain('NO_SELLER_RESPONSE');
  });

  it('does not claim the seller is silent when the order has no single seller', () => {
    const summary = buildDisputeSummary(facts({ parties: { buyerId: 'buyer-1', sellerId: null } }));
    expect(summary.gaps.map((g) => g.code)).not.toContain('NO_SELLER_RESPONSE');
  });

  it('clears the evidence gap once the buyer attaches evidence', () => {
    const summary = buildDisputeSummary(
      facts({
        evidence: [
          { uploadedById: 'buyer-1', description: 'صورة الطرد', contentType: 'image/jpeg', createdAt: NOW },
        ],
      }),
    );
    expect(summary.gaps.map((g) => g.code)).not.toContain('NO_EVIDENCE');
  });

  it('reports POLICY_UNAVAILABLE instead of inventing deadlines', () => {
    const summary = buildDisputeSummary(facts({ policy: null }));
    expect(summary.gaps.map((g) => g.code)).toContain('POLICY_UNAVAILABLE');
    expect(summary.deadlines.decisionDueAt).toBeNull();
    expect(summary.recommendation.action).toBe('REQUEST_POLICY');
  });

  it('flags a decision that passed its policy deadline', () => {
    const old = new Date('2026-09-01T00:00:00.000Z');
    const summary = buildDisputeSummary(
      facts({ dispute: { ...facts().dispute, createdAt: old } }),
    );
    expect(summary.gaps.map((g) => g.code)).toContain('DECISION_OVERDUE');
  });
});

describe('recommendation follows the facts', () => {
  it('asks for evidence while the evidence window is open', () => {
    const summary = buildDisputeSummary(facts());
    expect(summary.recommendation.action).toBe('REQUEST_FURTHER_EVIDENCE');
    expect(summary.recommendation.confidence).toBeLessThanOrEqual(0.85);
  });

  it('escalates when the seller never answered past the response deadline', () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const summary = buildDisputeSummary(
      facts({
        dispute: { ...facts().dispute, createdAt },
        evidence: [
          { uploadedById: 'buyer-1', description: 'صورة', contentType: 'image/png', createdAt: createdAt },
        ],
      }),
    );
    expect(summary.recommendation.action).toBe('ESCALATE_FOR_NON_RESPONSE');
    expect(summary.recommendation.basis).toContain('RESPONSE_OVERDUE');
  });

  it('supports the buyer when the order is paid and evidence exists', () => {
    const summary = buildDisputeSummary(
      facts({
        evidence: [
          { uploadedById: 'buyer-1', description: 'صورة', contentType: 'image/png', createdAt: NOW },
        ],
        messages: [
          { senderId: 'seller-1', body: 'تم الشحن', isEvidence: false, createdAt: NOW },
        ],
      }),
    );
    expect(summary.recommendation.action).toBe('IN_FAVOR_OF_BUYER');
    expect(summary.recommendation.basis).toContain('ORDER_PAID');
  });

  it('supports the seller when the evidence deadline passed with no evidence', () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const summary = buildDisputeSummary(
      facts({
        dispute: { ...facts().dispute, createdAt },
        messages: [{ senderId: 'seller-1', body: 'الطلب مسلَّم', isEvidence: false, createdAt }],
      }),
    );
    expect(summary.recommendation.action).toBe('IN_FAVOR_OF_SELLER');
    expect(summary.recommendation.basis).toContain('EVIDENCE_DEADLINE_PASSED');
  });

  it('never claims certainty and never claims the decision', () => {
    const summary = buildDisputeSummary(facts());
    expect(summary.decisionAuthority).toBe('HUMAN');
    expect(summary.readOnly).toBe(true);
    expect(summary.recommendation.confidence).toBeLessThan(1);
  });
});

describe('summary content', () => {
  it('counts messages by party and keeps only the last ten excerpts', () => {
    const messages = Array.from({ length: 14 }, (_, i) => ({
      senderId: i % 2 === 0 ? 'buyer-1' : 'seller-1',
      body: `رسالة ${i}`,
      isEvidence: i === 0,
      createdAt: new Date(NOW.getTime() + i * 1000),
    }));
    const summary = buildDisputeSummary(facts({ messages }));
    expect(summary.conversation.messages).toBe(14);
    expect(summary.conversation.buyerMessages).toBe(7);
    expect(summary.conversation.sellerMessages).toBe(7);
    expect(summary.conversation.evidenceMessages).toBe(1);
    expect(summary.conversation.recent).toHaveLength(10);
    expect(summary.conversation.recent[0]!.excerpt).toBe('رسالة 4');
  });

  it('reports the disputed amount from the order, not from the dispute text', () => {
    const summary = buildDisputeSummary(facts());
    expect(summary.order?.grandTotal).toBe(250);
    expect(summary.order?.currencyCode).toBe('TND');
  });

  it('is deterministic for the same facts', () => {
    const a = JSON.stringify(buildDisputeSummary(facts()));
    const b = JSON.stringify(buildDisputeSummary(facts()));
    expect(a).toBe(b);
  });
});

describe('triage mode', () => {
  const rows = [
    {
      id: 'd-1',
      disputeNumber: 'DSP-1',
      status: 'OPEN',
      reasonCode: 'NOT_DELIVERED',
      assignedToId: null,
      createdAt: new Date('2026-11-19T12:00:00.000Z'),
      decisionDueAt: null,
    },
    {
      id: 'd-2',
      disputeNumber: 'DSP-2',
      status: 'UNDER_REVIEW',
      reasonCode: 'DAMAGED',
      assignedToId: 'admin-1',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      decisionDueAt: new Date('2026-10-31T00:00:00.000Z'),
    },
    {
      id: 'd-3',
      disputeNumber: 'DSP-3',
      status: 'DECIDED',
      reasonCode: 'OTHER',
      assignedToId: 'admin-1',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      decisionDueAt: new Date('2026-10-01T00:00:00.000Z'),
    },
  ];

  it('counts open, unassigned and overdue without listing terminal disputes', () => {
    const triage = buildDisputeTriage(rows, { OPEN: 1, UNDER_REVIEW: 1, DECIDED: 1 }, NOW);
    expect(triage.counts.open).toBe(2);
    expect(triage.counts.unassigned).toBe(1);
    expect(triage.counts.decisionOverdue).toBe(1);
    expect(triage.openDisputes.map((d) => d.id)).toEqual(['d-1', 'd-2']);
    expect(triage.openDisputes[1]!.decisionOverdue).toBe(true);
  });

  it('carries no message bodies at all', () => {
    const triage = buildDisputeTriage(rows, { OPEN: 1 }, NOW);
    expect(JSON.stringify(triage)).not.toContain('excerpt');
    expect(triage.readOnly).toBe(true);
    expect(triage.decisionAuthority).toBe('HUMAN');
  });

  it('recommends assigning a reviewer when work is unassigned', () => {
    const triage = buildDisputeTriage(rows, {}, NOW);
    expect(triage.recommendation.action).toBe('ASSIGN_REVIEWER');
    expect(triage.oldestOpenHours).toBeGreaterThan(0);
  });

  it('handles an empty queue honestly', () => {
    const triage = buildDisputeTriage([], {}, NOW);
    expect(triage.counts.open).toBe(0);
    expect(triage.oldestOpenHours).toBeNull();
    expect(triage.recommendation.confidence).toBeLessThan(0.5);
  });
});
