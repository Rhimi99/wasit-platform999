import type { Context, Next } from 'hono';
import type { ZodSchema } from 'zod';
import { ApiError } from '@wasit/shared';

export function validateBody(schema: ZodSchema) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      throw ApiError.validation([{ field: 'body', message: 'Invalid JSON body', code: 'VALIDATION_FAILED' }]);
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
        code: issue.code,
      }));
      throw ApiError.validation(fieldErrors);
    }
    c.set('validatedBody', result.data as never);
    return next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const qs = c.req.query();
    const result = schema.safeParse(qs);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      throw ApiError.validation(fieldErrors);
    }
    c.set('validatedQuery', result.data as never);
    return next();
  };
}

export function getValidatedBody<T>(c: Context): T {
  return c.get('validatedBody') as T;
}

export function getValidatedQuery<T>(c: Context): T {
  return c.get('validatedQuery') as T;
}