import type { RfqQuoteRow, RfqRecipientRow, RfqRow, SellerEntity } from './access';

/**
 * Response projections for the RFQ API.
 *
 * These are the only shapes that leave the server, and they are built by naming
 * each field — never by spreading a row. A row carries `buyer_user_id`,
 * `seller_user_id` and (on the entity tables) contact data; a spread would ship
 * all of it. Keeping the projection explicit is what makes "no user id, no
 * email, no phone" a property of the code rather than of a reviewer's attention.
 */

export interface RfqItemView {
  id: string;
  productId: string | null;
  freeTextName: string | null;
  quantity: string;
  unit: string | null;
  targetPrice: string | null;
  position: number;
}

export interface CompanyCardView {
  id: string;
  legalName: string;
  slug: string;
  verified: boolean;
}

export interface RecipientView {
  sellerId: string;
  sellerType: string;
  sellerName: string;
  status: string;
  invitedAt: string;
  viewedAt: string | null;
  respondedAt: string | null;
  /** Why the seller declined — the seller's own words, never a contact detail. */
  declinedAt: string | null;
  declineReason: string | null;
}

export interface QuoteView {
  id: string;
  sellerId: string;
  sellerType: string;
  revision: number;
  status: string;
  currencyCode: string;
  itemsTotal: string;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  notes: string | null;
  validUntil: string;
  submittedAt: string;
  decidedAt: string | null;
  /** Buyer's recorded reason, when this revision was rejected. */
  decisionReason: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  expiredAt: string | null;
  lines: Array<{
    rfqItemId: string;
    unitPrice: string;
    quantity: string;
    lineTotal: string;
  }>;
}

export interface BuyerRfqView {
  id: string;
  rfqNumber: string;
  title: string;
  description: string | null;
  currencyCode: string;
  status: string;
  neededBy: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  awardedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  company: CompanyCardView;
  items: RfqItemView[];
  recipients: RecipientView[];
  quoteCount: number;
}

export interface SellerRfqView {
  id: string;
  rfqNumber: string;
  title: string;
  description: string | null;
  currencyCode: string;
  status: string;
  neededBy: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  createdAt: string;
  buyer: CompanyCardView;
  items: RfqItemView[];
  myInvitation: {
    sellerId: string;
    status: string;
    invitedAt: string;
    viewedAt: string | null;
    respondedAt: string | null;
    declinedAt: string | null;
    declineReason: string | null;
  };
}

export type RfqView = BuyerRfqView | SellerRfqView;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function toItemView(row: {
  id: string;
  productId: string | null;
  freeTextName: string | null;
  quantity: string;
  unit: string | null;
  targetPrice: string | null;
  position: number;
}): RfqItemView {
  return {
    id: row.id,
    productId: row.productId,
    freeTextName: row.freeTextName,
    quantity: row.quantity,
    unit: row.unit,
    targetPrice: row.targetPrice,
    position: row.position,
  };
}

export function toQuoteView(
  row: RfqQuoteRow,
  lines: Array<{ rfqItemId: string; unitPrice: string; quantity: string; lineTotal: string }>,
): QuoteView {
  return {
    id: row.id,
    sellerId: row.sellerId,
    sellerType: row.sellerType,
    revision: row.revision,
    status: row.quoteStatus,
    currencyCode: row.currencyCode,
    itemsTotal: row.itemsTotal,
    leadTimeDays: row.leadTimeDays,
    paymentTerms: row.paymentTerms,
    notes: row.notes,
    validUntil: row.validUntil.toISOString(),
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decisionReason: row.decisionReason,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawalReason: row.withdrawalReason,
    expiredAt: iso(row.expiredAt),
    lines: lines.map((l) => ({
      rfqItemId: l.rfqItemId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
    })),
  };
}

export function toBuyerRfqView(input: {
  rfq: RfqRow;
  company: CompanyCardView;
  items: RfqItemView[];
  recipients: Array<{ recipient: RfqRecipientRow; seller: SellerEntity | undefined }>;
  quoteCount: number;
}): BuyerRfqView {
  return {
    id: input.rfq.id,
    rfqNumber: input.rfq.rfqNumber,
    title: input.rfq.title,
    description: input.rfq.description,
    currencyCode: input.rfq.currencyCode,
    status: input.rfq.status,
    neededBy: iso(input.rfq.neededBy),
    expiresAt: iso(input.rfq.expiresAt),
    sentAt: iso(input.rfq.sentAt),
    awardedAt: iso(input.rfq.awardedAt),
    cancelledAt: iso(input.rfq.cancelledAt),
    createdAt: input.rfq.createdAt.toISOString(),
    company: input.company,
    items: input.items,
    recipients: input.recipients.map(({ recipient, seller }) => ({
      sellerId: recipient.sellerId,
      sellerType: recipient.sellerType,
      // A seller removed from the entity tables still shows as an opaque id.
      sellerName: seller?.name ?? recipient.sellerId,
      status: recipient.recipientStatus,
      invitedAt: recipient.invitedAt.toISOString(),
      viewedAt: iso(recipient.viewedAt),
      respondedAt: iso(recipient.respondedAt),
      declinedAt: iso(recipient.declinedAt),
      declineReason: recipient.declineReason,
    })),
    quoteCount: input.quoteCount,
  };
}

export function toSellerRfqView(input: {
  rfq: RfqRow;
  buyer: CompanyCardView;
  items: RfqItemView[];
  recipient: RfqRecipientRow;
}): SellerRfqView {
  return {
    id: input.rfq.id,
    rfqNumber: input.rfq.rfqNumber,
    title: input.rfq.title,
    description: input.rfq.description,
    currencyCode: input.rfq.currencyCode,
    status: input.rfq.status,
    neededBy: iso(input.rfq.neededBy),
    expiresAt: iso(input.rfq.expiresAt),
    sentAt: iso(input.rfq.sentAt),
    createdAt: input.rfq.createdAt.toISOString(),
    buyer: input.buyer,
    items: input.items,
    myInvitation: {
      sellerId: input.recipient.sellerId,
      status: input.recipient.recipientStatus,
      invitedAt: input.recipient.invitedAt.toISOString(),
      viewedAt: iso(input.recipient.viewedAt),
      respondedAt: iso(input.recipient.respondedAt),
      declinedAt: iso(input.recipient.declinedAt),
      declineReason: input.recipient.declineReason,
    },
  };
}
