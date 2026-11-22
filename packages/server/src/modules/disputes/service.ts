import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { orders, transactions } from '../../db/schema/commerce';
import {
  disputeAppeals,
  disputeEvidence,
  disputeEvents,
  disputeMessages,
  disputes,
  type disputeDecisionEnum,
  type disputeEventTypeEnum,
  type disputeStatusEnum,
} from '../../db/schema/disputes';
import { users } from '../../db/schema/auth';
import { resolveOwnedSellerIds, isOrderParticipant } from '../../lib/seller-ownership';
import {
  appealDeadline,
  computeOpenWindowClosesAt,
  evaluateDeadlines,
  isWithinWindow,
  parseDeadlineRules,
} from '../../lib/disputes/deadlines';
import { resolveOrderCountry } from '../../lib/country';
import { resolveMergedPolicy } from '../../lib/policy-engine';
import { recordCountryPolicyGap, resolveCountryPolicyGap } from '../../lib/country-policy-gaps';
import { writeAudit } from '../../lib/audit';
import { createNotification } from '../../lib/notifications-service';
import { generateDisputeNumber, newId } from '../../lib/ids';
import { roundMoney, toDecimal } from '../../lib/money';
import { createRefund } from '../payments/service.js';

export type DisputeStatus = (typeof disputeStatusEnum.enumValues)[number];
export type DisputeDecision = (typeof disputeDecisionEnum.enumValues)[number];
export type DisputeEventType = (typeof disputeEventTypeEnum.enumValues)[number];

const PARTY_ROLES = ['SUPPORT', 'RISK', 'DISPUTE', 'ADMIN', 'SUPER_ADMIN'];

