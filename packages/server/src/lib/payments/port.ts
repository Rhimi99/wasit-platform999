/**
 * Payment provider port — the only surface the payment service depends on.
 * Concrete vendors (Stripe, Paymee, Flouci, …) implement this interface and are
 * resolved by `resolvePaymentProvider()`. Nothing vendor-specific may leak
 * beyond this directory.
 */

/** Coarse method family a payer chooses. */
export type PaymentMethodType = 'CARD' | 'MOBILE_WALLET';

/** Specific rail within a method family (card scheme, or wallet brand). */
export type PaymentScheme =
  | 'VISA'
  | 'MASTERCARD'
  | 'CIB'
  | 'D17'
  | 'FLOUCI_WALLET';

export interface PaymentMethod {
  type: PaymentMethodType;
  /** Optional scheme narrowing (e.g. a card network or a wallet brand). */
  scheme?: PaymentScheme;
}

/** A method a provider can accept, with availability so the UI can hide/reason. */
export interface ProviderCapability {
  method: PaymentMethod;
  /** True when this method can actually be used right now (credentials + account). */
  available: boolean;
  /** Human-readable reason when `available` is false. Never contains secrets. */
  reason?: string;
}

export interface CreateIntentInput {
  /** WASIT order id — sent to the provider as metadata for reconciliation. */
  orderId: string;
  amount: string;
  currencyCode: string;
  /** WASIT-controlled idempotency key; the provider must not double-charge on retry. */
  idempotencyKey: string;
  description?: string;
  /** Payer-selected method; providers that expose a single rail may ignore it. */
  method?: PaymentMethod;
  /** Absolute URLs the provider should redirect to (hosted checkout providers). */
  successUrl?: string;
  failUrl?: string;
  /** Absolute provider-to-server callback URL. */
  webhookUrl?: string;
}

export interface CreateIntentResult {
  externalRef: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  /** Provider-hosted checkout URL when the provider requires a redirect. */
  checkoutUrl: string | null;
  raw?: Record<string, unknown>;
}

export interface RefundInput {
  externalRef: string;
  amount: string;
  currencyCode: string;
  idempotencyKey: string;
  reason?: string;
}

export interface RefundResult {
  externalRef: string;
  status: 'SUCCEEDED' | 'FAILED';
  raw?: Record<string, unknown>;
}

/** Result of a provider status re-check, used when a webhook has no signature. */
export interface ProviderStatus {
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  externalRef: string;
  amount: string | null;
  currencyCode: string | null;
  /** Settlement lifecycle, when the provider exposes one. */
  settlementStatus?: string | null;
  raw?: Record<string, unknown>;
}

export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'REFUND_SUCCEEDED' | 'UNKNOWN';
  externalRef: string | null;
  amount: string | null;
  currencyCode: string | null;
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly id: string;
  /** Whether the provider is configured and can be called. */
  isAvailable(): boolean;
  /** True when the provider implements charge creation/refunds (vs. a wiring harness). */
  readonly isFunctional: boolean;
  /**
   * When true, a webhook is NOT trusted on its own: the service re-checks the
   * transaction status directly with the provider before applying side-effects.
   * Required for providers (e.g. Flouci) that document no webhook signature.
   */
  readonly requiresStatusRecheck?: boolean;
  /** The methods this provider can accept, and whether each is usable now. */
  supportedMethods(): ProviderCapability[];
  createIntent(input: CreateIntentInput): Promise<CreateIntentResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Direct status lookup used by `requiresStatusRecheck` providers. */
  getStatus?(externalRef: string): Promise<ProviderStatus>;
  /** Verifies the webhook signature and normalizes the payload. Throws on invalid signature. */
  verifyAndNormalizeWebhook(rawBody: string, signature: string | undefined): NormalizedWebhookEvent;
}