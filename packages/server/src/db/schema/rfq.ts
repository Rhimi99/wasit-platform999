import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sellerTypeEnum } from './products';

/**
 * B2B-01 — request for quotation (RFQ).
 *
 * An RFQ is a *negotiation* document: it carries no money and no stock. Only an
 * accepted quote is turned into an order, and that conversion goes through the
 * existing `createOrder` path (commission policy, payment fee, COMPANY identity).
 * Nothing here writes to the ledger.
 *
 * Isolation is by participation, not by role: a buyer sees the RFQs of its own
 * company, a seller sees only the RFQs it was invited to and only its own quote.
 * Every query is scoped through `modules/rfq/access.ts`; the tables deliberately
 * carry the owning ids so a filter is always possible.
 */

export const rfqStatusEnum = pgEnum('rfq_status', [
  'DRAFT',
  'OPEN',
  'AWARDED',
  'CANCELLED',
  'EXPIRED',
  'CLOSED',
]);

export const rfqRecipientStatusEnum = pgEnum('rfq_recipient_status', [
  'INVITED',
  'VIEWED',
  'QUOTED',
  'DECLINED',
  'WITHDRAWN',
]);

export const rfqQuoteStatusEnum = pgEnum('rfq_quote_status', [
  'SUBMITTED',
  'SUPERSEDED',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
]);

export const rfqEventTypeEnum = pgEnum('rfq_event_type', [
  'CREATED',
  'SENT',
  'VIEWED',
  'RECIPIENT_DECLINED',
  'QUOTE_SUBMITTED',
  'QUOTE_REVISED',
  'QUOTE_WITHDRAWN',
  'QUOTE_ACCEPTED',
  'QUOTE_REJECTED',
  'CANCELLED',
  'EXPIRED',
]);

