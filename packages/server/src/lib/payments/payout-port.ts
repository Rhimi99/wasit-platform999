/**
 * Payout provider port — the only surface the payout service depends on for
 * actually *moving* the seller's money.
 *
 * Boundary this port exists to enforce:
 *
 *   Payout Engine (source of truth for status)
 *     → PayoutProvider (this file: asks an external rail to move funds)
 *       → bank / licensed payout provider / external service
 *
 * The provider is NOT the source of truth for `COMPLETED`. It may only report
 * events; those events are fed to `applyPayoutEvent`, which decides the
 * transition and refuses `COMPLETED` without a transfer reference and an exact
 * amount/currency match. A provider that claims success cannot, by itself, make
 * a payout COMPLETED — it can only supply the evidence the engine demands.
 *
 * Nothing vendor-specific may leak beyond this directory, and no adapter here
 * represents a real bank or licensed provider: those must be implemented against
 * this interface by a real integration.
 */

/** What a payout rail can prove it is able to do. */
export interface PayoutProviderCapabilities {
  /** Can open a payout and return a provider-side reference. */
  readonly createPayout: boolean;
  /** Can report a transfer reference proving the funds left. */
  readonly transferReference: boolean;
  /** Can cancel a payout that has not yet been executed. */
  readonly cancel: boolean;
  /** Can be queried for the current status of a payout. */
  readonly statusQuery: boolean;
  /**
   * A demonstration/offline harness rather than a licensed payout rail. A demo
   * provider can never be proof that money moved, so it is refused on any
   * environment that is not itself a demo.
   */
  readonly demo: boolean;
}

export interface CreatePayoutRequest {
  /** WASIT payout id — sent as metadata so the rail can reconcile it back. */
  payoutId: string;
  /** WASIT order id the payout settles. */
  orderId: string;
  /** Net amount owed to the seller. */
  amount: string;
  currencyCode: string;
  /** Seller/beneficiary identifier as known to the rail (opaque to WASIT). */
  beneficiaryRef: string;
  /** WASIT-controlled idempotency key; the rail must not double-pay on retry. */
  idempotencyKey: string;
  description?: string;
}

/** Normalized outcome of a create request. */
export interface CreatePayoutResult {
  /** Rail-side reference for the payout (not a proof of transfer). */
  providerRef: string;
  /**
   * The rail's own view at creation time. `PROCESSING` is the honest default for
   * an asynchronous rail: creation is a request, not a transfer.
   */
  status: 'PROCESSING' | 'FAILED';
  /** Reason when `status` is FAILED. Never contains secrets. */
  failureReason?: string | null;
  raw?: Record<string, unknown>;
}

/** A normalized payout event as reported by the rail. */
export interface PayoutProviderEvent {
  /** The rail's event id, used for idempotent ingestion. */
  eventId: string;
  type: 'payout.processing' | 'payout.completed' | 'payout.failed' | 'payout.held';
  providerRef?: string | null;
  /**
   * Transfer reference proving the funds moved. Required by the engine for a
   * completion — a provider that cannot supply one cannot complete a payout.
   */
  payoutRef?: string | null;
  amount?: string | null;
  currencyCode?: string | null;
  reason?: string | null;
  occurredAt?: string | null;
  raw: Record<string, unknown>;
}

/** Result of a status re-check with the rail. */
export interface PayoutProviderStatus {
  providerRef: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'HELD' | 'UNKNOWN';
  payoutRef: string | null;
  amount: string | null;
  currencyCode: string | null;
  raw?: Record<string, unknown>;
}

export interface CancelPayoutResult {
  providerRef: string;
  cancelled: boolean;
  reason?: string | null;
  raw?: Record<string, unknown>;
}

export interface PayoutProvider {
  readonly id: string;
  /** Whether the provider is configured and callable. */
  isAvailable(): boolean;
  readonly capabilities: PayoutProviderCapabilities;
  /**
   * Whether this adapter is a real, licensed payout rail. Adapters that are not
   * functional (structural/general-purpose only) must return false and will be
   * refused by the service rather than silently "succeeding".
   */
  readonly isFunctional: boolean;
  /** Asks the rail to open a payout. Does NOT complete it. */
  createPayout(input: CreatePayoutRequest): Promise<CreatePayoutResult>;
  /** Re-checks a payout's status directly with the rail. */
  getPayoutStatus(providerRef: string): Promise<PayoutProviderStatus>;
  /** Cancels a payout that has not yet executed. */
  cancelPayout?(providerRef: string): Promise<CancelPayoutResult>;
  /**
   * Normalizes a rail callback into a provider event. Implementations that
   * cannot verify authenticity must throw rather than accept the payload.
   */
  verifyAndNormalizeEvent?(rawBody: string, signature: string | undefined): PayoutProviderEvent;
}
