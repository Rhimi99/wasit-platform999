import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import type { DB } from '../../db/client';
import { currencies } from '../../db/schema/geo';
import { products } from '../../db/schema/products';
import { companies } from '../../db/schema/trade';
import {
  rfqEvents,
  rfqItems,
  rfqQuoteLines,
  rfqQuotes,
  rfqRecipients,
  rfqs,
} from '../../db/schema/rfq';
import { writeAudit, type AuditContext } from '../../lib/audit';
import { newId, generateRfqNumber } from '../../lib/ids';
import { createNotification } from '../../lib/notifications-service';
import { fmt, toDecimal } from '../../lib/money';
import { resolveOwnedSellerIds } from '../../lib/seller-ownership';
import {
  assertRfqAccess,
  hasRfqParticipation,
  requireBuyer,
  requireOwnedCompany,
  requireSeller,
  resolveOwnedCompany,
  resolveSellerEntities,
} from './access';
import { resolveRfqPolicy } from './policy';
import {
  toBuyerRfqView,
  toItemView,
  toQuoteView,
  toSellerRfqView,
  type BuyerRfqView,
  type CompanyCardView,
  type QuoteView,
  type RfqView,
  type SellerRfqView,
} from './views';

export interface CreateRfqInput {
  title: string;
  description?: string | null;
  currencyCode: string;
  neededBy?: string | null;
  items: Array<{
    productId?: string | null;
    freeTextName?: string | null;
    quantity: string;
    unit?: string | null;
    targetPrice?: string | null;
    specifications?: Record<string, unknown> | null;
  }>;
}

export interface SendRfqInput {
  sellerIds: string[];
  /** Explicit acknowledgement: the company name and items will be disclosed. */
  acknowledgeDisclosure: boolean;
}

export interface SubmitQuoteInput {
  currencyCode: string;
  leadTimeDays?: number | null;
  paymentTerms?: string | null;
  notes?: string | null;
  lines: Array<{ rfqItemId: string; unitPrice: string; quantity: string }>;
}

function assertPositive(value: string, field: string): void {
  const d = toDecimal(value);
  if (!d.isFinite() || d.lte(0)) {
    throw ApiError.validation([{ field, message: 'Must be greater than zero', code: 'VALIDATION_FAILED' }]);
  }
}

async function requireCurrency(db: DB, code: string): Promise<string> {
  const normalized = code.toUpperCase();
  const [row] = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(and(eq(currencies.code, normalized), eq(currencies.isActive, true)))
    .limit(1);
  if (!row) {
    throw ApiError.validation([
      { field: 'currencyCode', message: `${normalized} is not an active currency`, code: 'VALIDATION_FAILED' },
    ]);
  }
  return row.code;
}

async function recordEvent(
  db: DB,
  input: {
    rfqId: string;
    eventType: (typeof rfqEvents.$inferInsert)['eventType'];
    actorUserId: string | null;
    actorType?: 'USER' | 'SYSTEM';
    payload?: Record<string, unknown> | null;
    visibleToBuyer?: boolean;
    visibleToSeller?: boolean;
    sellerId?: string | null;
  },
): Promise<void> {
  await db.insert(rfqEvents).values({
    id: newId(),
    rfqId: input.rfqId,
    actorUserId: input.actorUserId,
    actorType: input.actorType ?? 'USER',
    eventType: input.eventType,
    payload: input.payload ?? null,
    visibleToBuyer: input.visibleToBuyer ?? true,
    visibleToSeller: input.visibleToSeller ?? false,
    sellerId: input.sellerId ?? null,
  });
}

async function loadItems(db: DB, rfqId: string) {
  const rows = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, rfqId))
    .orderBy(rfqItems.position);
  return rows;
}

async function countQuotes(db: DB, rfqId: string): Promise<number> {
  const rows = await db
    .select({ sellerId: rfqQuotes.sellerId })
    .from(rfqQuotes)
    .where(and(eq(rfqQuotes.rfqId, rfqId), ne(rfqQuotes.quoteStatus, 'SUPERSEDED')));
  return new Set(rows.map((r) => r.sellerId)).size;
}