export const rfqs = pgTable(
  'rfqs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rfqNumber: varchar('rfq_number', { length: 40 }).notNull(),
    /**
     * The buying company. Not nullable: an RFQ is always issued *as* a company,
     * which is also what the accepted quote will be ordered under. A caller who
     * owns no company can never create one (enforced in the service).
     */
    buyerCompanyId: varchar('buyer_company_id', { length: 36 }).notNull(),
    /** Denormalised for the seller-side ownership check without a join. */
    buyerUserId: varchar('buyer_user_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    /** One currency per RFQ: every quote must quote in this currency. */
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    status: rfqStatusEnum('status').notNull().default('DRAFT'),
    /** Quote validity and round ceiling are snapshotted from policy at send time. */
    quoteValidityDays: integer('quote_validity_days').notNull().default(14),
    maxRounds: integer('max_rounds').notNull().default(5),
    neededBy: timestamp('needed_by', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /**
     * When the buyer confirmed that its company name and the request items will
     * be disclosed to the named sellers. Written on `send`; never inferred.
     */
    disclosureAcknowledgedAt: timestamp('disclosure_acknowledged_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    awardedAt: timestamp('awarded_at', { withTimezone: true }),
    /**
     * The quote revision the buyer accepted, and the order it produced. Both are
     * written in the same transaction as the order itself, which is what makes
     * "awarded" and "has an order" the same fact rather than two that can drift.
     * `awarded_quote_id` also makes a retried acceptance replayable: the retry
     * finds the RFQ awarded to *this* quote and returns that order instead of
     * refusing with "already awarded".
     */
    awardedQuoteId: varchar('awarded_quote_id', { length: 36 }),
    orderId: varchar('order_id', { length: 36 }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberIdx: uniqueIndex('rfqs_number_idx').on(t.rfqNumber),
    buyerCompanyIdx: index('rfqs_buyer_company_idx').on(t.buyerCompanyId),
    buyerUserIdx: index('rfqs_buyer_user_idx').on(t.buyerUserId),
    statusIdx: index('rfqs_status_idx').on(t.status),
    expiresIdx: index('rfqs_expires_idx').on(t.expiresAt),
    /**
     * The expiry sweep asks one question only — "which OPEN rows are past their
     * deadline" — so the index is partial: it stays small (finished RFQs leave
     * it) and answers the sweep without scanning the table.
     */
    orderIdx: index('rfqs_order_idx').on(t.orderId),
    openExpiresIdx: index('rfqs_open_expires_idx')
      .on(t.expiresAt)
      .where(sql`status = 'OPEN'`),
  }),
);

export const rfqItems = pgTable(
  'rfq_items',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rfqId: varchar('rfq_id', { length: 36 }).notNull(),
    /**
     * Nullable on purpose: a company may ask for something that is not in the
     * catalogue yet. Conversion to an order is refused for such a line unless it
     * has been linked to a purchasable product (see `assertConvertible`).
     */
    productId: varchar('product_id', { length: 36 }),
    freeTextName: varchar('free_text_name', { length: 200 }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unit: varchar('unit', { length: 40 }),
    targetPrice: numeric('target_price', { precision: 18, scale: 4 }),
    specifications: jsonb('specifications'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rfqIdx: index('rfq_items_rfq_idx').on(t.rfqId),
    productIdx: index('rfq_items_product_idx').on(t.productId),
  }),
);

export const rfqRecipients = pgTable(
  'rfq_recipients',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rfqId: varchar('rfq_id', { length: 36 }).notNull(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    /** The owning user of the seller entity; the consent and notice target. */
    sellerUserId: varchar('seller_user_id', { length: 36 }).notNull(),
    recipientStatus: rfqRecipientStatusEnum('recipient_status').notNull().default('INVITED'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /** Seller declined the invitation; the reason is the seller's own words. */
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    /** Seller pulled its offer back; the invitation stays visible to the buyer. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /** Written at send: the seller's RFQ_PARTICIPATION consent was verified. */
    consentVerifiedAt: timestamp('consent_verified_at', { withTimezone: true }),
  },
  (t) => ({
    rfqSellerIdx: uniqueIndex('rfq_recipients_rfq_seller_idx').on(t.rfqId, t.sellerId),
    rfqIdx: index('rfq_recipients_rfq_idx').on(t.rfqId),
    sellerUserIdx: index('rfq_recipients_seller_user_idx').on(t.sellerUserId),
  }),
);

export const rfqQuotes = pgTable(
  'rfq_quotes',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rfqId: varchar('rfq_id', { length: 36 }).notNull(),
    recipientId: varchar('recipient_id', { length: 36 }).notNull(),
    sellerId: varchar('seller_id', { length: 36 }).notNull(),
    sellerType: sellerTypeEnum('seller_type').notNull(),
    sellerUserId: varchar('seller_user_id', { length: 36 }).notNull(),
    /** 1-based. A revision never edits the previous row; it supersedes it. */
    revision: integer('revision').notNull().default(1),
    quoteStatus: rfqQuoteStatusEnum('quote_status').notNull().default('SUBMITTED'),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    itemsTotal: numeric('items_total', { precision: 18, scale: 4 }).notNull(),
    leadTimeDays: integer('lead_time_days'),
    paymentTerms: varchar('payment_terms', { length: 200 }),
    notes: text('notes'),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    supersedesId: varchar('supersedes_id', { length: 36 }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Who decided (rejection is the only decision in this phase). */
    decidedByUserId: varchar('decided_by_user_id', { length: 36 }),
    /** Mandatory on rejection: a decision without a recorded reason is not one. */
    decisionReason: text('decision_reason'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawalReason: text('withdrawal_reason'),
    /** Set when the validity window lapsed and the status became EXPIRED. */
    expiredAt: timestamp('expired_at', { withTimezone: true }),
  },
  (t) => ({
    revisionIdx: uniqueIndex('rfq_quotes_rfq_seller_revision_idx').on(t.rfqId, t.sellerId, t.revision),
    rfqIdx: index('rfq_quotes_rfq_idx').on(t.rfqId),
    sellerIdx: index('rfq_quotes_seller_idx').on(t.sellerId),
    statusIdx: index('rfq_quotes_status_idx').on(t.quoteStatus),
    /**
     * One accepted revision per RFQ, enforced by the database. Two buyers' tabs
     * (or two app instances) can pass every service-level check at the same
     * instant; only this index can guarantee a second acceptance is impossible.
     */
    oneAcceptedIdx: uniqueIndex('rfq_quotes_one_accepted_idx')
      .on(t.rfqId)
      .where(sql`quote_status = 'ACCEPTED'`),
    /** Same idea for quote validity: only live submissions can lapse. */
    liveExpiryIdx: index('rfq_quotes_live_expiry_idx')
      .on(t.validUntil)
      .where(sql`quote_status = 'SUBMITTED'`),
  }),
);

export const rfqQuoteLines = pgTable(
  'rfq_quote_lines',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    quoteId: varchar('quote_id', { length: 36 }).notNull(),
    rfqItemId: varchar('rfq_item_id', { length: 36 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    quoteItemIdx: uniqueIndex('rfq_quote_lines_quote_item_idx').on(t.quoteId, t.rfqItemId),
    quoteIdx: index('rfq_quote_lines_quote_idx').on(t.quoteId),
  }),
);

/**
 * Append-only timeline readable by the RFQ participants themselves. `audit_logs`
 * cannot serve this: it is staff-only by permission, and widening that
 * permission would expose every other audit trail too.
 */
export const rfqEvents = pgTable(
  'rfq_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    rfqId: varchar('rfq_id', { length: 36 }).notNull(),
    actorUserId: varchar('actor_user_id', { length: 36 }),
    /** USER | SYSTEM — a scheduled expiry is never attributed to a person. */
    actorType: varchar('actor_type', { length: 16 }).notNull().default('USER'),
    eventType: rfqEventTypeEnum('event_type').notNull(),
    payload: jsonb('payload'),
    /**
     * Timeline entries are not uniformly visible. A quote event names the seller
     * it belongs to, so seller B never sees seller A's activity; a null seller id
     * means the entry is addressed to the buyer or to every invited seller.
     */
    visibleToBuyer: boolean('visible_to_buyer').notNull().default(true),
    visibleToSeller: boolean('visible_to_seller').notNull().default(false),
    sellerId: varchar('seller_id', { length: 36 }),
    /**
     * The quote revision the entry describes, when it describes one. Stored as
     * columns rather than inside `payload` so the history is filterable and the
     * revision number cannot be edited by rewriting a JSON blob.
     */
    quoteId: varchar('quote_id', { length: 36 }),
    quoteRevision: integer('quote_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rfqIdx: index('rfq_events_rfq_idx').on(t.rfqId, t.createdAt),
    sellerIdx: index('rfq_events_seller_idx').on(t.sellerId),
    quoteIdx: index('rfq_events_quote_idx').on(t.quoteId),
  }),
);
