/**
 * Deterministic dispute analysis for the `dispute-assistant` agent.
 *
 * The agent is advisory: this module turns facts that were already read from the
 * database into gaps, policy-derived resolution paths and a recommendation. It
 * never picks a decision — `decisionAuthority` is always HUMAN — and it never
 * invents a financial effect: a path whose effect is absent from the resolved
 * policy is reported as DECISION_REQUIRED instead of being guessed.
 *
 * Kept free of database access so the reasoning can be tested exhaustively.
 */

export interface DisputePolicySnapshot {
  rules: Record<string, unknown>;
  source: 'COUNTRY' | 'GLOBAL';
  countryCode: string | null;
  policyId: string | null;
  version: number | null;
  /** When the rules were read. The task carries this snapshot as immutable input. */
  capturedAt: string;
}

export interface DisputeFacts {
  dispute: {
    id: string;
    disputeNumber: string;
    status: string;
    reasonCode: string;
    description: string;
    decision: string;
    assignedToId: string | null;
    appealAllowed: boolean;
    openedById: string;
    createdAt: Date;
    decidedAt: Date | null;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    refundStatus: string;
    grandTotal: number;
    currencyCode: string;
    createdAt: Date;
  } | null;
  messages: { senderId: string; body: string; isEvidence: boolean; createdAt: Date }[];
  evidence: { uploadedById: string; description: string | null; contentType: string | null; createdAt: Date }[];
  events: { eventType: string; actorId: string | null; createdAt: Date }[];
  appeals: { status: string; appealedById: string; createdAt: Date }[];
  policy: DisputePolicySnapshot | null;
  /** Buyer and seller user ids, resolved by the caller from the order. */
  parties: { buyerId: string | null; sellerId: string | null };
  now: Date;
}

export type GapCode =
  | 'UNASSIGNED'
  | 'NO_EVIDENCE'
  | 'SHORT_DESCRIPTION'
  | 'NO_SELLER_RESPONSE'
  | 'EVIDENCE_DEADLINE_PASSED'
  | 'RESPONSE_OVERDUE'
  | 'DECISION_OVERDUE'
  | 'POLICY_UNAVAILABLE'
  | 'DECISION_EFFECT_UNSET';

export interface DisputeGap {
  code: GapCode;
  detail: string;
}

export type DecisionPath = 'IN_FAVOR_OF_BUYER' | 'IN_FAVOR_OF_SELLER' | 'SPLIT' | 'REJECTED';

export interface ResolutionPath {
  decision: DecisionPath;
  /** `NONE` means the policy explicitly moves no money; null means it names no effect. */
  financialEffect: string | null;
  available: boolean;
  rationale: string;
}

export interface Recommendation {
  action:
    | DecisionPath
    | 'REQUEST_FURTHER_EVIDENCE'
    | 'ESCALATE_FOR_NON_RESPONSE'
    | 'REQUEST_POLICY'
    | 'ASSIGN_REVIEWER'
    | 'REVIEW_OLDEST';
  rationale: string;
  /** 0..0.85 — a human decides; the agent never claims certainty. */
  confidence: number;
  basis: string[];
}

export interface DisputeDeadlines {
  responseDueAt: string | null;
  evidenceDueAt: string | null;
  decisionDueAt: string | null;
  responseOverdue: boolean;
  evidenceOverdue: boolean;
  decisionOverdue: boolean;
}

export interface DisputeSummary {
  mode: 'summary';
  dispute: {
    id: string;
    disputeNumber: string;
    status: string;
    reasonCode: string;
    description: string;
    decision: string;
    assignedToId: string | null;
    appealAllowed: boolean;
    openedById: string;
    createdAt: string;
    decidedAt: string | null;
    ageHours: number;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    refundStatus: string;
    grandTotal: number;
    currencyCode: string;
    createdAt: string;
  } | null;
  conversation: {
    messages: number;
    participants: string[];
    buyerMessages: number;
    sellerMessages: number;
    evidenceMessages: number;
    lastMessageAt: string | null;
    /** Excerpts from THIS dispute only — never another dispute's thread. */
    recent: { senderId: string; isEvidence: boolean; at: string; excerpt: string }[];
  };
  evidence: {
    count: number;
    items: { uploadedById: string; description: string | null; contentType: string | null; createdAt: string }[];
  };
  timeline: { at: string; type: string; actorId: string | null }[];
  appeals: { count: number; open: number };
  deadlines: DisputeDeadlines;
  policy: DisputePolicySnapshot | null;
  gaps: DisputeGap[];
  resolutionPaths: ResolutionPath[];
  recommendation: Recommendation;
  readOnly: true;
  decisionAuthority: 'HUMAN';
  generatedAt: string;
}

