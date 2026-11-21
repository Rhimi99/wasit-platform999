export interface FieldError {
  field: string;
  message: string;
  code: string;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'MAX_LIMIT_EXCEEDED'
  | 'VALIDATION_FAILED'
  | 'EMAIL_NOT_VERIFIED'
  | 'PHONE_NOT_VERIFIED'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'MFA_REQUIRED'
  | 'INSUFFICIENT_STOCK'
  | 'PAYMENT_REQUIRED'
  | 'PRODUCT_NOT_ACTIVE'
  | 'ORDER_NOT_EDITABLE'
  | 'ADDRESS_INVALID'
  | 'INVALID_OPERATION'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'UNPROCESSABLE_ENTITY'
  | 'COMMISSION_POLICY_MISSING'
  | 'PROHIBITED_GOODS'
  | 'RESTRICTED_GOODS_REVIEW_REQUIRED'
  | 'LEGAL_ACCEPTANCE_REQUIRED'
  // AI-MEM-01 — agent memory policy refusals. Distinct codes so a client can
  // react (rephrase / prune / re-read) without parsing a message.
  | 'MEMORY_CONTENT_REFUSED'
  | 'MEMORY_LIMIT_REACHED'
  | 'MEMORY_INTEGRITY_FAILED'
  | 'MEMORY_REVISION_MISMATCH';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors?: FieldError[];
    /**
     * Safe, additive context the client needs to act on a specific error. Only
     * emitted for the error codes that opt in below — never for generic errors,
     * so this can never become an accidental channel for internal state.
     */
    details?: unknown;
    traceId?: string;
  };
}

export class ApiError extends Error {
  statusCode: number;
  code: ErrorCode;
  fieldErrors?: FieldError[];
  traceId?: string;
  details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options?: { fieldErrors?: FieldError[]; traceId?: string; details?: unknown },
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
    this.traceId = options?.traceId;
    this.details = options?.details;
  }

  static validation(fieldErrors: FieldError[], message = 'Validation failed'): ApiError {
    return new ApiError(422, 'VALIDATION_ERROR', message, { fieldErrors });
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(resource = 'Resource'): ApiError {
    return new ApiError(404, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(message = 'Conflict'): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }

  static tooManyRequests(message = 'Rate limit exceeded'): ApiError {
    return new ApiError(429, 'RATE_LIMITED', message);
  }

  /**
   * The request body exceeded the configured cap. Rejected before any handler
   * reads it, so an oversized payload cannot be buffered into memory by an
   * expensive route.
   */
  static payloadTooLarge(message = 'Request body too large'): ApiError {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
  }

  static serviceUnavailable(message = 'Service temporarily unavailable'): ApiError {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }

  /**
   * No active commission policy matched the transaction. WASIT never invents a
   * rate: the engine fails closed with an explicit configuration error instead of
   * applying a hidden percentage.
   */
  static commissionPolicyMissing(message = 'No matching commission policy is configured'): ApiError {
    return new ApiError(422, 'COMMISSION_POLICY_MISSING', message);
  }

  /**
   * A listing matched a prohibited-goods rule. Fails closed: the platform never
   * publishes the listing, and no review path can override it.
   */
  static prohibitedGoods(message = 'This listing is not permitted on the platform', details?: unknown): ApiError {
    return new ApiError(422, 'PROHIBITED_GOODS', message, { details });
  }

  /**
   * A listing matched a restricted-goods rule. It stays unpublished until a human
   * reviewer with the appropriate permission approves it; an automated agent can
   * never clear this gate.
   */
  static restrictedGoodsReviewRequired(message = 'This listing requires a compliance review before it can be published', details?: unknown): ApiError {
    return new ApiError(422, 'RESTRICTED_GOODS_REVIEW_REQUIRED', message, { details });
  }

  /**
   * A published, in-force legal document has not been accepted by this user.
   * Fails closed: the platform does not proceed until the caller accepts the
   * version currently in force. Inert until a document is actually published —
   * an unapproved draft is never demanded (see `lib/legal/catalogue.ts`).
   */
  static legalAcceptanceRequired(message = 'You must accept the current legal documents to continue', details?: unknown): ApiError {
    return new ApiError(403, 'LEGAL_ACCEPTANCE_REQUIRED', message, { details });
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.fieldErrors?.length) body.error.fieldErrors = this.fieldErrors;
    // Only the legal-acceptance code carries client-facing details today: the
    // `pending` list the SPA needs to route to the acceptance page. Scoped by
    // code on purpose, so no other error can start leaking `details` as a side
    // effect. The payload is built by `enforcement.ts` from the catalogue
    // (code/version/title only) — never a stack, secret or internal record.
    if (this.code === 'LEGAL_ACCEPTANCE_REQUIRED' && this.details !== undefined) {
      body.error.details = this.details;
    }
    if (this.traceId) body.error.traceId = this.traceId;
    return body;
  }
}