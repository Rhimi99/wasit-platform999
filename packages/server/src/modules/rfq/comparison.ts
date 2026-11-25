import type { DB } from '../../db/client';
import { and, eq, inArray } from 'drizzle-orm';
import { rfqQuoteLines, rfqQuotes, rfqs } from '../../db/schema/rfq';
import { toDecimal } from '../../lib/money';
import { assertRfqAccess, resolveSellerEntities, type SellerEntity } from './access';
import { expireLapsedQuotes, expireRfqIfDue } from './expiry';
import { quoteIsLive, rfqAcceptsQuotes } from './lifecycle';
import type {
  ComparisonExclusionReason,
  ComparisonExcludedView,
  ComparisonLineView,
  ComparisonRowView,
  QuoteComparisonView,
  RfqItemView,
} from './views';
import { loadRfqItems } from './service';
import { toItemView } from './views';

/**
 * B2B-01 phase 3 — offer comparison.
 *
 * This module reads. It never writes a quote, an RFQ, an order or a price list:
 * a comparison is a *view* of what the sellers already submitted, so a buyer
 * looking at it cannot change what it is looking at.
 *
 * The rules it enforces, in order of application:
 *  1. Access is participation (`assertRfqAccess`), re-derived on every request.
 *     A non-participant gets 404; a seller only ever sees its own offer, so the
 *     comparison cannot become a way to read competitors' prices.
 *  2. Only the newest revision per seller is considered. Older revisions are
 *     listed as excluded with reason SUPERSEDED, never compared.
 *  3. Only `SUBMITTED` quotes inside their validity window are comparable; a
 *     lapsed, withdrawn, rejected or accepted revision is excluded with its
 *     reason, not quietly ranked.
 *  4. Currencies are never mixed: a quote in a currency other than the RFQ's is
 *     excluded and never enters a min/max/average. (The submit path refuses it
 *     too; this is the defensive half of that rule for rows that predate it.)
 *  5. Once the RFQ itself is no longer OPEN (cancelled or expired), its quotes
 *     are shown as excluded with RFQ_NOT_OPEN — history stays readable, but no
 *     lapsed negotiation is presented as a live shortlist.
 */

const EXCLUDED_BY_STATUS: Record<string, ComparisonExclusionReason> = {
  EXPIRED: 'EXPIRED',
  WITHDRAWN: 'WITHDRAWN',
  REJECTED: 'REJECTED',
  ACCEPTED: 'ACCEPTED',
};

interface LoadedQuote {
  row: typeof rfqQuotes.$inferSelect;
  lines: Array<{ rfqItemId: string; unitPrice: string; quantity: string; lineTotal: string }>;
}