export interface DisputeSummary {
  id: string;
  disputeNumber: string;
  orderId: string;
  openedById: string;
  openedByEmail: string | null;
  reasonCode: string;
  description: string;
  status: DisputeStatus;
  decision: DisputeDecision;
  decisionNote: string | null;
  assignedToId: string | null;
  assignedToEmail: string | null;
  appealAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeEventRow {
  id: string;
  disputeId: string;
  actorId: string | null;
  eventType: DisputeEventType;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DisputeMessageRow {
  id: string;
  senderId: string;
  senderEmail: string | null;
  body: string;
  isEvidence: boolean;
  createdAt: string;
}

export interface DisputeEvidenceRow {
  id: string;
  uploadedById: string;
  fileRef: string;
  description: string | null;
  contentType: string | null;
  createdAt: string;
}

export type AppealStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface DisputeAppealRow {
  id: string;
  disputeId: string;
  appealedById: string;
  appealedByEmail: string | null;
  reason: string;
  status: AppealStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface DisputeDetail extends DisputeSummary {
  /** Country resolved from the order; null when no party has a country on file. */
  countryId: string | null;
  countryCode: string | null;
  /** Which dispute-policy layer governs this dispute. */
  policySource: 'COUNTRY' | 'GLOBAL';
  /** Concrete policy deadlines (ISO strings), null where the policy sets none. */
  deadlines: {
    openWindowClosesAt: string | null;
    responseDeadline: string | null;
    evidenceDeadline: string | null;
    decisionDeadline: string | null;
    autoEscalateAt: string | null;
  };
  /** The operational state of those deadlines right now. */
  deadlineStatus: {
    responseOpen: boolean;
    evidenceOpen: boolean;
    decisionOverdue: boolean;
    needsEscalation: boolean;
    daysToEvidence: number | null;
    daysToDecision: number | null;
  };
  events: DisputeEventRow[];
  messages: DisputeMessageRow[];
  evidence: DisputeEvidenceRow[];
  appeals: DisputeAppealRow[];
}

/**
 * Appeal limits, resolved from the country's DISPUTE_RESOLUTION policy when one
 * exists, otherwise the global policy. Never hardcoded.
 */
interface AppealRules {
  appealWindowDays: number;
  maxAppeals: number;
}

/**
 * Masks an email for a viewer who is not entitled to see it in full. A party to
 * a dispute needs to recognise *that* the counterparty acted, not to harvest the
 * counterparty's contact details, so a non-staff viewer sees a redacted form.
 */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** The viewer's relationship to a record, deciding what identity may be shown. */
interface ViewerView {
  userId: string;
  isStaff: boolean;
}

/** The full email for staff or the owner of the record; a masked form otherwise. */
function visibleEmail(email: string | null | undefined, ownerId: string | null, viewer: ViewerView): string | null {
  if (!email) return null;
  if (viewer.isStaff || ownerId === viewer.userId) return email;
  return maskEmail(email);
}

function eventRow(r: typeof disputeEvents.$inferSelect): DisputeEventRow {
  return {
    id: r.id,
    disputeId: r.disputeId,
    actorId: r.actorId,
    eventType: r.eventType,
    before: (r.before ?? {}) as Record<string, unknown> | null,
    after: (r.after ?? {}) as Record<string, unknown> | null,
    metadata: (r.metadata ?? {}) as Record<string, unknown> | null,
    createdAt: r.createdAt.toISOString(),
  };
}

function messageRow(r: typeof disputeMessages.$inferSelect, email: string | null): DisputeMessageRow {
  return {
    id: r.id,
    senderId: r.senderId,
    senderEmail: email ?? null,
    body: r.body,
    isEvidence: r.isEvidence,
    createdAt: r.createdAt.toISOString(),
  };
}

function evidenceRow(r: typeof disputeEvidence.$inferSelect): DisputeEvidenceRow {
  return {
    id: r.id,
    uploadedById: r.uploadedById,
    fileRef: r.fileRef,
    description: r.description,
    contentType: r.contentType,
    createdAt: r.createdAt.toISOString(),
  };
}

function appealRow(r: typeof disputeAppeals.$inferSelect, email: string | null): DisputeAppealRow {
  return {
    id: r.id,
    disputeId: r.disputeId,
    appealedById: r.appealedById,
    appealedByEmail: email,
    reason: r.reason,
    status: r.status as AppealStatus,
    decidedBy: r.decidedBy,
    decisionNote: r.decisionNote,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function loadDisputeBase(db: DB, disputeId: string): Promise<(typeof disputes.$inferSelect) | null> {
  const rows = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  return rows[0] ?? null;
}

async function toDetail(db: DB, d: typeof disputes.$inferSelect, viewer: ViewerView): Promise<DisputeDetail> {
  const [openedBy] = await db.select({ email: users.email }).from(users).where(eq(users.id, d.openedById)).limit(1);
  let assignedEmail: string | null = null;
  if (d.assignedToId) {
    const ar = await db.select({ email: users.email }).from(users).where(eq(users.id, d.assignedToId)).limit(1);
    assignedEmail = ar?.[0]?.email ?? null;
  }
  const [events, messages, evidence, appeals, policy, order] = await Promise.all([
    db.select().from(disputeEvents).where(eq(disputeEvents.disputeId, d.id)).orderBy(asc(disputeEvents.createdAt)),
    db.select().from(disputeMessages).where(eq(disputeMessages.disputeId, d.id)).orderBy(asc(disputeMessages.createdAt)),
    db.select().from(disputeEvidence).where(eq(disputeEvidence.disputeId, d.id)).orderBy(asc(disputeEvidence.createdAt)),
    db.select().from(disputeAppeals).where(eq(disputeAppeals.disputeId, d.id)).orderBy(asc(disputeAppeals.createdAt)),
    getDisputePolicyForOrder(db, d.orderId),
    db.select({ createdAt: orders.createdAt }).from(orders).where(eq(orders.id, d.orderId)).limit(1),
  ]);

  const senderEmails = new Map<string, string | null>();
  const uniqueSenderIds = [...new Set(messages.map((m) => m.senderId))];
  if (uniqueSenderIds.length > 0) {
    const ur = await db.select({ id: users.id, email: users.email }).from(users).where(sql`${users.id} in (${sql.join(uniqueSenderIds.map((id) => sql`${id}`), sql`, `)})`);
    for (const u of ur) senderEmails.set(u.id, u.email);
  }

  const appealEmails = new Map<string, string | null>();
  const uniqueAppellantIds = [...new Set(appeals.map((a) => a.appealedById))];
  if (uniqueAppellantIds.length > 0) {
    const ur = await db.select({ id: users.id, email: users.email }).from(users).where(sql`${users.id} in (${sql.join(uniqueAppellantIds.map((id) => sql`${id}`), sql`, `)})`);
    for (const u of ur) appealEmails.set(u.id, u.email);
  }

  const deadlineStatus = evaluateDeadlines(
    {
      disputeCreatedAt: d.createdAt,
      orderCreatedAt: order[0]?.createdAt ?? d.createdAt,
      decided: d.status === 'DECIDED',
    },
    parseDeadlineRules(policy.rules),
  );

  return {
    id: d.id,
    disputeNumber: d.disputeNumber,
    orderId: d.orderId,
    openedById: d.openedById,
    openedByEmail: visibleEmail(openedBy?.email, d.openedById, viewer),
    reasonCode: d.reasonCode,
    description: d.description,
    status: d.status,
    decision: d.decision,
    decisionNote: d.decisionNote,
    assignedToId: d.assignedToId,
    assignedToEmail: visibleEmail(assignedEmail, d.assignedToId, viewer),
    appealAllowed: d.appealAllowed,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    countryId: policy.countryId,
    countryCode: policy.countryCode,
    policySource: policy.source,
    deadlines: {
      openWindowClosesAt: deadlineStatus.deadlines.openWindowClosesAt?.toISOString() ?? null,
      responseDeadline: deadlineStatus.deadlines.responseDeadline?.toISOString() ?? null,
      evidenceDeadline: deadlineStatus.deadlines.evidenceDeadline?.toISOString() ?? null,
      decisionDeadline: deadlineStatus.deadlines.decisionDeadline?.toISOString() ?? null,
      autoEscalateAt: deadlineStatus.deadlines.autoEscalateAt?.toISOString() ?? null,
    },
    deadlineStatus: {
      responseOpen: deadlineStatus.responseOpen,
      evidenceOpen: deadlineStatus.evidenceOpen,
      decisionOverdue: deadlineStatus.decisionOverdue,
      needsEscalation: deadlineStatus.needsEscalation,
      daysToEvidence: deadlineStatus.daysToEvidence,
      daysToDecision: deadlineStatus.daysToDecision,
    },
    events: events.map(eventRow),
    messages: messages.map((m) => messageRow(m, visibleEmail(senderEmails.get(m.senderId) ?? null, m.senderId, viewer))),
    evidence: evidence.map(evidenceRow),
    appeals: appeals.map((a) => appealRow(a, visibleEmail(appealEmails.get(a.appealedById) ?? null, a.appealedById, viewer))),
  };
}

async function writeDisputeEvent(
  db: DB,
  disputeId: string,
  actorId: string | null,
  eventType: DisputeEventType,
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await db.insert(disputeEvents).values({
    id: newId(),
    disputeId,
    actorId,
    eventType,
    before: before ?? null,
    after: after ?? null,
    metadata: metadata ?? null,
  });
}

/** Payload exposed to clients; includes which policy layer was applied. */
export interface DisputePolicyResult {
  rules: Record<string, unknown>;
  source: 'COUNTRY' | 'GLOBAL';
  countryId: string | null;
  countryCode: string | null;
  policyId: string | null;
  version: number | null;
}

/**
 * Resolves the effective dispute policy for an order's country. Country override
 * wins; otherwise the global policy applies and the gap is recorded as
 * Decision Required rather than inventing country-specific rules.
 */
export async function getDisputePolicyForOrder(db: DB, orderId: string): Promise<DisputePolicyResult> {
  const country = await resolveOrderCountry(db, orderId);
  const resolved = await resolveMergedPolicy(db, {
    scope: 'DISPUTE',
    code: 'DISPUTE_RESOLUTION',
    countryId: country?.id ?? null,
  });

  if (country && resolved.countryOverrideMissing) {
    await recordCountryPolicyGap(db, {
      countryId: country.id,
      scope: 'DISPUTE',
      code: 'DISPUTE_RESOLUTION',
      reason:
        'Country-specific dispute resolution rules are not configured; global policy is being applied. ' +
        'Legal review required to define local rules.',
      metadata: { countryCode: country.code, appliedPolicyId: resolved.policyId, appliedVersion: resolved.version },
    });
  } else if (country && resolved.source === 'COUNTRY') {
    await resolveCountryPolicyGap(db, { countryId: country.id, scope: 'DISPUTE', code: 'DISPUTE_RESOLUTION' });
  }

  return {
    rules: resolved.rules,
    source: resolved.source,
    countryId: country?.id ?? null,
    countryCode: country?.code ?? null,
    policyId: resolved.policyId,
    version: resolved.version,
  };
}

/** The global dispute resolution policy rules (no country context). */
export async function getDisputePolicy(db: DB): Promise<Record<string, unknown>> {
  const resolved = await resolveMergedPolicy(db, { scope: 'DISPUTE', code: 'DISPUTE_RESOLUTION', countryId: null });
  return resolved.rules;
}

/**
 * Read-only snapshot of the policy that governs one dispute.
 *
 * `getDisputePolicyForOrder` records a country-policy gap when no override
 * exists. That write is correct for a human-facing read, but an agent run must
 * never write a platform row, so the snapshot path resolves the merged policy
 * without registering the gap. The task stores the snapshot as immutable input,
 * which also makes the advice auditable against the rules in force when it was
 * requested.
 */
export async function disputePolicySnapshot(
  db: DB,
  disputeId: string | null,
): Promise<{
  rules: Record<string, unknown>;
  source: 'COUNTRY' | 'GLOBAL';
  countryCode: string | null;
  policyId: string | null;
  version: number | null;
  capturedAt: string;
} | null> {
  // A null id means "the platform default", used for queue triage where no
  // single dispute (and therefore no country) is in scope yet.
  const dispute = disputeId ? await loadDisputeBase(db, disputeId) : null;
  if (disputeId && !dispute) return null;
  const country = dispute ? await resolveOrderCountry(db, dispute.orderId) : null;
  const resolved = await resolveMergedPolicy(db, {
    scope: 'DISPUTE',
    code: 'DISPUTE_RESOLUTION',
    countryId: country?.id ?? null,
  });
  return {
    rules: resolved.rules,
    source: resolved.source,
    countryCode: country?.code ?? null,
    policyId: resolved.policyId,
    version: resolved.version,
    capturedAt: new Date().toISOString(),
  };
}

/** Appeal limits are policy-driven, never hardcoded. Defaults mirror the seeded policy. */
async function resolveAppealRules(db: DB, orderId: string): Promise<AppealRules> {
  const policy = await getDisputePolicyForOrder(db, orderId);
  const rules = parseDeadlineRules(policy.rules);
  return {
    appealWindowDays: rules.appealWindowDays ?? 7,
    maxAppeals: rules.maxAppeals ?? 1,
  };
}

// ---------- User-facing ----------

export interface CreateDisputeInput {
  orderId: string;
  reasonCode: string;
  description: string;
}

export async function createDispute(
  db: DB,
  userId: string,
  input: CreateDisputeInput,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string }> {
  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw ApiError.notFound('Order');
  if (!(await isOrderParticipant(db, input.orderId, userId))) {
    throw ApiError.forbidden('You must be a party to this order to open a dispute');
  }
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED' || order.status === 'DISPUTED') {
    throw ApiError.conflict(`Order is ${order.status}; dispute already handled`);
  }

  // The window in which a dispute may be opened is a policy value, measured from
  // the order. When the policy sets no window the platform does not invent one —
  // an unconfigured window is open-ended, not arbitrarily short.
  const policy = await getDisputePolicyForOrder(db, input.orderId);
  const rules = parseDeadlineRules(policy.rules);
  if (!isWithinWindow(new Date(), computeOpenWindowClosesAt(order.createdAt, rules))) {
    throw ApiError.conflict(
      `The window to open a dispute on this order (${rules.openWindowDays} day(s)) has closed`,
    );
  }

  const existing = await db
    .select({ id: disputes.id })
    .from(disputes)
    .where(sql`order_id = ${input.orderId} and status in ('OPEN','UNDER_REVIEW','REQUESTED_FURTHER_EVIDENCE','ESCALATED')`)
    .limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('An open dispute already exists for this order');
  }

  const id = newId();
  await db.insert(disputes).values({
    id,
    disputeNumber: generateDisputeNumber(),
    orderId: input.orderId,
    openedById: userId,
    reasonCode: input.reasonCode,
    description: input.description,
    status: 'OPEN',
    decision: 'NONE',
    appealAllowed: true,
  });
  await writeDisputeEvent(db, id, userId, 'CREATED', null, { reasonCode: input.reasonCode });

  await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'DISPUTE.CREATED',
    entityType: 'DISPUTE',
    entityId: id,
    after: { orderId: input.orderId, reasonCode: input.reasonCode },
  });
  return { id };
}

/** Whether the user holds a staff role that may review any dispute (never a party). */
async function isDisputeStaff(db: DB, userId: string): Promise<boolean> {
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), sql`id in (select user_id from user_roles where role_id in (select id from roles where name in (${sql.join(PARTY_ROLES.map((r) => sql`${r}`), sql`, `)})))`))
    .limit(1);
  return staff.length > 0;
}

