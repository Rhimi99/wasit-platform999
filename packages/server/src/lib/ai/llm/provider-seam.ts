import { env } from '../../env';
import type { AIProvider } from '../types';

/**
 * Test-only seam for the generation path.
 *
 * A scripted provider is how the *pipeline* is proven without a vendor key: the
 * real service still sanitises input, enforces limits, calls the runtime, parses
 * the answer and grounds it — only the transport is replaced. It is the same
 * pattern as `setRateLimitStore`, and it is refused in production so no runtime
 * path can ever inject a provider there.
 */
let override: AIProvider | null = null;

export function setLlmProviderOverride(provider: AIProvider | null): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('LLM provider override is not available in production');
  }
  override = provider;
}

export function getLlmProviderOverride(): AIProvider | null {
  if (env.NODE_ENV === 'production') return null;
  return override;
}