export interface TriageDispute {
  id: string;
  disputeNumber: string;
  status: string;
  reasonCode: string;
  assignedToId: string | null;
  createdAt: string;
  ageHours: number;
  decisionOverdue: boolean;
}

export interface DisputeTriage {
  mode: 'triage';
  counts: { byStatus: Record<string, number>; open: number; unassigned: number; decisionOverdue: number };
  openDisputes: TriageDispute[];
  oldestOpenHours: number | null;
  recommendation: Recommendation;
  readOnly: true;
  decisionAuthority: 'HUMAN';
  generatedAt: string;
}

const DECISION_PATHS: readonly DecisionPath[] = [
  'IN_FAVOR_OF_BUYER',
  'IN_FAVOR_OF_SELLER',
  'SPLIT',
  'REJECTED',
];

const TERMINAL_STATUSES = new Set(['DECIDED', 'CLOSED', 'ARCHIVED']);

export function policyNumber(policy: DisputePolicySnapshot | null, key: string): number | null {
  return ruleNumber(policy?.rules, key);
}

function ruleNumber(rules: Record<string, unknown> | undefined, key: string): number | null {
  const value = rules?.[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function hoursBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10);
}

export function computeDeadlines(
  createdAt: Date,
  rules: Record<string, unknown> | undefined,
  now: Date,
  status: string,
): DisputeDeadlines {
  const responseDays = ruleNumber(rules, 'responseWindowDays');
  const evidenceDays = ruleNumber(rules, 'evidenceDeadlineDays');
  const decisionDays = ruleNumber(rules, 'decisionDeadlineDays');
  const decided = TERMINAL_STATUSES.has(status);

  const responseDue = responseDays === null ? null : addDays(createdAt, responseDays);
  const evidenceDue = evidenceDays === null ? null : addDays(createdAt, evidenceDays);
  const decisionDue = decisionDays === null ? null : addDays(createdAt, decisionDays);

  return {
    responseDueAt: responseDue?.toISOString() ?? null,
    evidenceDueAt: evidenceDue?.toISOString() ?? null,
    decisionDueAt: decisionDue?.toISOString() ?? null,
    responseOverdue: responseDue !== null && !decided && now > responseDue,
    evidenceOverdue: evidenceDue !== null && !decided && now > evidenceDue,
    decisionOverdue: decisionDue !== null && !decided && now > decisionDue,
  };
}

function effectsOf(policy: DisputePolicySnapshot | null): Record<string, unknown> {
  const effects = policy?.rules?.decisionEffects;
  return effects && typeof effects === 'object' && !Array.isArray(effects)
    ? (effects as Record<string, unknown>)
    : {};
}

/** The money effect the policy names for a decision, or null when it names none. */
export function financialEffectFor(policy: DisputePolicySnapshot | null, decision: DecisionPath): string | null {
  const entry = effectsOf(policy)[decision];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const effect = (entry as Record<string, unknown>).effect;
  return typeof effect === 'string' && effect.length > 0 ? effect : null;
}