/**
 * A party who opened a dispute may withdraw it while it is still live. The
 * withdrawer must be the opener (a seller cannot withdraw a buyer's case) and
 * the dispute must not yet have an outcome — once decided or closed, the record
 * is a matter of history and is not erased. Withdrawing closes the dispute; it
 * moves no money, so an already-applied refund is never reversed here.
 */
export async function withdrawDispute(
  db: DB,
  userId: string,
  disputeId: string,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ id: string; status: DisputeStatus }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  if (d.openedById !== userId) {
    throw ApiError.forbidden('Only the party who opened the dispute may withdraw it');
  }
  if (d.status === 'DECIDED' || d.status === 'CLOSED' || d.status === 'ARCHIVED') {
    throw ApiError.conflict(`Dispute is ${d.status} and can no longer be withdrawn`);
  }

  const updated = await db
    .update(disputes)
    .set({ status: 'CLOSED', updatedAt: new Date() })
    .where(and(eq(disputes.id, disputeId), sql`status in ('OPEN','UNDER_REVIEW','REQUESTED_FURTHER_EVIDENCE','ESCALATED')`))
    .returning({ id: disputes.id });
  if (updated.length === 0) {
    throw ApiError.conflict('Dispute changed concurrently and can no longer be withdrawn');
  }

  await writeDisputeEvent(db, disputeId, userId, 'STATUS_CHANGED', { status: d.status }, { status: 'CLOSED', note: 'Withdrawn by opener' });
  await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'DISPUTE.WITHDRAWN',
    entityType: 'DISPUTE',
    entityId: disputeId,
    before: { status: d.status },
    after: { status: 'CLOSED' },
  });
  return { id: disputeId, status: 'CLOSED' };
}

