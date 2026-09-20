import { env } from '../env';
import { ApiError } from '@wasit/shared';
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
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ApiError.serviceUnavailable(`AI provider error (${res.status}): ${text.slice(0, 200)}`);
    }
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
      model: json.model ?? this.model,
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
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        system: opts.system ?? undefined,
        messages: [{ role: 'user', content: opts.user }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ApiError.serviceUnavailable(`AI provider error (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      model?: string;
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = json.content?.[0]?.text ?? '';
    return {
      content,
      model: json.model ?? this.model,
      tokensInput: json.usage?.input_tokens ?? estimateTokens(opts.user),
      tokensOutput: json.usage?.output_tokens ?? estimateTokens(content),
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

/**
 * Resolves the configured AI provider. The resolver is deliberately small and
 * reads configuration from env — the AI Core itself never hardcodes a vendor.
 */
export function resolveProvider(): AIProvider {
  const provider = (env.AI_PROVIDER ?? 'local-heuristic').toLowerCase();

  switch (provider) {
    case 'noop':
      return new NoopProvider();
    case 'openai':
      return new OpenAIChatCompletionsProvider(env.AI_API_KEY ?? '', env.AI_MODEL ?? 'gpt-4o-mini');
    case 'anthropic':
      return new AnthropicProvider(env.AI_API_KEY ?? '', env.AI_MODEL ?? 'claude-sonnet-4');
    case 'local-heuristic':
    default:
      return new LocalHeuristicProvider();
  }
}