export async function compareQuotes(db: DB, userId: string, rfqId: string): Promise<QuoteComparisonView> {
  const access = await assertRfqAccess(db, rfqId, userId);

  // Expiry first: a comparison must not rank a quote that lapsed a second ago,
  // and the lazy path is the same guarded statement the sweep uses.
  const { rfq } = await expireRfqIfDue(db, access.rfq);
  await expireLapsedQuotes(db, rfq.id);

  const items = (await loadRfqItems(db, rfq.id)).map((row) => toItemView(row));

  // Buyer: every seller's newest revision. Seller: only its own — the filter is
  // in the query, so no later code path has to remember to apply it.
  const scope = access.role === 'BUYER' ? 'ALL' : 'OWN';
  const where =
    access.role === 'BUYER'
      ? eq(rfqQuotes.rfqId, rfq.id)
      : and(eq(rfqQuotes.rfqId, rfq.id), eq(rfqQuotes.sellerId, access.sellerId!));

  const allRows = await db.select().from(rfqQuotes).where(where).orderBy(rfqQuotes.revision);

  const latestBySeller = new Map<string, LoadedQuote>();
  for (const row of allRows) {
    const current = latestBySeller.get(row.sellerId);
    if (!current || row.revision > current.row.revision) {
      latestBySeller.set(row.sellerId, { row, lines: [] });
    }
  }

  const quoteIds = [...latestBySeller.values()].map((q) => q.row.id);
  if (quoteIds.length > 0) {
    const lines = await db
      .select({
        quoteId: rfqQuoteLines.quoteId,
        rfqItemId: rfqQuoteLines.rfqItemId,
        unitPrice: rfqQuoteLines.unitPrice,
        quantity: rfqQuoteLines.quantity,
        lineTotal: rfqQuoteLines.lineTotal,
      })
      .from(rfqQuoteLines)
      .where(inArray(rfqQuoteLines.quoteId, quoteIds));
    const byQuote = new Map<string, LoadedQuote['lines']>();
    for (const line of lines) {
      const bucket = byQuote.get(line.quoteId) ?? [];
      bucket.push({
        rfqItemId: line.rfqItemId,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
      });
      byQuote.set(line.quoteId, bucket);
    }
    for (const entry of latestBySeller.values()) {
      entry.lines = byQuote.get(entry.row.id) ?? [];
    }
  }

  const sellers = await resolveSellerEntities(
    db,
    [...latestBySeller.keys()],
  );
  const sellerById = new Map<string, SellerEntity>(sellers.map((s) => [s.id, s]));
  const sellerName = (sellerId: string): string => sellerById.get(sellerId)?.name ?? sellerId;

  const rfqOpen = rfqAcceptsQuotes(rfq) && rfq.status === 'OPEN';
  const itemById = new Map(items.map((i) => [i.id, i]));

  const rows: ComparisonRowView[] = [];
  const excluded: ComparisonExcludedView[] = [];

  // Older revisions are reported as excluded so the buyer can see that a seller
  // replied more than once, without those revisions entering any statistic.
  for (const row of allRows) {
    const latest = latestBySeller.get(row.sellerId);
    if (latest && row.id === latest.row.id) continue;
    excluded.push({
      quoteId: row.id,
      sellerId: row.sellerId,
      sellerName: sellerName(row.sellerId),
      revision: row.revision,
      status: row.quoteStatus,
      reason: 'SUPERSEDED',
    });
  }

  for (const { row, lines } of latestBySeller.values()) {
    const base = {
      quoteId: row.id,
      sellerId: row.sellerId,
      sellerName: sellerName(row.sellerId),
      revision: row.revision,
      status: row.quoteStatus,
    };

    const statusReason = EXCLUDED_BY_STATUS[row.quoteStatus];
    if (statusReason) {
      excluded.push({ ...base, reason: statusReason });
      continue;
    }
    if (!quoteIsLive(row, new Date())) {
      excluded.push({ ...base, reason: 'EXPIRED' });
      continue;
    }
    if (row.currencyCode !== rfq.currencyCode) {
      excluded.push({ ...base, reason: 'CURRENCY_MISMATCH' });
      continue;
    }
    if (!rfqOpen) {
      excluded.push({ ...base, reason: 'RFQ_NOT_OPEN' });
      continue;
    }

    rows.push({
      ...base,
      sellerType: row.sellerType,
      currencyCode: row.currencyCode,
      itemsTotal: row.itemsTotal,
      leadTimeDays: row.leadTimeDays,
      paymentTerms: row.paymentTerms,
      notes: row.notes,
      validUntil: row.validUntil.toISOString(),
      submittedAt: row.submittedAt.toISOString(),
      comparable: true,
      priceRank: null,
      lines: buildLines(lines, itemById),
    });
  }

  rows.sort(compareRows);
  rows.forEach((row, index) => {
    row.priceRank = index + 1;
  });

  const summary = buildSummary(rows, items, excluded);

  return {
    rfq: {
      id: rfq.id,
      rfqNumber: rfq.rfqNumber,
      title: rfq.title,
      currencyCode: rfq.currencyCode,
      status: rfq.status,
      neededBy: rfq.neededBy ? rfq.neededBy.toISOString() : null,
      expiresAt: rfq.expiresAt ? rfq.expiresAt.toISOString() : null,
      acceptsQuotes: rfqOpen,
    },
    scope,
    items,
    rows,
    excluded,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

/** Cheapest first, then the shorter lead time, then the earlier submission. */
function compareRows(a: ComparisonRowView, b: ComparisonRowView): number {
  const byTotal = toDecimal(a.itemsTotal).comparedTo(toDecimal(b.itemsTotal));
  if (byTotal !== 0) return byTotal;
  const leadA = a.leadTimeDays ?? Number.MAX_SAFE_INTEGER;
  const leadB = b.leadTimeDays ?? Number.MAX_SAFE_INTEGER;
  if (leadA !== leadB) return leadA - leadB;
  return a.submittedAt.localeCompare(b.submittedAt);
}

function buildLines(
  lines: LoadedQuote['lines'],
  itemById: Map<string, RfqItemView>,
): ComparisonLineView[] {
  return lines
    .map((line) => {
      const item = itemById.get(line.rfqItemId);
      const target = item?.targetPrice ?? null;
      return {
        rfqItemId: line.rfqItemId,
        itemName: item?.freeTextName ?? item?.productName ?? null,
        requestedQuantity: item?.quantity ?? line.quantity,
        quotedQuantity: line.quantity,
        unit: item?.unit ?? null,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        targetPrice: target,
        /** Negative means the seller is under the buyer's target, per unit. */
        targetDelta: target ? toDecimal(line.unitPrice).minus(toDecimal(target)).toFixed(4) : null,
      };
    })
    .sort((a, b) => (itemById.get(a.rfqItemId)?.position ?? 0) - (itemById.get(b.rfqItemId)?.position ?? 0));
}

function buildSummary(
  rows: ComparisonRowView[],
  items: RfqItemView[],
  excluded: ComparisonExcludedView[],
): QuoteComparisonView['summary'] {
  const totals = rows.map((r) => toDecimal(r.itemsTotal));
  const lowest = totals.length > 0 ? totals.reduce((min, v) => (v.lessThan(min) ? v : min)) : null;
  const highest = totals.length > 0 ? totals.reduce((max, v) => (v.greaterThan(max) ? v : max)) : null;
  const average =
    totals.length > 0
      ? totals.reduce((sum, v) => sum.plus(v), toDecimal(0)).div(totals.length)
      : null;

  const bestPriceRow = rows.find((r) => lowest !== null && toDecimal(r.itemsTotal).equals(lowest)) ?? null;
  const withLead = rows.filter((r) => r.leadTimeDays !== null);
  const fastest = withLead.length > 0
    ? withLead.reduce((best, r) => ((r.leadTimeDays as number) < (best.leadTimeDays as number) ? r : best))
    : null;

  const perItem = items.map((item) => {
    const priced = rows
      .map((row) => ({ row, line: row.lines.find((l) => l.rfqItemId === item.id) }))
      .filter((entry): entry is { row: ComparisonRowView; line: ComparisonLineView } => Boolean(entry.line));
    if (priced.length === 0) {
      return {
        rfqItemId: item.id,
        itemName: item.freeTextName ?? item.productName,
        requestedQuantity: item.quantity,
        lowestUnitPrice: null,
        lowestQuoteId: null,
        highestUnitPrice: null,
        averageUnitPrice: null,
      };
    }
    const prices = priced.map((entry) => toDecimal(entry.line.unitPrice));
    const low = prices.reduce((min, v) => (v.lessThan(min) ? v : min));
    const high = prices.reduce((max, v) => (v.greaterThan(max) ? v : max));
    const avg = prices.reduce((sum, v) => sum.plus(v), toDecimal(0)).div(prices.length);
    const lowEntry = priced.find((entry) => toDecimal(entry.line.unitPrice).equals(low))!;
    return {
      rfqItemId: item.id,
      itemName: item.freeTextName ?? item.productName,
      requestedQuantity: item.quantity,
      lowestUnitPrice: low.toFixed(4),
      lowestQuoteId: lowEntry.row.quoteId,
      highestUnitPrice: high.toFixed(4),
      averageUnitPrice: avg.toFixed(4),
    };
  });

  return {
    comparableQuotes: rows.length,
    lowestTotal: lowest ? lowest.toFixed(4) : null,
    highestTotal: highest ? highest.toFixed(4) : null,
    averageTotal: average ? average.toFixed(4) : null,
    bestPriceQuoteId: bestPriceRow?.quoteId ?? null,
    fastestLeadTimeDays: fastest?.leadTimeDays ?? null,
    fastestLeadTimeQuoteId: fastest?.quoteId ?? null,
    currencyMixed: excluded.some((e) => e.reason === 'CURRENCY_MISMATCH'),
    perItem,
  };
}