export function buildResolutionPaths(facts: DisputeFacts): ResolutionPath[] {
  const hasBuyerEvidence =
    facts.evidence.some((e) => e.uploadedById === facts.parties.buyerId) ||
    facts.messages.some((m) => m.isEvidence && m.senderId === facts.parties.buyerId);
  const sellerReplied = facts.parties.sellerId
    ? facts.messages.some((m) => m.senderId === facts.parties.sellerId)
    : false;
  const paid = facts.order?.paymentStatus === 'PAID';

  return DECISION_PATHS.map((decision) => {
    const effect = financialEffectFor(facts.policy, decision);
    const named = effect !== null;
    let rationale: string;
    switch (decision) {
      case 'IN_FAVOR_OF_BUYER':
        rationale = paid
          ? hasBuyerEvidence
            ? 'الطلب مدفوع وللمشتري دليل مرفق.'
            : 'الطلب مدفوع لكن لا دليل مرفقًا من المشتري بعد.'
          : 'الطلب غير مدفوع؛ استرداد مبلغ غير محصَّل يحتاج مراجعة بشرية.';
        break;
      case 'IN_FAVOR_OF_SELLER':
        rationale = sellerReplied
          ? 'البائع شارك في النقاش وله حجة مسجّلة.'
          : 'البائع لم يشارك بعد؛ الحكم لصالحه بلا رد يحتاج تبريرًا.';
        break;
      case 'SPLIT':
        rationale = 'تقسيم المبلغ يحتاج نسبة متفقًا عليها؛ السياسة لا تحدّد النسبة.';
        break;
      case 'REJECTED':
        rationale = hasBuyerEvidence
          ? 'رفض النزاع مع وجود دليل من المشتري يحتاج تعليلًا صريحًا.'
          : 'لا دليل داعم للنزاع؛ الرفض متاح.';
        break;
    }
    return {
      decision,
      financialEffect: effect,
      available: named,
      rationale: named ? rationale : `${rationale} لا أثر مالي منشور لهذا القرار في السياسة (DECISION_REQUIRED).`,
    };
  });
}

export function buildGaps(facts: DisputeFacts, deadlines: DisputeDeadlines): DisputeGap[] {
  const gaps: DisputeGap[] = [];
  const { dispute, parties } = facts;
  const buyerEvidence =
    facts.evidence.some((e) => e.uploadedById === parties.buyerId) ||
    facts.messages.some((m) => m.isEvidence && m.senderId === parties.buyerId);
  const sellerReplied = parties.sellerId
    ? facts.messages.some((m) => m.senderId === parties.sellerId)
    : false;

  if (!dispute.assignedToId && !TERMINAL_STATUSES.has(dispute.status)) {
    gaps.push({ code: 'UNASSIGNED', detail: 'لا مراجع معيَّن للنزاع.' });
  }
  if (!buyerEvidence) {
    gaps.push({ code: 'NO_EVIDENCE', detail: 'لا دليل مرفق من المشتري (ملف أو رسالة موسومة كدليل).' });
  }
  if (dispute.description.trim().length < 40) {
    gaps.push({ code: 'SHORT_DESCRIPTION', detail: 'وصف النزاع قصير ولا يشرح الوقائع بالتفصيل.' });
  }
  if (parties.sellerId && !sellerReplied) {
    gaps.push({ code: 'NO_SELLER_RESPONSE', detail: 'البائع لم يرد على النزاع.' });
  }
  if (deadlines.evidenceOverdue && !buyerEvidence) {
    gaps.push({ code: 'EVIDENCE_DEADLINE_PASSED', detail: 'انتهت مهلة الأدلة دون أي دليل من المشتري.' });
  }
  if (deadlines.responseOverdue && parties.sellerId && !sellerReplied) {
    gaps.push({ code: 'RESPONSE_OVERDUE', detail: 'انتهت مهلة رد البائع دون رد.' });
  }
  if (deadlines.decisionOverdue) {
    gaps.push({ code: 'DECISION_OVERDUE', detail: 'تجاوز النزاع مهلة القرار المنصوصة في السياسة.' });
  }
  if (!facts.policy) {
    gaps.push({ code: 'POLICY_UNAVAILABLE', detail: 'تعذّر قراءة سياسة النزاع؛ لا تُحتسب مهل ولا تُقترح مسارات مالية.' });
  }
  return gaps;
}

