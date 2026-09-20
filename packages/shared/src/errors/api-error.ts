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
  | 'MAX_LIMIT_EXCEEDED'
  | 'VALIDATION_FAILED'
  | 'EMAIL_NOT_VERIFIED'
  | 'PHONE_NOT_VERIFIED'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'INSUFFICIENT_STOCK'
  | 'PAYMENT_REQUIRED'
  | 'PRODUCT_NOT_ACTIVE'
  | 'ORDER_NOT_EDITABLE'
  | 'ADDRESS_INVALID'
  | 'INVALID_OPERATION'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'UNPROCESSABLE_ENTITY'
  | 'COMMISSION_POLICY_MISSING';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors?: FieldError[];
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

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.fieldErrors?.length) body.error.fieldErrors = this.fieldErrors;
    if (this.traceId) body.error.traceId = this.traceId;
    return body;
  }
}