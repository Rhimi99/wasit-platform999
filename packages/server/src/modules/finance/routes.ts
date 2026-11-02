import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, PERMISSIONS } from '@wasit/shared';
import { requirePermission } from '../../middleware/auth';
import { validateBody, validateQuery, getValidatedBody, getValidatedQuery } from '../../middleware/validate';
import { getContext } from '../../lib/request-context';
import { confirmSettlement } from '../settlements/service';
import { createPayout, getPayout, listPayouts } from '../payouts/service';
import { dispatchPayoutToProvider, syncPayoutFromProvider } from '../payouts/provider-service';
import { describePayoutProviders } from '../../lib/payments/payout-resolve';
import { importReconciliationFeed, importReconciliationFile, previewReconciliationFile } from '../reconciliation/service';
import { recordReceipt } from '../reconciliation/receipt-service';
import { RECON_FILE_LIMITS } from '../reconciliation/file-import';

/** Slack allowed on the multipart envelope (boundaries, part headers) over the file itself. */
const MULTIPART_OVERHEAD_BYTES = 8 * 1024;

/**
 * P3 — HTTP surface for the money-movement layers (settlement, payout,
 * reconciliation).
 *
 * These routes add NO new business rules: each one validates input, enforces the
 * existing permission, then calls the same service the platform already trusts.
 * The services remain the only writers of `SETTLED`, `COMPLETED` and receipt
 * rows, so exposing them over HTTP cannot bypass an invariant.
 *
 * Permission choice is deliberate: these are money-movement operations, so they
 * reuse `payment:read` / `commission:manage` rather than inventing new
 * permissions that no role currently holds.
 */

const settlementSchema = z.object({
  externalRef: z.string().min(1),
  amount: z.string().min(1),
  currencyCode: z.string().length(3),
  providerId: z.string().min(1),
  settlementRef: z.string().min(1),
  providerRef: z.string().nullish(),
  occurredAt: z.string().nullish(),
});

const payoutSchema = z.object({
  transactionId: z.string().min(1),
  providerId: z.string().min(1),
  idempotencyKey: z.string().nullish(),
});