export function buildRecommendation(
  facts: DisputeFacts,
  deadlines: DisputeDeadlines,
  gaps: DisputeGap[],
): Recommendation {
  const codes = new Set(gaps.map((g) => g.code));
  const hasBuyerEvidence = !codes.has('NO_EVIDENCE');
  const paid = facts.order?.paymentStatus === 'PAID';
  const sellerSilent = codes.has('NO_SELLER_RESPONSE');
  const sellerOverdue = codes.has('RESPONSE_OVERDUE');

  if (!facts.policy) {
    return {
      action: 'REQUEST_POLICY',
      rationale: 'لا سياسة نزاع مقروءة لهذا الطلب؛ لا يمكن اقتراح مسار مالي قبل تثبيت السياسة.',
      confidence: 0.3,
      basis: ['POLICY_UNAVAILABLE'],
    };
  }

  if (!hasBuyerEvidence && !deadlines.evidenceOverdue) {
    return {
      action: 'REQUEST_FURTHER_EVIDENCE',
      rationale: 'مهلة الأدلة ما زالت مفتوحة ولا دليل من المشتري؛ طلب الدليل قبل أي قرار.',
      confidence: 0.6,
      basis: ['NO_EVIDENCE', 'EVIDENCE_WINDOW_OPEN'],
    };
  }

  if (sellerSilent && sellerOverdue) {
    return {
      action: 'ESCALATE_FOR_NON_RESPONSE',
      rationale: 'انتهت مهلة الرد والبائع لم يشارك؛ يُرفع النزاع للمراجعة بدل إصدار قرار بلا رد.',
      confidence: 0.55,
      basis: ['NO_SELLER_RESPONSE', 'RESPONSE_OVERDUE'],
    };
  }

  if (paid && hasBuyerEvidence) {
    return {
      action: 'IN_FAVOR_OF_BUYER',
      rationale: 'الطلب مدفوع وللمشتري دليل مرفق والبائع لم ينفِ الوقائع بدليل مضاد.',
      confidence: sellerSilent ? 0.7 : 0.6,
      basis: ['ORDER_PAID', 'BUYER_EVIDENCE', ...(sellerSilent ? ['NO_SELLER_RESPONSE'] : ['SELLER_PARTICIPATED'])],
    };
  }

  if (!hasBuyerEvidence && deadlines.evidenceOverdue) {
    return {
      action: 'IN_FAVOR_OF_SELLER',
      rationale: 'انتهت مهلة الأدلة دون دليل داعم من المشتري؛ الرفض أو الحكم للبائع هو المسار المدعوم بالوقائع.',
      confidence: 0.55,
      basis: ['NO_EVIDENCE', 'EVIDENCE_DEADLINE_PASSED'],
    };
  }

  return {
    action: 'REQUEST_FURTHER_EVIDENCE',
    rationale: 'الوقائع غير مكتملة؛ طلب توضيح إضافي أفضل من قرار غير مدعوم.',
    confidence: 0.45,
    basis: ['FACTS_INCOMPLETE'],
  };
}