/** Whether the current user can act on / view a dispute (participant or staff). */
export async function canAccessDispute(db: DB, userId: string, dispute: typeof disputes.$inferSelect): Promise<boolean> {
  if (userId === dispute.openedById) return true;
  if (userId === dispute.assignedToId) return true;
  const owned = await resolveOwnedSellerIds(db, userId);
  const order = await db.select({ sellerId: orders.sellerId }).from(orders).where(eq(orders.id, dispute.orderId)).limit(1);
  if (order[0]) {
    if (order[0].sellerId !== null && owned.includes(order[0].sellerId)) return true;
    // legacy/dev shape: order seller_id may be the user id directly
    if (order[0].sellerId === userId) return true;
    // M2: a multi-seller parent has no single seller_id — the seller may be a
    // party through one of its suborders.
    const sub = await db.execute<{ id: string }>(sql`
      select id from seller_orders
      where parent_order_id = ${dispute.orderId} and seller_id = ${userId} limit 1
    `) as unknown as { rows: { id: string }[] };
    if (sub.rows.length > 0) return true;
  }
  return isDisputeStaff(db, userId);
}

export async function requireDisputeAccessOrThrow(db: DB, userId: string, dispute: typeof disputes.$inferSelect): Promise<void> {
  if (!(await canAccessDispute(db, userId, dispute))) {
    throw ApiError.forbidden('You are not a party or assigned reviewer of this dispute');
  }
}

export async function listMyDisputes(db: DB, userId: string): Promise<DisputeSummary[]> {
  const owned = await resolveOwnedSellerIds(db, userId);
  const rowConditions = [
    eq(disputes.openedById, userId),
    // legacy/dev shape: order seller_id may be the user id directly
    sql`${disputes.orderId} in (select id from orders where seller_id = ${userId})`,
  ];
  if (owned.length > 0) {
    rowConditions.push(sql`${disputes.orderId} in (select id from orders where seller_id in (${sql.join(owned.map((id) => sql`${id}`), sql`, `)}))`);
  }
  const rows = await db
    .select()
    .from(disputes)
    .where(or(...rowConditions))
    .orderBy(desc(disputes.createdAt))
    .limit(100);

  const isStaff = await isDisputeStaff(db, userId);
  const viewer: ViewerView = { userId, isStaff };
  const result: DisputeSummary[] = [];
  for (const d of rows) {
    const [openedBy] = await db.select({ email: users.email }).from(users).where(eq(users.id, d.openedById)).limit(1);
    let assignedEmail: string | null = null;
    if (d.assignedToId) {
      const ar = await db.select({ email: users.email }).from(users).where(eq(users.id, d.assignedToId)).limit(1);
      assignedEmail = ar?.[0]?.email ?? null;
    }
    result.push({
      id: d.id,
      disputeNumber: d.disputeNumber,
      orderId: d.orderId,
      openedById: d.openedById,
      openedByEmail: visibleEmail(openedBy?.email, d.openedById, viewer),
      reasonCode: d.reasonCode,
      description: d.description,
      status: d.status,
      decision: d.decision,
      decisionNote: d.decisionNote,
      assignedToId: d.assignedToId,
      assignedToEmail: visibleEmail(assignedEmail, d.assignedToId, viewer),
      appealAllowed: d.appealAllowed,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    });
  }
  return result;
}

export async function getDisputeDetail(db: DB, userId: string, disputeId: string): Promise<DisputeDetail> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  await requireDisputeAccessOrThrow(db, userId, d);
  // Staff reviewers see full identities; a party sees the counterparty's contact
  // details masked, so a dispute cannot be used to harvest an email address.
  const isStaff = await isDisputeStaff(db, userId);
  return toDetail(db, d, { userId, isStaff });
}

export async function addDisputeMessage(db: DB, userId: string, disputeId: string, body: string): Promise<{ id: string }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  await requireDisputeAccessOrThrow(db, userId, d);

  // The response window is the respondent's turn. A party who did not open the
  // case may add their reply only inside `responseWindowDays`; once it closes the
  // back-and-forth is over and their response is refused. The opener, an assigned
  // reviewer and staff keep the channel open — they are not "responding". This is
  // the enforcement of a window that would otherwise be display-only.
  const isRespondent = userId !== d.openedById && userId !== d.assignedToId && !(await isDisputeStaff(db, userId));
  if (isRespondent) {
    const order = await db.select({ createdAt: orders.createdAt }).from(orders).where(eq(orders.id, d.orderId)).limit(1);
    const policy = await getDisputePolicyForOrder(db, d.orderId);
    const status = evaluateDeadlines(
      { disputeCreatedAt: d.createdAt, orderCreatedAt: order[0]?.createdAt ?? d.createdAt, decided: d.status === 'DECIDED' },
      parseDeadlineRules(policy.rules),
    );
    if (!status.responseOpen) {
      throw ApiError.conflict('The response window for this dispute has closed');
    }
  }

  const id = newId();
  await db.insert(disputeMessages).values({ id, disputeId, senderId: userId, body, isEvidence: false });
  await writeDisputeEvent(db, disputeId, userId, 'MESSAGE_ADDED', null, { bodyLength: body.length });
  return { id };
}

// ---------- Admin actions ----------