const listPayoutsQuerySchema = z.object({
  status: z.enum(['CREATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'HELD']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const dispatchSchema = z.object({
  beneficiaryRef: z.string().min(1),
  providerId: z.string().min(1).optional(),
});

const feedSchema = z.object({
  source: z.enum(['PROVIDER', 'BANK']),
  currencyCode: z.string().length(3),
  importKey: z.string().nullish(),
  providerId: z.string().nullish(),
  provider: z
    .array(
      z.object({
        reference: z.string().min(1),
        settlementRef: z.string().nullish(),
        payoutRef: z.string().nullish(),
        grossAmount: z.string().min(1),
        providerFee: z.string().min(1),
        netAmount: z.string().min(1),
        currencyCode: z.string().length(3),
        occurredAt: z.string().nullish(),
      }),
    )
    .default([]),
  bank: z
    .array(
      z.object({
        reference: z.string().min(1),
        settlementRef: z.string().nullish(),
        payoutRef: z.string().nullish(),
        amount: z.string().min(1),
        currencyCode: z.string().length(3),
        occurredAt: z.string().nullish(),
      }),
    )
    .default([]),
  ledger: z
    .array(
      z.object({
        reference: z.string().min(1),
        grossAmount: z.string().min(1),
        providerFee: z.string().min(1),
        netAmount: z.string().min(1),
        currencyCode: z.string().length(3),
        settled: z.boolean(),
      }),
    )
    .default([]),
});

const receiptSchema = z.object({
  transactionId: z.string().min(1),
  evidence: z.object({
    source: z.enum(['BANK_STATEMENT', 'ACQUIRER', 'PROVIDER']),
    reference: z.string().min(1),
    amount: z.string().min(1),
    currencyCode: z.string().length(3),
  }),
});

/** Parses an optional ISO timestamp into a Date, ignoring an unparseable value. */
function isoOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const financeRoutes = new Hono();

/**
 * Confirms settlement from provider evidence. Returns the service's own result
 * so the caller can see whether the settlement was applied or was a duplicate.
 */
financeRoutes.post(
  '/settlements/confirm',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  validateBody(settlementSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof settlementSchema>>(c);
    const ctx = getContext(c);
    const result = await confirmSettlement(ctx.db, {
      externalRef: body.externalRef,
      amount: body.amount,
      currencyCode: body.currencyCode,
      providerId: body.providerId,
      settlementRef: body.settlementRef,
      providerRef: body.providerRef ?? null,
      occurredAt: isoOrNull(body.occurredAt),
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Lists the configured payout rails and what each can prove. */
financeRoutes.get(
  '/payout-providers',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  (c) => c.json({ success: true, data: describePayoutProviders() }),
);

/** Creates the seller payout for a settled transaction. Amount is derived, never supplied. */
financeRoutes.post(
  '/payouts',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(payoutSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof payoutSchema>>(c);
    const ctx = getContext(c);
    const payout = await createPayout(ctx.db, {
      transactionId: body.transactionId,
      providerId: body.providerId,
      idempotencyKey: body.idempotencyKey ?? null,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: payout });
  },
);

/**
 * Lists payouts for the admin desk (newest first, bounded page size). Read-only:
 * it projects the stored rows and never advances a payout's status.
 * Declared before `/payouts/:id` so the collection path is never read as an id.
 */
financeRoutes.get(
  '/payouts',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  validateQuery(listPayoutsQuerySchema),
  async (c) => {
    const query = getValidatedQuery<z.infer<typeof listPayoutsQuerySchema>>(c);
    const ctx = getContext(c);
    const result = await listPayouts(ctx.db, {
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
    return c.json({ success: true, data: result });
  },
);

financeRoutes.get(
  '/payouts/:id',
  requirePermission(PERMISSIONS.PAYMENT_READ, PERMISSIONS.COMMISSION_MANAGE),
  async (c) => {
    const ctx = getContext(c);
    const payout = await getPayout(ctx.db, c.req.param('id')!);
    return c.json({ success: true, data: payout });
  },
);

/** Dispatches a CREATED payout to its rail. Can only reach PROCESSING. */
financeRoutes.post(
  '/payouts/:id/dispatch',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(dispatchSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof dispatchSchema>>(c);
    const ctx = getContext(c);
    const result = await dispatchPayoutToProvider(ctx.db, {
      payoutId: c.req.param('id')!,
      beneficiaryRef: body.beneficiaryRef,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/**
 * Re-checks a payout with the rail. Completion still requires the rail's
 * transfer reference and an exact amount/currency match, so this route cannot
 * force a payout to COMPLETED.
 */
financeRoutes.post(
  '/payouts/:id/sync',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  async (c) => {
    const ctx = getContext(c);
    const result = await syncPayoutFromProvider(ctx.db, {
      payoutId: c.req.param('id')!,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Imports a provider/bank reconciliation feed and returns the match report. */
financeRoutes.post(
  '/reconciliation/import',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(feedSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof feedSchema>>(c);
    const ctx = getContext(c);
    const result = await importReconciliationFeed(ctx.db, {
      source: body.source,
      currencyCode: body.currencyCode,
      importKey: body.importKey ?? null,
      providerId: body.providerId ?? null,
      provider: body.provider,
      bank: body.bank,
      ledger: body.ledger,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/**
 * Reads the single uploaded statement from a multipart body. Only the external
 * evidence (provider/bank) is accepted; the ledger side is internal and can never
 * come from a file. Rejects a missing/oversized/duplicate file with a clear error.
 */
async function readUploadedFile(c: Context): Promise<{ filename: string; bytes: Uint8Array }> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw ApiError.validation([{ field: 'file', message: 'Expected a multipart/form-data upload', code: 'INVALID_CONTENT_TYPE' }]);
  }
  // Reject an oversized upload before buffering it. The parser re-checks the real
  // decoded size, so a missing/forged content-length is still caught there.
  const declared = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declared) && declared > RECON_FILE_LIMITS.maxBytes + MULTIPART_OVERHEAD_BYTES) {
    throw ApiError.validation([{ field: 'file', message: 'Uploaded file is too large', code: 'FILE_TOO_LARGE' }]);
  }
  let body: Record<string, string | File>;
  try {
    body = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    throw ApiError.validation([{ field: 'file', message: 'Malformed multipart body', code: 'MALFORMED_FILE' }]);
  }
  const file = body['file'];
  if (!(file instanceof File)) {
    throw ApiError.validation([{ field: 'file', message: 'Attach a file under the "file" field', code: 'REQUIRED' }]);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { filename: file.name, bytes };
}

/** Validates an uploaded statement and returns the match report WITHOUT writing. */
financeRoutes.post(
  '/reconciliation/preview-file',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  async (c) => {
    const { filename, bytes } = await readUploadedFile(c);
    const source = c.req.query('source');
    const currencyCode = c.req.query('currencyCode') ?? '';
    const sourceSchema = z.enum(['PROVIDER', 'BANK']);
    const parsedSource = sourceSchema.safeParse(source);
    if (!parsedSource.success) {
      throw ApiError.validation([{ field: 'source', message: 'source must be PROVIDER or BANK', code: 'VALIDATION_FAILED' }]);
    }
    const ctx = getContext(c);
    const result = await previewReconciliationFile(ctx.db, {
      filename,
      bytes,
      source: parsedSource.data,
      currencyCode,
    });
    return c.json({ success: true, data: result });
  },
);

/** Imports an uploaded statement through the shared reconciliation service. */
financeRoutes.post(
  '/reconciliation/import-file',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  async (c) => {
    const { filename, bytes } = await readUploadedFile(c);
    const sourceSchema = z.enum(['PROVIDER', 'BANK']);
    const parsedSource = sourceSchema.safeParse(c.req.query('source'));
    if (!parsedSource.success) {
      throw ApiError.validation([{ field: 'source', message: 'source must be PROVIDER or BANK', code: 'VALIDATION_FAILED' }]);
    }
    const ctx = getContext(c);
    const result = await importReconciliationFile(ctx.db, {
      filename,
      bytes,
      source: parsedSource.data,
      currencyCode: c.req.query('currencyCode') ?? '',
      importKey: c.req.query('importKey') ?? null,
      providerId: c.req.query('providerId') ?? null,
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);

/** Records that WASIT's commission funds actually landed. */
financeRoutes.post(
  '/receipts',
  requirePermission(PERMISSIONS.COMMISSION_MANAGE, PERMISSIONS.PAYMENT_READ),
  validateBody(receiptSchema),
  async (c) => {
    const body = getValidatedBody<z.infer<typeof receiptSchema>>(c);
    const ctx = getContext(c);
    const result = await recordReceipt(ctx.db, {
      transactionId: body.transactionId,
      evidence: {
        source: body.evidence.source,
        reference: body.evidence.reference,
        amount: body.evidence.amount,
        currencyCode: body.evidence.currencyCode,
      },
      actorId: ctx.user?.id ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return c.json({ success: true, data: result });
  },
);