export function buildDisputeSummary(facts: DisputeFacts): DisputeSummary {
  const { dispute, order, messages, evidence, events, appeals, policy, now } = facts;
  const deadlines = computeDeadlines(dispute.createdAt, policy?.rules, now, dispute.status);
  const gaps = buildGaps(facts, deadlines);
  const resolutionPaths = buildResolutionPaths(facts);
  const recommendation = buildRecommendation(facts, deadlines, gaps);

  const participants = [...new Set(messages.map((m) => m.senderId))];
  const lastMessage = messages.length > 0 ? messages[messages.length - 1]!.createdAt : null;
  const openAppeals = appeals.filter((a) => a.status === 'PENDING').length;

  return {
    mode: 'summary',
    dispute: {
      id: dispute.id,
      disputeNumber: dispute.disputeNumber,
      status: dispute.status,
      reasonCode: dispute.reasonCode,
      description: dispute.description,
      decision: dispute.decision,
      assignedToId: dispute.assignedToId,
      appealAllowed: dispute.appealAllowed,
      openedById: dispute.openedById,
      createdAt: dispute.createdAt.toISOString(),
      decidedAt: dispute.decidedAt?.toISOString() ?? null,
      ageHours: hoursBetween(dispute.createdAt, now),
    },
    order: order
      ? {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          refundStatus: order.refundStatus,
          grandTotal: order.grandTotal,
          currencyCode: order.currencyCode,
          createdAt: order.createdAt.toISOString(),
        }
      : null,
    conversation: {
      messages: messages.length,
      participants,
      buyerMessages: facts.parties.buyerId
        ? messages.filter((m) => m.senderId === facts.parties.buyerId).length
        : 0,
      sellerMessages: facts.parties.sellerId
        ? messages.filter((m) => m.senderId === facts.parties.sellerId).length
        : 0,
      evidenceMessages: messages.filter((m) => m.isEvidence).length,
      lastMessageAt: lastMessage?.toISOString() ?? null,
      recent: messages.slice(-10).map((m) => ({
        senderId: m.senderId,
        isEvidence: m.isEvidence,
        at: m.createdAt.toISOString(),
        excerpt: m.body.slice(0, 140),
      })),
    },
    evidence: {
      count: evidence.length,
      items: evidence.map((e) => ({
        uploadedById: e.uploadedById,
        description: e.description,
        contentType: e.contentType,
        createdAt: e.createdAt.toISOString(),
      })),
    },
    timeline: events.map((e) => ({ at: e.createdAt.toISOString(), type: e.eventType, actorId: e.actorId })),
    appeals: { count: appeals.length, open: openAppeals },
    deadlines,
    policy,
    gaps,
    resolutionPaths,
    recommendation,
    readOnly: true,
    decisionAuthority: 'HUMAN',
    generatedAt: now.toISOString(),
  };
}

export function buildDisputeTriage(
  rows: {
    id: string;
    disputeNumber: string;
    status: string;
    reasonCode: string;
    assignedToId: string | null;
    createdAt: Date;
    decisionDueAt: Date | null;
  }[],
  counts: Record<string, number>,
  now: Date,
): DisputeTriage {
  const openRows = rows.filter((r) => !TERMINAL_STATUSES.has(r.status));
  const byStatus: Record<string, number> = { ...counts };
  const unassigned = openRows.filter((r) => !r.assignedToId).length;
  const overdue = openRows.filter((r) => r.decisionDueAt !== null && now > r.decisionDueAt).length;
  const oldest = openRows.reduce<Date | null>((acc, r) => (acc === null || r.createdAt < acc ? r.createdAt : acc), null);

  const action: Recommendation['action'] =
    openRows.length === 0 ? 'REVIEW_OLDEST' : unassigned > 0 ? 'ASSIGN_REVIEWER' : 'REVIEW_OLDEST';

  return {
    mode: 'triage',
    counts: { byStatus, open: openRows.length, unassigned, decisionOverdue: overdue },
    openDisputes: openRows.map((r) => ({
      id: r.id,
      disputeNumber: r.disputeNumber,
      status: r.status,
      reasonCode: r.reasonCode,
      assignedToId: r.assignedToId,
      createdAt: r.createdAt.toISOString(),
      ageHours: hoursBetween(r.createdAt, now),
      decisionOverdue: r.decisionDueAt !== null && now > r.decisionDueAt,
    })),
    oldestOpenHours: oldest === null ? null : hoursBetween(oldest, now),
    recommendation: {
      action,
      rationale:
        openRows.length === 0
          ? 'لا نزاعات مفتوحة الآن.'
          : `${openRows.length} نزاعًا مفتوحًا، منها ${unassigned} بلا مراجع${overdue > 0 ? ` و${overdue} تجاوز مهلة القرار` : ''}. ابدأ بالمراجع الأقدم عمرًا.`,
      confidence: openRows.length === 0 ? 0.2 : 0.5,
      basis: ['TRIAGE_ONLY', ...(unassigned > 0 ? ['UNASSIGNED'] : []), ...(overdue > 0 ? ['DECISION_OVERDUE'] : [])],
    },
    readOnly: true,
    decisionAuthority: 'HUMAN',
    generatedAt: now.toISOString(),
  };
}