export interface AdminListQuery {
  status?: DisputeStatus;
  decision?: DisputeDecision;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listAllDisputes(db: DB, query: AdminListQuery = {}): Promise<{ items: DisputeSummary[]; page: number; pageSize: number; total: number }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof sql>)[] = [];
  if (query.status) conditions.push(eq(disputes.status, query.status));
  if (query.decision) conditions.push(eq(disputes.decision, query.decision));
  if (query.q) {
    conditions.push(sql`(${disputes.disputeNumber} ilike ${`%${query.q}%`} or ${disputes.openedById} in (select u.id from users u where u.email ilike ${`%${query.q}%`}))`);
  }

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(disputes)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const rows = await db
    .select()
    .from(disputes)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(disputes.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const items: DisputeSummary[] = [];
  for (const d of rows) {
    const [openedBy] = await db.select({ email: users.email }).from(users).where(eq(users.id, d.openedById)).limit(1);
    let assignedEmail: string | null = null;
    if (d.assignedToId) {
      const ar = await db.select({ email: users.email }).from(users).where(eq(users.id, d.assignedToId)).limit(1);
      assignedEmail = ar?.[0]?.email ?? null;
    }
    items.push({
      id: d.id,
      disputeNumber: d.disputeNumber,
      orderId: d.orderId,
      openedById: d.openedById,
      openedByEmail: openedBy?.email ?? null,
      reasonCode: d.reasonCode,
      description: d.description,
      status: d.status,
      decision: d.decision,
      decisionNote: d.decisionNote,
      assignedToId: d.assignedToId,
      assignedToEmail: assignedEmail,
      appealAllowed: d.appealAllowed,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    });
  }
  return { items, page, pageSize, total: Number(total) };
}

export async function assignDispute(db: DB, disputeId: string, actorId: string, reviewerUserId: string): Promise<{ id: string }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  const [reviewer] = await db.select().from(users).where(eq(users.id, reviewerUserId)).limit(1);
  if (!reviewer) throw ApiError.notFound('Reviewer user');

  await db.update(disputes).set({ assignedToId: reviewerUserId, assignedAt: new Date(), updatedAt: new Date() }).where(eq(disputes.id, disputeId));
  await writeDisputeEvent(db, disputeId, actorId, 'ASSIGNED', { assignedToId: d.assignedToId ?? null }, { assignedToId: reviewerUserId });
  await writeAudit(db, { actorId }, { action: 'DISPUTE.ASSIGNED', entityType: 'DISPUTE', entityId: disputeId, before: { assignedToId: d.assignedToId }, after: { assignedToId: reviewerUserId } });
  await createNotification(db, {
    userId: reviewerUserId,
    type: 'DISPUTE.ASSIGNED',
    title: 'Dispute assigned to you',
    body: `Dispute ${d.disputeNumber} (${d.reasonCode}) has been assigned to you.`,
    data: { disputeId, disputeNumber: d.disputeNumber },
  });
  return { id: disputeId };
}

export async function updateDisputeStatus(db: DB, disputeId: string, actorId: string, status: DisputeStatus, note?: string): Promise<{ id: string }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');

  // `DECIDED` is not a status a caller may set directly. A decision carries a
  // decision, a decision-maker and possibly a financial effect; setting the bare
  // status would record an outcome with none of them (decision NONE, decidedBy
  // null) and would bypass both the separation-of-duties check and the money
  // rail. Decisions go through `decideDispute` only.
  if (status === 'DECIDED') {
    throw ApiError.conflict('A dispute is decided through the decide endpoint, not by setting its status');
  }

  const allowedTransitions: Record<DisputeStatus, DisputeStatus[]> = {
    OPEN: ['UNDER_REVIEW', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED', 'CLOSED'],
    UNDER_REVIEW: ['OPEN', 'REQUESTED_FURTHER_EVIDENCE', 'ESCALATED', 'CLOSED'],
    REQUESTED_FURTHER_EVIDENCE: ['OPEN', 'UNDER_REVIEW', 'ESCALATED', 'CLOSED'],
    ESCALATED: ['UNDER_REVIEW', 'CLOSED'],
    DECIDED: ['CLOSED'],
    CLOSED: ['ARCHIVED'],
    ARCHIVED: ['OPEN'],
  };
  if (!allowedTransitions[d.status]?.includes(status)) {
    throw ApiError.conflict(`Invalid dispute status transition ${d.status} -> ${status}`);
  }

  // Conditional on the status we just read: a concurrent change cannot be
  // silently overwritten, and a lost race is reported rather than ignored.
  const updated = await db
    .update(disputes)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(disputes.id, disputeId), eq(disputes.status, d.status)))
    .returning({ id: disputes.id });
  if (updated.length === 0) {
    throw ApiError.conflict(`Dispute status changed concurrently; expected ${d.status}`);
  }
  await writeDisputeEvent(db, disputeId, actorId, 'STATUS_CHANGED', { status: d.status }, { status, note: note ?? null });
  await writeAudit(db, { actorId }, { action: 'DISPUTE.STATUS', entityType: 'DISPUTE', entityId: disputeId, before: { status: d.status }, after: { status } });

  await createNotification(db, {
    userId: d.openedById,
    type: 'DISPUTE.STATUS',
    title: 'Dispute status updated',
    body: `Dispute ${d.disputeNumber} status changed to ${status}${note ? `: ${note}` : ''}.`,
    data: { disputeId, status },
  });
  return { id: disputeId };
}

export interface EscalationSweepResult {
  scanned: number;
  escalated: number;
}

/**
 * Escalates live disputes that have sat past their policy `autoEscalateDays`
 * window, so the window is acted on rather than merely displayed. Idempotent and
 * safe across instances: every transition is a conditional UPDATE that only
 * matches a still-live dispute, so two sweeps (or two processes) cannot escalate
 * the same case twice — the loser sees zero rows and writes nothing. A policy
 * that sets no `autoEscalateDays` never escalates (the window is open-ended), and
 * a dispute already in a terminal state is never touched.
 *
 * The flag a client sees (`deadlineStatus.needsEscalation`) and the decision this
 * sweep makes both come from `evaluateDeadlines`, so they can never disagree.
 */
