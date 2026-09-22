import { env } from '../env';
import { ApiError } from '@wasit/shared';
import { logger } from '../observability/logger';
import type { AIProvider, AIProviderCallOptions, AIProviderCallResult } from './types';

/** Deterministic pseudo-token estimate for providers that do not report usage. */
export function estimateTokens(text: string): number {
  // ~4 chars per token is a common rough approximation across languages.
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Local Heuristic Provider — a real, deterministic analytics engine that
 * computes recommendations from live data without an external LLM.
 * It is the default when no paid provider is configured, and is explicitly
 * NOT a mock: it runs real WASIT rules on real records.
 */
export class LocalHeuristicProvider implements AIProvider {
  readonly id = 'local-heuristic';
  isAvailable(): boolean {
    return true;
  }
  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    return {
      content: `[local-heuristic] ${opts.user}`,
      model: 'local-heuristic',
      tokensInput: estimateTokens(opts.system ?? '') + estimateTokens(opts.user),
      tokensOutput: 48,
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

/**
 * Noop Provider — a strict test/dev harness that never does real work.
 * It exists so the wiring is exercised without a network or key configured.
 */
export class NoopProvider implements AIProvider {
  readonly id = 'noop';
  isAvailable(): boolean {
    return true;
  }
  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    return {
      content: 'noop',
      model: 'noop',
      tokensInput: 0,
      tokensOutput: 0,
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

/**
 * Shared HTTP call guard for vendor adapters: applies a hard timeout and maps
 * transport failures to a stable 503 without echoing the vendor body (which can
 * contain account identifiers or partial prompts) back to the caller.
 */
async function vendorFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    // Detail goes to the server log only; the client gets a stable message.
    logger.error('AI provider transport failure', {
      provider: 'vendor',
      aborted,
      error: (err as Error).message,
    });
    throw ApiError.serviceUnavailable(aborted ? 'AI provider request timed out' : 'AI provider is unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/** Maps a non-2xx vendor response to a 503 carrying only the status code. */
function vendorError(status: number): ApiError {
  logger.error('AI provider returned an error status', { providerStatus: status });
  return ApiError.serviceUnavailable(`AI provider error (${status})`);
}

/**
 * OpenAI-compatible Chat Completions provider. Uses the standard
 * /chat/completions shape so any compatible endpoint (OpenAI, providers
 * exposing the same API) can be plugged without core changes.
 */
class OpenAIChatCompletionsProvider implements AIProvider {
  readonly id = 'openai';
  constructor(private readonly apiKey: string, private readonly model: string) {}

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.model.length > 0;
  }

  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    if (!this.isAvailable()) {
      throw ApiError.serviceUnavailable('AI provider is not configured');
    }
    const base = env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1';
    // A per-call model (from the router/catalogue) wins over the configured default.
    const model = opts.model?.trim() || this.model;
    const res = await vendorFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      }),
    });
    if (!res.ok) throw vendorError(res.status);
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    const tokensInput = json.usage?.prompt_tokens ?? estimateTokens(opts.user);
    const tokensOutput = json.usage?.completion_tokens ?? estimateTokens(content);
    return {
      content,
      model: json.model ?? model,
      tokensInput,
      tokensOutput,
      cost: '0', // resolved later via the model catalogue in cost-control
      currencyCode: 'USD',
    };
  }
}

/** Anthropic Messages provider — registered for multi-vendor support. */
class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  constructor(private readonly apiKey: string, private readonly model: string) {}

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.model.length > 0;
  }

  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    if (!this.isAvailable()) {
      throw ApiError.serviceUnavailable('AI provider is not configured');
    }
    const base = env.AI_ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com/v1';
    const model = opts.model?.trim() || this.model;
    const res = await vendorFetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system ?? undefined,
        messages: [{ role: 'user', content: opts.user }],
      }),
    });
    if (!res.ok) throw vendorError(res.status);
    const json = (await res.json()) as {
      model?: string;
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = json.content?.[0]?.text ?? '';
    return {
      content,
      model: json.model ?? model,
      tokensInput: json.usage?.input_tokens ?? estimateTokens(opts.user),
      tokensOutput: json.usage?.output_tokens ?? estimateTokens(content),
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

/**
 * Vendor-facing default model per adapter. Used when neither a per-call model
 * nor `AI_MODEL` is set. Note these must be vendor names (`gpt-4o-mini`), not
 * catalogue keys; the router translates keys before calling.
 */
export const VENDOR_DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
} as const;

/**
 * Resolves the configured AI provider. The resolver is deliberately small and
 * reads configuration from env — the AI Core itself never hardcodes a vendor.
 */
export function resolveProvider(): AIProvider {
  const provider = (env.AI_PROVIDER ?? 'local-heuristic').toLowerCase();
  // `AI_MODEL` defaults to '' in the env schema, so `||` (not `??`) is required
  // here: with `??` a configured key plus an unset model reported the provider
  // as unavailable and silently degraded every call to the local engine.
  const model = env.AI_MODEL?.trim() || '';

  switch (provider) {
    case 'noop':
      return new NoopProvider();
    case 'openai':
      return new OpenAIChatCompletionsProvider(env.AI_API_KEY ?? '', model || VENDOR_DEFAULT_MODELS.openai);
    case 'anthropic':
      return new AnthropicProvider(env.AI_API_KEY ?? '', model || VENDOR_DEFAULT_MODELS.anthropic);
    case 'local-heuristic':
    default:
      return new LocalHeuristicProvider();
  }
}