async function buyerCard(db: DB, companyId: string): Promise<CompanyCardView> {
  const [row] = await db
    .select({
      id: companies.id,
      legalName: companies.legalName,
      slug: companies.slug,
      verified: companies.verified,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  // A company row cannot be deleted through the API; if it is gone the RFQ is
  // still readable, but it must not crash the projection.
  return row ?? { id: companyId, legalName: companyId, slug: companyId, verified: false };
}

/* ------------------------------------------------------------------ */
/* Buyer side                                                          */
/* ------------------------------------------------------------------ */

export async function createRfq(
  db: DB,
  userId: string,
  input: CreateRfqInput,
  ctx: AuditContext,
): Promise<{ id: string; rfqNumber: string; status: string }> {
  const company = await requireOwnedCompany(db, userId);
  const policy = await resolveRfqPolicy(db);

  if (input.items.length === 0) {
    throw ApiError.validation([{ field: 'items', message: 'At least one item is required', code: 'VALIDATION_FAILED' }]);
  }
  if (input.items.length > policy.maxItemsPerRfq) {
    throw ApiError.validation([
      {
        field: 'items',
        message: `At most ${policy.maxItemsPerRfq} items are allowed per request`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  const currencyCode = await requireCurrency(db, input.currencyCode);

  const productIds = input.items.map((i) => i.productId).filter((id): id is string => !!id);
  if (productIds.length > 0) {
    const found = await db.select({ id: products.id }).from(products).where(inArray(products.id, productIds));
    const known = new Set(found.map((p) => p.id));
    const missing = productIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw ApiError.validation([
        { field: 'items.productId', message: `Unknown product: ${missing[0]}`, code: 'PRODUCT_NOT_FOUND' },
      ]);
    }
  }

  input.items.forEach((item, index) => {
    if (!item.productId && !item.freeTextName?.trim()) {
      throw ApiError.validation([
        { field: `items[${index}]`, message: 'A productId or a freeTextName is required', code: 'VALIDATION_FAILED' },
      ]);
    }
    assertPositive(item.quantity, `items[${index}].quantity`);
    if (item.targetPrice) assertPositive(item.targetPrice, `items[${index}].targetPrice`);
  });

  const id = newId();
  const rfqNumber = generateRfqNumber();
  const now = new Date();

  await db.transaction(async (tx) => {
    const db2 = tx as unknown as DB;
    await db2.insert(rfqs).values({
      id,
      rfqNumber,
      buyerCompanyId: company.id,
      buyerUserId: userId,
      title: input.title,
      description: input.description ?? null,
      currencyCode,
      status: 'DRAFT',
      quoteValidityDays: policy.quoteValidityDays,
      maxRounds: policy.maxRounds,
      neededBy: input.neededBy ? new Date(input.neededBy) : null,
      createdAt: now,
      updatedAt: now,
    });

    await db2.insert(rfqItems).values(
      input.items.map((item, index) => ({
        id: newId(),
        rfqId: id,
        productId: item.productId ?? null,
        freeTextName: item.freeTextName?.trim() ?? null,
        quantity: fmt(item.quantity),
        unit: item.unit ?? null,
        targetPrice: item.targetPrice ? fmt(item.targetPrice) : null,
        specifications: item.specifications ?? null,
        position: index,
      })),
    );

    await recordEvent(db2, {
      rfqId: id,
      eventType: 'CREATED',
      actorUserId: userId,
      payload: { itemCount: input.items.length },
    });
  });

  await writeAudit(db, ctx, {
    action: 'RFQ.CREATED',
    entityType: 'RFQ',
    entityId: id,
    after: { rfqNumber, companyId: company.id, currencyCode, itemCount: input.items.length },
  });

  return { id, rfqNumber, status: 'DRAFT' };
}

export async function sendRfq(
  db: DB,
  userId: string,
  rfqId: string,
  input: SendRfqInput,
  ctx: AuditContext,
): Promise<{ status: string; recipientCount: number; expiresAt: string }> {
  const access = requireBuyer(await assertRfqAccess(db, rfqId, userId));
  if (access.rfq.status !== 'DRAFT') {
    throw ApiError.conflict(`An RFQ in ${access.rfq.status} state cannot be sent`);
  }
  if (!input.acknowledgeDisclosure) {
    throw ApiError.validation([
      {
        field: 'acknowledgeDisclosure',
        message: 'The company name and request items will be disclosed to the invited sellers',
        code: 'DISCLOSURE_NOT_ACKNOWLEDGED',
      },
    ]);
  }

  const sellerIds = [...new Set(input.sellerIds)];
  if (sellerIds.length === 0) {
    throw ApiError.validation([{ field: 'sellerIds', message: 'At least one seller is required', code: 'VALIDATION_FAILED' }]);
  }
  // Only the buyer's own company is excluded structurally; every other entity is
  // eligible subject to its owner's consent below.
  if (sellerIds.includes(access.rfq.buyerCompanyId)) {
    throw ApiError.conflict('A company cannot invite itself to its own request');
  }

  const policy = await resolveRfqPolicy(db);
  if (sellerIds.length > policy.maxRecipientsPerRfq) {
    throw ApiError.validation([
      {
        field: 'sellerIds',
        message: `At most ${policy.maxRecipientsPerRfq} sellers may be invited`,
        code: 'VALIDATION_FAILED',
      },
    ]);
  }

  const entities = await resolveSellerEntities(db, sellerIds);
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const sellerId of sellerIds) {
    const entity = byId.get(sellerId);
    if (!entity) {
      throw ApiError.validation([
        { field: 'sellerIds', message: `Unknown seller entity: ${sellerId}`, code: 'SELLER_NOT_FOUND' },
      ]);
    }
    if (!entity.isActive) {
      throw ApiError.conflict(`Seller ${entity.name} is not active`);
    }
  }

  // Consent is a precondition, not a courtesy: an entity whose owner has not
  // opted in is never invited, and the refusal names the sellers without ids.
  const withoutConsent: string[] = [];
  const consents = new Map<string, boolean>();
  for (const entity of entities) {
    if (!consents.has(entity.userId)) {
      consents.set(entity.userId, await hasRfqParticipation(db, entity.userId));
    }
    if (!consents.get(entity.userId)) withoutConsent.push(entity.name);
  }
  if (withoutConsent.length > 0) {
    throw ApiError.conflict(
      `These sellers have not accepted RFQ participation: ${withoutConsent.join(', ')}`,
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.responseWindowDays * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    const db2 = tx as unknown as DB;
    await db2
      .update(rfqs)
      .set({
        status: 'OPEN',
        sentAt: now,
        expiresAt,
        disclosureAcknowledgedAt: now,
        quoteValidityDays: policy.quoteValidityDays,
        maxRounds: policy.maxRounds,
        updatedAt: now,
      })
      .where(eq(rfqs.id, rfqId));

    await db2.insert(rfqRecipients).values(
      entities.map((entity) => ({
        id: newId(),
        rfqId,
        sellerId: entity.id,
        sellerType: entity.sellerType,
        sellerUserId: entity.userId,
        recipientStatus: 'INVITED' as const,
        invitedAt: now,
        consentVerifiedAt: now,
      })),
    );

    await recordEvent(db2, {
      rfqId,
      eventType: 'SENT',
      actorUserId: userId,
      payload: { recipientCount: entities.length, expiresAt: expiresAt.toISOString() },
      visibleToBuyer: true,
      visibleToSeller: true,
    });
  });

  for (const entity of entities) {
    await createNotification(db, {
      userId: entity.userId,
      type: 'RFQ_INVITATION',
      title: 'New request for quotation',
      body: `A company invited ${entity.name} to quote on ${access.rfq.rfqNumber}.`,
      data: { rfqId },
    });
  }

  await writeAudit(db, ctx, {
    action: 'RFQ.SENT',
    entityType: 'RFQ',
    entityId: rfqId,
    after: {
      recipientCount: entities.length,
      sellerIds,
      policyId: policy.policyId,
      policySource: policy.policySource,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { status: 'OPEN', recipientCount: entities.length, expiresAt: expiresAt.toISOString() };
}

export async function cancelRfq(
  db: DB,
  userId: string,
  rfqId: string,
  reason: string | null,
  ctx: AuditContext,
): Promise<{ status: string }> {
  const access = requireBuyer(await assertRfqAccess(db, rfqId, userId));
  if (!['DRAFT', 'OPEN'].includes(access.rfq.status)) {
    throw ApiError.conflict(`An RFQ in ${access.rfq.status} state cannot be cancelled`);
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    const db2 = tx as unknown as DB;
    await db2
      .update(rfqs)
      .set({ status: 'CANCELLED', cancelledAt: now, updatedAt: now })
      .where(eq(rfqs.id, rfqId));
    await recordEvent(db2, {
      rfqId,
      eventType: 'CANCELLED',
      actorUserId: userId,
      payload: reason ? { reason } : null,
      visibleToBuyer: true,
      visibleToSeller: true,
    });
  });

  const invited = await db
    .select({ sellerUserId: rfqRecipients.sellerUserId })
    .from(rfqRecipients)
    .where(eq(rfqRecipients.rfqId, rfqId));
  for (const row of invited) {
    await createNotification(db, {
      userId: row.sellerUserId,
      type: 'RFQ_CANCELLED',
      title: 'Request for quotation cancelled',
      body: `${access.rfq.rfqNumber} was cancelled by the requesting company.`,
      data: { rfqId },
    });
  }

  await writeAudit(db, ctx, {
    action: 'RFQ.CANCELLED',
    entityType: 'RFQ',
    entityId: rfqId,
    before: { status: access.rfq.status },
    after: { status: 'CANCELLED', reason },
  });

  return { status: 'CANCELLED' };
}

export async function listMyRfqs(db: DB, userId: string): Promise<BuyerRfqView[]> {
  // The buyer company is resolved from the caller, not trusted from a query
  // parameter; a user with no company simply has no requests.
  const company = await resolveOwnedCompany(db, userId);
  if (!company) return [];

  const rows = await db
    .select()
    .from(rfqs)
    .where(and(eq(rfqs.buyerCompanyId, company.id), eq(rfqs.buyerUserId, userId)))
    .orderBy(desc(rfqs.createdAt));

  const views: BuyerRfqView[] = [];
  for (const rfq of rows) {
    views.push(await buildBuyerView(db, rfq, company));
  }
  return views;
}

export async function getRfq(db: DB, userId: string, rfqId: string): Promise<RfqView> {
  const access = await assertRfqAccess(db, rfqId, userId);
  if (access.role === 'BUYER') {
    const company = await resolveOwnedCompany(db, userId);
    if (!company || company.id !== access.rfq.buyerCompanyId) {
      // `assertRfqAccess` already proved the user id matches; this guards against
      // a company row that changed hands, where participation must not follow.
      throw ApiError.notFound('RFQ');
    }
    return buildBuyerView(db, access.rfq, company);
  }
  const items = (await loadItems(db, rfqId)).map(toItemView);
  return toSellerRfqView({
    rfq: access.rfq,
    buyer: await buyerCard(db, access.rfq.buyerCompanyId),
    items,
    recipient: access.recipient!,
  });
}

async function buildBuyerView(
  db: DB,
  rfq: (typeof rfqs.$inferSelect),
  company: CompanyCardView,
): Promise<BuyerRfqView> {
  const items = (await loadItems(db, rfq.id)).map(toItemView);
  const recipients = await db
    .select()
    .from(rfqRecipients)
    .where(eq(rfqRecipients.rfqId, rfq.id))
    .orderBy(rfqRecipients.invitedAt);
  const entities = await resolveSellerEntities(
    db,
    recipients.map((r) => r.sellerId),
  );
  const byId = new Map(entities.map((e) => [e.id, e]));
  return toBuyerRfqView({
    rfq,
    company: { id: company.id, legalName: company.legalName, slug: company.slug, verified: company.verified },
    items,
    recipients: recipients.map((recipient) => ({ recipient, seller: byId.get(recipient.sellerId) })),
    quoteCount: await countQuotes(db, rfq.id),
  });
}

/* ------------------------------------------------------------------ */
/* Seller side                                                         */
/* ------------------------------------------------------------------ */

export async function listSellerInbox(db: DB, userId: string): Promise<SellerRfqView[]> {
  const owned = await resolveOwnedSellerIds(db, userId);
  if (owned.length === 0) return [];
  // Consent gates the inbox itself: opting out must empty it, not merely hide a
  // button. `assertRfqAccess` applies the same rule per record.
  if (!(await hasRfqParticipation(db, userId))) return [];

  const invitations = await db
    .select({ rfqId: rfqRecipients.rfqId, recipient: rfqRecipients })
    .from(rfqRecipients)
    .where(inArray(rfqRecipients.sellerId, owned))
    .orderBy(desc(rfqRecipients.invitedAt));

  const views: SellerRfqView[] = [];
  const seen = new Set<string>();
  for (const row of invitations) {
    if (seen.has(row.rfqId)) continue;
    seen.add(row.rfqId);
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, row.rfqId)).limit(1);
    if (!rfq) continue;
    views.push(
      toSellerRfqView({
        rfq,
        buyer: await buyerCard(db, rfq.buyerCompanyId),
        items: (await loadItems(db, rfq.id)).map(toItemView),
        recipient: row.recipient,
      }),
    );
  }
  return views;
}

export async function submitQuote(
  db: DB,
  userId: string,
  rfqId: string,
  input: SubmitQuoteInput,
  ctx: AuditContext,
): Promise<{ quoteId: string; revision: number; itemsTotal: string }> {
  const access = requireSeller(await assertRfqAccess(db, rfqId, userId));
  const sellerId = access.sellerId!;

  if (access.rfq.status !== 'OPEN') {
    throw ApiError.conflict(`An RFQ in ${access.rfq.status} state does not accept quotes`);
  }
  if (access.rfq.expiresAt && access.rfq.expiresAt.getTime() <= Date.now()) {
    throw ApiError.conflict('This RFQ has expired');
  }
  if (input.currencyCode.toUpperCase() !== access.rfq.currencyCode) {
    throw ApiError.conflict(`Quotes must be in ${access.rfq.currencyCode}`);
  }

  const items = await loadItems(db, rfqId);
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Every requested line must be quoted exactly once; a partial quote would make
  // the buyer's comparison and the later order conversion ambiguous.
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!itemById.has(line.rfqItemId)) {
      throw ApiError.validation([
        { field: 'lines.rfqItemId', message: `Unknown item: ${line.rfqItemId}`, code: 'ITEM_NOT_FOUND' },
      ]);
    }
    if (seen.has(line.rfqItemId)) {
      throw ApiError.validation([
        { field: 'lines.rfqItemId', message: 'Each item may be quoted once', code: 'DUPLICATE_ITEM' },
      ]);
    }
    seen.add(line.rfqItemId);
    const item = itemById.get(line.rfqItemId)!;
    if (!toDecimal(line.quantity).equals(toDecimal(item.quantity))) {
      throw ApiError.validation([
        {
          field: 'lines.quantity',
          message: `Quantity must equal the requested ${item.quantity}`,
          code: 'QUANTITY_MISMATCH',
        },
      ]);
    }
    assertPositive(line.unitPrice, 'lines.unitPrice');
  }
  const missing = items.filter((i) => !seen.has(i.id));
  if (missing.length > 0) {
    throw ApiError.validation([
      { field: 'lines', message: `Missing quote lines for ${missing.length} item(s)`, code: 'INCOMPLETE_QUOTE' },
    ]);
  }

  const previous = await db
    .select()
    .from(rfqQuotes)
    .where(and(eq(rfqQuotes.rfqId, rfqId), eq(rfqQuotes.sellerId, sellerId)))
    .orderBy(desc(rfqQuotes.revision))
    .limit(1);

  const nextRevision = (previous[0]?.revision ?? 0) + 1;
  if (nextRevision > access.rfq.maxRounds) {
    throw ApiError.conflict(`The negotiation is limited to ${access.rfq.maxRounds} rounds`);
  }

  // Totals are computed here and never taken from the request body.
  const lines = input.lines.map((line) => {
    const total = toDecimal(line.unitPrice).times(toDecimal(line.quantity));
    return {
      id: newId(),
      rfqItemId: line.rfqItemId,
      unitPrice: fmt(line.unitPrice),
      quantity: fmt(line.quantity),
      lineTotal: fmt(total),
    };
  });
  const itemsTotal = fmt(lines.reduce((sum, l) => sum.plus(toDecimal(l.lineTotal)), toDecimal(0)));

  const quoteId = newId();
  const now = new Date();
  const validUntil = new Date(now.getTime() + access.rfq.quoteValidityDays * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    const db2 = tx as unknown as DB;
    if (previous[0]) {
      await db2
        .update(rfqQuotes)
        .set({ quoteStatus: 'SUPERSEDED', updatedAt: now })
        .where(eq(rfqQuotes.id, previous[0].id));
    }
    await db2.insert(rfqQuotes).values({
      id: quoteId,
      rfqId,
      recipientId: access.recipient!.id,
      sellerId,
      sellerType: access.recipient!.sellerType,
      sellerUserId: userId,
      revision: nextRevision,
      quoteStatus: 'SUBMITTED',
      currencyCode: access.rfq.currencyCode,
      itemsTotal,
      leadTimeDays: input.leadTimeDays ?? null,
      paymentTerms: input.paymentTerms ?? null,
      notes: input.notes ?? null,
      validUntil,
      supersedesId: previous[0]?.id ?? null,
      submittedAt: now,
      updatedAt: now,
    });
    await db2.insert(rfqQuoteLines).values(lines.map((l) => ({ ...l, quoteId })));
    await db2
      .update(rfqRecipients)
      .set({ recipientStatus: 'QUOTED', respondedAt: now })
      .where(eq(rfqRecipients.id, access.recipient!.id));
    await recordEvent(db2, {
      rfqId,
      eventType: nextRevision === 1 ? 'QUOTE_SUBMITTED' : 'QUOTE_REVISED',
      actorUserId: userId,
      payload: { revision: nextRevision, itemsTotal, currencyCode: access.rfq.currencyCode },
      visibleToBuyer: true,
      visibleToSeller: true,
      sellerId,
    });
  });

  await createNotification(db, {
    userId: access.rfq.buyerUserId,
    type: 'RFQ_QUOTE_RECEIVED',
    title: nextRevision === 1 ? 'New quote received' : 'Quote revised',
    body: `A seller ${nextRevision === 1 ? 'quoted' : 'revised a quote'} on ${access.rfq.rfqNumber}.`,
    data: { rfqId, quoteId },
  });

  await writeAudit(db, ctx, {
    action: nextRevision === 1 ? 'RFQ.QUOTE_SUBMITTED' : 'RFQ.QUOTE_REVISED',
    entityType: 'RFQ_QUOTE',
    entityId: quoteId,
    after: { rfqId, sellerId, revision: nextRevision, itemsTotal, currencyCode: access.rfq.currencyCode },
  });

  return { quoteId, revision: nextRevision, itemsTotal };
}

/**
 * Lists quotes visible to the caller.
 *
 * The buyer sees the latest revision of every seller. A seller sees the latest
 * revision of its own quote only — this is the single most important filter in
 * the module, so it is expressed as a `where` on the query itself rather than a
 * post-filter that a future refactor could drop.
 */
export async function listQuotes(db: DB, userId: string, rfqId: string): Promise<QuoteView[]> {
  const access = await assertRfqAccess(db, rfqId, userId);
  const where =
    access.role === 'BUYER'
      ? and(eq(rfqQuotes.rfqId, rfqId), ne(rfqQuotes.quoteStatus, 'SUPERSEDED'))
      : and(
          eq(rfqQuotes.rfqId, rfqId),
          eq(rfqQuotes.sellerId, access.sellerId!),
          ne(rfqQuotes.quoteStatus, 'SUPERSEDED'),
        );

  const rows = await db.select().from(rfqQuotes).where(where).orderBy(desc(rfqQuotes.submittedAt));
  // Defensive: one latest row per seller even if a status transition failed.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = latest.get(row.sellerId);
    if (!current || row.revision > current.revision) latest.set(row.sellerId, row);
  }

  const views: QuoteView[] = [];
  for (const row of latest.values()) {
    const lines = await db
      .select({
        rfqItemId: rfqQuoteLines.rfqItemId,
        unitPrice: rfqQuoteLines.unitPrice,
        quantity: rfqQuoteLines.quantity,
        lineTotal: rfqQuoteLines.lineTotal,
      })
      .from(rfqQuoteLines)
      .where(eq(rfqQuoteLines.quoteId, row.id));
    views.push(toQuoteView(row, lines));
  }
  return views;
}

export interface TimelineEntry {
  id: string;
  eventType: string;
  actorType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** Timeline entries filtered by who may see them, not by who asked. */
export async function getTimeline(db: DB, userId: string, rfqId: string): Promise<TimelineEntry[]> {
  const access = await assertRfqAccess(db, rfqId, userId);
  const where =
    access.role === 'BUYER'
      ? and(eq(rfqEvents.rfqId, rfqId), eq(rfqEvents.visibleToBuyer, true))
      : and(
          eq(rfqEvents.rfqId, rfqId),
          eq(rfqEvents.visibleToSeller, true),
          sql`(${rfqEvents.sellerId} is null or ${rfqEvents.sellerId} = ${access.sellerId})`,
        );

  const rows = await db.select().from(rfqEvents).where(where).orderBy(rfqEvents.createdAt);
  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    actorType: row.actorType,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