export async function escalateOverdueDisputes(
  db: DB,
  options: { now?: Date; limit?: number } = {},
): Promise<EscalationSweepResult> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? 500), 5000);

  // `autoEscalateDays` is always at least one day (the policy schema floors it at
  // 1), so nothing younger than a day can be overdue. This bounds the scan
  // without hardcoding any window; the precise window is resolved per dispute.
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const candidates = await db
    .select()
    .from(disputes)
    .where(sql`status in ('OPEN','UNDER_REVIEW','REQUESTED_FURTHER_EVIDENCE') and created_at <= ${cutoff}`)
    .orderBy(asc(disputes.createdAt))
    .limit(limit);

  let escalated = 0;
  for (const d of candidates) {
    const policy = await getDisputePolicyForOrder(db, d.orderId);
    const rules = parseDeadlineRules(policy.rules);
    const status = evaluateDeadlines(
      { disputeCreatedAt: d.createdAt, orderCreatedAt: d.createdAt, decided: false, now },
      rules,
    );
    if (!status.needsEscalation) continue;

    const updated = await db
      .update(disputes)
      .set({ status: 'ESCALATED', updatedAt: new Date() })
      .where(and(eq(disputes.id, d.id), sql`status in ('OPEN','UNDER_REVIEW','REQUESTED_FURTHER_EVIDENCE')`))
      .returning({ id: disputes.id });
    if (updated.length === 0) continue;

    escalated += 1;
    await writeDisputeEvent(db, d.id, null, 'STATUS_CHANGED', { status: d.status }, { status: 'ESCALATED', reason: 'auto-escalated past the policy window' });
    await writeAudit(db, { actorId: null, actorType: 'SYSTEM' }, {
      action: 'DISPUTE.AUTO_ESCALATED',
      entityType: 'DISPUTE',
      entityId: d.id,
      before: { status: d.status },
      after: { status: 'ESCALATED', autoEscalateDays: rules.autoEscalateDays },
    });
  }
  return { scanned: candidates.length, escalated };
}

/**
 * A dispute decision is not only a status change: it can return money. Which
 * decision implies which financial outcome is policy-driven, not hardcoded — the
 * effective dispute policy may declare a `decisionEffects` map. When the policy
 * is silent for the decision being taken, the platform does NOT guess: it
 * records a country-policy gap (Decision Required) and leaves the order
 * untouched, because fabricating a refund or a release would be inventing a
 * financial rule nobody agreed to.
 *
 * When the effect is `REFUND_BUYER`, the reversal is written through the existing
 * refund machinery (`createRefund`), so the compensating ledger entry, the
 * commission/fee reversal and the order's refund state all follow the same
 * audited path a normal refund does. There is no new ledger rule and no second
 * source of financial truth.
 *
 * Idempotency: the refund's `idempotencyKey` is derived from the dispute id, so
 * re-deciding the same dispute can never refund twice. The financial step runs
 * only on the transition into DECIDED; an already-decided dispute cannot be
 * re-decided here (it is guarded below).
 */
export async function decideDispute(
  db: DB,
  disputeId: string,
  actorId: string,
  input: { decision: Exclude<DisputeDecision, 'NONE'>; note?: string; partialRefundAmount?: string },
): Promise<{ id: string; financialEffect: DisputeFinancialEffect }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  if (d.status === 'CLOSED' || d.status === 'ARCHIVED') {
    throw ApiError.conflict('Dispute is already closed');
  }
  if (d.status === 'DECIDED') {
    throw ApiError.conflict('Dispute is already decided');
  }
  // Separation of duties: a party to the order has a direct interest in the
  // outcome and may never be the decision-maker, whatever staff role they also
  // hold. Without this, a merchant with a dispute-desk role could rule on their
  // own case.
  if (await isOrderParticipant(db, d.orderId, actorId)) {
    throw ApiError.forbidden('A party to the order cannot decide this dispute');
  }

  // Resolve the financial consequence BEFORE mutating state, so a policy that
  // requires a human decision cannot half-apply a dispute.
  const effect = await resolveDisputeFinancialEffect(db, d.orderId, d.id, input.decision, input.partialRefundAmount);

  // Apply the money movement first: if the refund rail refuses (e.g. the order
  // was never paid), the dispute is not marked decided on the strength of an
  // outcome that did not actually happen. The refund's idempotency key is the
  // dispute id, so a concurrent second decision can never refund twice.
  const refund = await applyDisputeFinancialEffect(db, d, effect, actorId);

  // Transition atomically: the UPDATE only matches an undecided dispute, so of
  // two concurrent decisions exactly one writes the terminal state and the other
  // is refused instead of silently overwriting the first outcome.
  const transitioned = await db
    .update(disputes)
    .set({ decision: input.decision, decisionNote: input.note ?? d.decisionNote, decidedBy: actorId, decidedAt: new Date(), status: 'DECIDED', updatedAt: new Date() })
    .where(and(eq(disputes.id, disputeId), sql`status in ('OPEN','UNDER_REVIEW','REQUESTED_FURTHER_EVIDENCE','ESCALATED')`))
    .returning({ id: disputes.id });
  if (transitioned.length === 0) {
    throw ApiError.conflict('Dispute was decided by another reviewer');
  }
  await writeDisputeEvent(db, disputeId, actorId, 'DECIDED', { decision: d.decision }, { decision: input.decision, note: input.note ?? null, financialEffect: effect, refund });
  await writeAudit(db, { actorId }, { action: 'DISPUTE.DECIDED', entityType: 'DISPUTE', entityId: disputeId, before: { decision: d.decision }, after: { decision: input.decision, financialEffect: effect, refund } });

  await createNotification(db, {
    userId: d.openedById,
    type: 'DISPUTE.DECISION',
    title: 'Dispute decision',
    body: `Dispute ${d.disputeNumber} resolved: ${input.decision}${input.note ? ` — ${input.note}` : ''}`,
    data: { disputeId, disputeNumber: d.disputeNumber, decision: input.decision, financialEffect: effect.kind },
  });
  return { id: disputeId, financialEffect: effect };
}

export type DisputeFinancialEffectKind =
  | 'NONE' // decision has no money consequence (e.g. IN_FAVOR_OF_SELLER, REJECTED)
  | 'REFUND_BUYER' // money returns to the buyer via the refund rail
  | 'REFUND_UNAVAILABLE' // policy says refund, but the order never collected money
  | 'DECISION_REQUIRED'; // policy names no effect for this decision; do not guess

export interface DisputeFinancialEffect {
  kind: DisputeFinancialEffectKind;
  /** Refund amount for REFUND_BUYER. */
  amount?: string;
  currencyCode?: string;
  reason?: string;
  /** Populated for DECISION_REQUIRED — why the platform refused to guess. */
  decisionRequiredReason?: string;
  /** Populated for REFUND_UNAVAILABLE — why the named refund did not happen. */
  unavailableReason?: string;
}

/**
 * Resolves the money consequence of a decision from policy. Reads
 * `rules.decisionEffects[decision]`; absent or unrecognised ⇒ DECISION_REQUIRED.
 * Amount is the order's grand total unless policy sets `refundRatio` (SPLIT).
 */
async function resolveDisputeFinancialEffect(
  db: DB,
  orderId: string,
  disputeId: string,
  decision: Exclude<DisputeDecision, 'NONE'>,
  partialRefundAmount?: string,
): Promise<DisputeFinancialEffect> {
  const policy = await getDisputePolicyForOrder(db, orderId);
  const rules = policy.rules as Record<string, unknown>;
  const effects = (rules.decisionEffects ?? null) as Record<string, { effect?: string; refundRatio?: number }> | null;

  const entry = effects?.[decision];
  const effectName = entry?.effect;

  if (effectName === 'NONE') return { kind: 'NONE' };

  if (effectName === 'REFUND_BUYER') {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw ApiError.notFound('Order');
    const ratio = Number(entry?.refundRatio);
    const amount =
      partialRefundAmount ??
      (Number.isFinite(ratio) && ratio > 0 && ratio <= 1
        ? roundMoney(toDecimal(order.grandTotal).mul(ratio)).toFixed(4)
        : order.grandTotal);

    // A decision can be taken on an order that never collected money: checkout
    // creates the order and the payment is confirmed later, so a dispute is a
    // legitimate state for an UNPAID order. The decision still has to be
    // recorded — refusing it would block the staff desk on an ordinary case —
    // but no refund may be claimed, because the refund rail has nothing to
    // reverse. That is reported as its own outcome rather than as a policy gap,
    // since the policy did name the effect and the admin queue must not be
    // filled with false "decision required" entries.
    if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED') {
      return {
        kind: 'REFUND_UNAVAILABLE',
        amount,
        currencyCode: order.currencyCode,
        unavailableReason: `Order ${order.orderNumber} collected no funds (payment status ${order.paymentStatus}); the decision is recorded but nothing is refunded.`,
      };
    }

    return {
      kind: 'REFUND_BUYER',
      amount,
      currencyCode: order.currencyCode,
      reason: `Dispute ${disputeId} decided ${decision}`,
    };
  }

  // No configured effect for this decision — a policy decision is required. The
  // gap is recorded against the country when one is resolvable, so it surfaces
  // in the admin "decision required" queue rather than being silently ignored.
  const country = await resolveOrderCountry(db, orderId);
  if (country?.id) {
    await recordCountryPolicyGap(db, {
      countryId: country.id,
      scope: 'DISPUTE',
      code: 'DISPUTE_RESOLUTION',
      reason:
        `No financial effect is configured for dispute decision '${decision}'. ` +
        'A policy decision is required before this outcome can move money.',
      metadata: { disputeId, decision, policySource: policy.source, policyVersion: policy.version },
    });
  }
  return {
    kind: 'DECISION_REQUIRED',
    decisionRequiredReason: `No financial effect is configured for decision '${decision}'`,
  };
}

/**
 * Applies a resolved financial effect. Only REFUND_BUYER moves money, and it
 * does so exclusively through `createRefund` (the same audited rail a manual
 * refund uses). The dispute id is the idempotency key, so replaying a decision
 * can never refund twice — `createRefund` returns the original refund instead.
 *
 * A dispute decision is NOT proof that money moved: `createRefund` completes the
 * refund only on trusted external evidence. When no trusted rail is available
 * the refund stays pending and this returns that pending status, so the decision
 * never claims a refund that did not happen.
 */
async function applyDisputeFinancialEffect(
  db: DB,
  d: typeof disputes.$inferSelect,
  effect: DisputeFinancialEffect,
  actorId: string,
): Promise<{ refundId: string; amount: string; status: string; reused: boolean } | null> {
  if (effect.kind !== 'REFUND_BUYER') return null;

  const result = await createRefund(db, {
    orderId: d.orderId,
    amount: effect.amount,
    reason: effect.reason,
    idempotencyKey: `dispute:${d.id}`,
    actorId,
    isOperator: true,
  });
  return { refundId: result.refund.id, amount: result.refund.amount, status: result.refund.status, reused: result.reused };
}

export async function addEvidence(
  db: DB,
  userId: string,
  disputeId: string,
  input: { fileRef: string; description?: string; contentType?: string },
): Promise<{ id: string }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  await requireDisputeAccessOrThrow(db, userId, d);

  // Evidence may only be filed inside the policy's evidence window. The window
  // is measured from the dispute's creation and closes for parties and staff
  // alike; a closed window is a deliberate stop, not a soft warning.
  const order = await db.select({ createdAt: orders.createdAt }).from(orders).where(eq(orders.id, d.orderId)).limit(1);
  const policy = await getDisputePolicyForOrder(db, d.orderId);
  const status = evaluateDeadlines(
    { disputeCreatedAt: d.createdAt, orderCreatedAt: order[0]?.createdAt ?? d.createdAt, decided: d.status === 'DECIDED' },
    parseDeadlineRules(policy.rules),
  );
  if (!status.evidenceOpen) {
    throw ApiError.conflict('The evidence window for this dispute has closed');
  }

  const id = newId();
  await db.insert(disputeEvidence).values({
    id,
    disputeId,
    uploadedById: userId,
    fileRef: input.fileRef,
    description: input.description ?? null,
    contentType: input.contentType ?? null,
  });
  await writeDisputeEvent(db, disputeId, userId, 'EVIDENCE_ADDED', null, { fileRef: input.fileRef });
  return { id };
}

/**
 * Dispute policy for clients. When an orderId is supplied the country's policy is
 * resolved (with global fallback + gap registration); otherwise the global rules
 * are returned without a country context.
 */
export async function listDisputePolicyRules(
  db: DB,
  orderId?: string,
): Promise<Record<string, unknown> | DisputePolicyResult> {
  if (orderId) return getDisputePolicyForOrder(db, orderId);
  return getDisputePolicy(db);
}

// ---------- Appeals ----------

export interface CreateAppealResult {
  id: string;
}

/**
 * A party to the order may appeal a decided dispute once, within the policy window.
 * The right belongs to order parties only — staff review, they do not appeal.
 */
export async function createDisputeAppeal(
  db: DB,
  userId: string,
  disputeId: string,
  input: { reason: string },
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<CreateAppealResult> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');

  if (!(await isOrderParticipant(db, d.orderId, userId))) {
    throw ApiError.forbidden('Only a party to the order may appeal this dispute');
  }
  if (!d.appealAllowed) {
    throw ApiError.conflict('Appeals are not allowed for this dispute');
  }
  if (d.status !== 'DECIDED' && d.status !== 'CLOSED') {
    throw ApiError.conflict('A dispute can only be appealed after it has been decided');
  }
  if (!d.decidedAt) {
    throw ApiError.conflict('Dispute has no recorded decision to appeal');
  }

  const rules = await resolveAppealRules(db, d.orderId);
  const closesAt = appealDeadline(d.decidedAt, parseDeadlineRules({ appealWindowDays: rules.appealWindowDays }));
  if (!isWithinWindow(new Date(), closesAt)) {
    throw ApiError.conflict(`The appeal window of ${rules.appealWindowDays} day(s) has closed`);
  }

  const existing = await db
    .select({ id: disputeAppeals.id, status: disputeAppeals.status })
    .from(disputeAppeals)
    .where(eq(disputeAppeals.disputeId, disputeId));

  if (existing.some((a) => a.status === 'PENDING')) {
    throw ApiError.conflict('An appeal is already pending for this dispute');
  }
  if (existing.length >= rules.maxAppeals) {
    throw ApiError.conflict(`This dispute has reached the maximum of ${rules.maxAppeals} appeal(s)`);
  }

  const id = newId();
  await db.insert(disputeAppeals).values({
    id,
    disputeId,
    appealedById: userId,
    reason: input.reason,
    status: 'PENDING',
  });
  await writeDisputeEvent(db, disputeId, userId, 'APPEALED', { status: d.status }, { appealId: id, reasonLength: input.reason.length });
  await writeAudit(db, { actorId: userId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent }, {
    action: 'DISPUTE.APPEAL.CREATED',
    entityType: 'DISPUTE',
    entityId: disputeId,
    after: { appealId: id },
  });

  if (d.assignedToId) {
    await createNotification(db, {
      userId: d.assignedToId,
      type: 'DISPUTE.APPEAL',
      title: 'New dispute appeal',
      body: `Dispute ${d.disputeNumber} has been appealed and awaits review.`,
      data: { disputeId, appealId: id, disputeNumber: d.disputeNumber },
    });
  }
  return { id };
}

/** Appeals are visible to dispute parties and staff, same access rule as the dispute. */
export async function listDisputeAppeals(db: DB, userId: string, disputeId: string): Promise<DisputeAppealRow[]> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');
  await requireDisputeAccessOrThrow(db, userId, d);

  const rows = await db
    .select()
    .from(disputeAppeals)
    .where(eq(disputeAppeals.disputeId, disputeId))
    .orderBy(asc(disputeAppeals.createdAt));

  const emails = new Map<string, string | null>();
  const ids = [...new Set(rows.map((r) => r.appealedById))];
  if (ids.length > 0) {
    const ur = await db.select({ id: users.id, email: users.email }).from(users).where(sql`${users.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    for (const u of ur) emails.set(u.id, u.email);
  }
  const isStaff = await isDisputeStaff(db, userId);
  const viewer: ViewerView = { userId, isStaff };
  return rows.map((r) => appealRow(r, visibleEmail(emails.get(r.appealedById) ?? null, r.appealedById, viewer)));
}

/**
 * Staff review of a pending appeal. Accepting reopens the dispute for review;
 * rejecting leaves the original decision standing. The original decider is
 * recused from reviewing the appeal against their own decision.
 */
export async function reviewDisputeAppeal(
  db: DB,
  actorId: string,
  disputeId: string,
  appealId: string,
  input: { status: 'ACCEPTED' | 'REJECTED'; note?: string },
): Promise<{ id: string }> {
  const d = await loadDisputeBase(db, disputeId);
  if (!d) throw ApiError.notFound('Dispute');

  const [appeal] = await db
    .select()
    .from(disputeAppeals)
    .where(and(eq(disputeAppeals.id, appealId), eq(disputeAppeals.disputeId, disputeId)))
    .limit(1);
  if (!appeal) throw ApiError.notFound('Appeal');
  if (appeal.status !== 'PENDING') {
    throw ApiError.conflict(`Appeal is already ${appeal.status}`);
  }
  if (d.decidedBy && d.decidedBy === actorId) {
    throw ApiError.forbidden('The original decision-maker cannot review an appeal of their own decision');
  }
  // A party to the order is never a neutral reviewer, whatever staff role they
  // hold — the same separation-of-duties rule that guards the first decision.
  if (await isOrderParticipant(db, d.orderId, actorId)) {
    throw ApiError.forbidden('A party to the order cannot review this appeal');
  }

  // Claim the pending appeal atomically so two reviewers cannot both act on it.
  const claimed = await db
    .update(disputeAppeals)
    .set({
      status: input.status,
      decidedBy: actorId,
      decisionNote: input.note ?? null,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(disputeAppeals.id, appealId), eq(disputeAppeals.status, 'PENDING')))
    .returning({ id: disputeAppeals.id });
  if (claimed.length === 0) {
    throw ApiError.conflict('Appeal was already reviewed by another reviewer');
  }

  await writeAudit(db, { actorId }, {
    action: 'DISPUTE.APPEAL.REVIEWED',
    entityType: 'DISPUTE',
    entityId: disputeId,
    before: { appealStatus: 'PENDING' },
    after: { appealStatus: input.status, appealId, note: input.note ?? null },
  });

  if (input.status === 'ACCEPTED') {
    await db
      .update(disputes)
      .set({ status: 'UNDER_REVIEW', appealAllowed: false, updatedAt: new Date() })
      .where(eq(disputes.id, disputeId));
    await writeDisputeEvent(db, disputeId, actorId, 'REOPENED', { status: d.status }, { status: 'UNDER_REVIEW', appealId });
    await writeAudit(db, { actorId }, {
      action: 'DISPUTE.REOPENED',
      entityType: 'DISPUTE',
      entityId: disputeId,
      before: { status: d.status },
      after: { status: 'UNDER_REVIEW', appealId },
    });
  }

  await createNotification(db, {
    userId: appeal.appealedById,
    type: 'DISPUTE.APPEAL.DECIDED',
    title: 'Appeal decision',
    body: `Your appeal on dispute ${d.disputeNumber} was ${input.status}${input.note ? `: ${input.note}` : ''}.`,
    data: { disputeId, appealId, status: input.status },
  });
  return { id: disputeId };
}