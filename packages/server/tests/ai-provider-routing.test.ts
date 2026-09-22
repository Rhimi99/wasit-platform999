import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { env } from '../src/lib/env.js';
import { resolveProvider } from '../src/lib/ai/provider.js';
import { resolveAiRoute } from '../src/lib/ai/routing.js';
import { runAIFeature } from '../src/lib/ai/runtime.js';
import type { AIProvider, AIProviderCallOptions, AIProviderCallResult } from '../src/lib/ai/types.js';
import { aiRequests, aiUsage } from '../src/db/schema/ai.js';
import { recentLogs } from '../src/lib/observability/logger.js';

/**
 * F3 — External AI provider verification.
 *
 * These tests exercise the real provider resolution, routing and vendoring code
 * paths. The vendor HTTP endpoint is a local server we control, so the adapter
 * makes a genuine HTTP round-trip without needing a real API key or network
 * access. No AI logic is mocked: the actual `OpenAIChatCompletionsProvider` /
 * `AnthropicProvider` / `LocalHeuristicProvider` classes run.
 */

const ENV_KEYS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_DEFAULT_MODEL',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_ANTHROPIC_BASE_URL',
  'AI_REQUEST_TIMEOUT_MS',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

let savedEnv: Record<EnvKey, unknown>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k as keyof typeof env]])) as Record<EnvKey, unknown>;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    (env as Record<string, unknown>)[k] = savedEnv[k];
  }
});

/** Minimal local stand-in for a vendor endpoint. Records the last request body. */
interface VendorServer {
  baseUrl: string;
  lastBody: () => Record<string, unknown> | null;
  close: () => Promise<void>;
}

async function startVendorServer(
  handler: (body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<VendorServer> {
  let last: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        last = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        last = null;
      }
      handler(last ?? {}, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    lastBody: () => last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// --------------------------------------------------------------------------
// Provider / model / key resolution
// --------------------------------------------------------------------------

describe('F3 provider resolution precedence', () => {
  it('selects the configured vendor when a key is present, and reports it unavailable without one', () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_MODEL = 'gpt-4o-mini';
    const withKey = resolveProvider();
    expect(withKey.id).toBe('openai');
    expect(withKey.isAvailable()).toBe(true);

    env.AI_API_KEY = '';
    const withoutKey = resolveProvider();
    expect(withoutKey.id).toBe('openai');
    expect(withoutKey.isAvailable()).toBe(false);
  });

  it('defaults to the real local engine, never a noop harness, when unconfigured', () => {
    env.AI_PROVIDER = 'none';
    const provider = resolveProvider();
    expect(provider.id).toBe('local-heuristic');
    expect(provider.isAvailable()).toBe(true);
  });
});

describe('F3 routing decorates the selected vendor and model', () => {
  it('routes a capability to the vendor model and passes the vendor-facing name', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';

    const route = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN']);
    expect(route.providerId).toBe('openai');
    expect(route.modelKey).toBe('openai-gpt-4o-mini');
    // The catalogue key must be translated to the name the vendor expects.
    expect(route.vendorModel).toBe('gpt-4o-mini');
    expect(route.provider.isAvailable()).toBe(true);
  });

  it('degrades to a *usable* local provider when the vendor has no credentials', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = '';

    const route = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN']);
    expect(route.providerId).toBe('local-heuristic');
    expect(route.modelKey).toBe('local-heuristic');
    // Regression guard: the degrade path used to return the unavailable vendor.
    expect(route.provider.isAvailable()).toBe(true);
  });

  it('prefers an explicit request model over the capability policy over AI_MODEL', async () => {
    env.AI_PROVIDER = 'local-heuristic';
    env.AI_MODEL = 'anthropic-claude-sonnet-4';

    const explicit = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN'], 'local-heuristic');
    expect(explicit.modelKey).toBe('local-heuristic');

    // No explicit request → the capability policy (openai) wins over AI_MODEL.
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    const capability = await resolveAiRoute(db, 'PRODUCT_ANALYSIS', ['ADMIN']);
    expect(capability.modelKey).toBe('openai-gpt-4o-mini');
  });

  it('keeps the role ceiling: a non-admin cannot reach a paid capability model', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_DEFAULT_MODEL = 'openai-gpt-4o-mini';

    // MARKET_ANALYSIS maps to the expensive anthropic model for admins...
    const admin = await resolveAiRoute(db, 'MARKET_ANALYSIS', ['ADMIN']);
    expect(admin.modelKey).toBe('anthropic-claude-sonnet-4');

    // ...but a CUSTOMER is clamped to the default, cheaper model.
    const customer = await resolveAiRoute(db, 'MARKET_ANALYSIS', ['CUSTOMER']);
    expect(customer.modelKey).toBe('openai-gpt-4o-mini');
  });
});

// --------------------------------------------------------------------------
// External adapter — real HTTP round trip to a local vendor endpoint
// --------------------------------------------------------------------------

describe('F3 external OpenAI-compatible adapter', () => {
  it('sends the routed vendor model and reads content + usage from the response', async () => {
    const vendor = await startVendorServer((_body, res) =>
      json(res, 200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'real vendor answer' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_MODEL = 'gpt-4o-mini';
    env.AI_BASE_URL = vendor.baseUrl;

    try {
      const provider = resolveProvider();
      const result = await provider.call({
        user: 'hello',
        budgetPeriod: 'MONTHLY',
        model: 'routed-vendor-model',
      });
      // The per-call model must reach the vendor, not the adapter default.
      expect(vendor.lastBody()?.model).toBe('routed-vendor-model');
      expect(result.content).toBe('real vendor answer');
      expect(result.tokensInput).toBe(11);
      expect(result.tokensOutput).toBe(7);
    } finally {
      await vendor.close();
    }
  });

  it('maps a vendor error status to a safe 503 without leaking the vendor body', async () => {
    const vendor = await startVendorServer((_body, res) =>
      json(res, 401, { error: 'sk-SECRET-LEAK-invalid-key' }),
    );
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'sk-live-must-not-appear';
    env.AI_BASE_URL = vendor.baseUrl;

    try {
      const provider = resolveProvider();
      await expect(
        provider.call({ user: 'hi', budgetPeriod: 'MONTHLY', model: 'gpt-4o-mini' }),
      ).rejects.toMatchObject({ statusCode: 503 });
      // The thrown message must not echo the vendor body or the API key.
      const err: Error = await provider
        .call({ user: 'hi', budgetPeriod: 'MONTHLY', model: 'gpt-4o-mini' })
        .then(
          () => {
            throw new Error('expected the provider call to reject');
          },
          (e: unknown) => e as Error,
        );
      expect(err.message).not.toContain('sk-SECRET-LEAK');
      expect(err.message).not.toContain('sk-live-must-not-appear');
    } finally {
      await vendor.close();
    }
  });

  it('aborts a hung vendor call instead of pinning the request', async () => {
    const vendor = await startVendorServer(() => {
      /* never responds */
    });
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'test-key';
    env.AI_BASE_URL = vendor.baseUrl;
    env.AI_REQUEST_TIMEOUT_MS = 200;

    try {
      const provider = resolveProvider();
      await expect(
        provider.call({ user: 'hi', budgetPeriod: 'MONTHLY', model: 'gpt-4o-mini' }),
      ).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('timed out') });
    } finally {
      await vendor.close();
    }
  });

  it('refuses to call when credentials are missing', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = '';
    const provider = resolveProvider();
    await expect(
      provider.call({ user: 'hi', budgetPeriod: 'MONTHLY', model: 'gpt-4o-mini' }),
    ).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('not configured') });
  });

  it('sends Anthropic requests in the Messages shape with the routed model', async () => {
    const vendor = await startVendorServer((_body, res) =>
      json(res, 200, {
        model: 'claude-sonnet-4-20250514',
        content: [{ text: 'anthropic answer' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    env.AI_PROVIDER = 'anthropic';
    env.AI_API_KEY = 'test-key';
    env.AI_ANTHROPIC_BASE_URL = vendor.baseUrl;

    try {
      const provider = resolveProvider();
      const result = await provider.call({
        user: 'hi',
        budgetPeriod: 'MONTHLY',
        model: 'claude-sonnet-4-20250514',
      });
      expect(vendor.lastBody()?.model).toBe('claude-sonnet-4-20250514');
      expect(vendor.lastBody()?.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(result.content).toBe('anthropic answer');
      expect(result.tokensInput).toBe(5);
    } finally {
      await vendor.close();
    }
  });
});

// --------------------------------------------------------------------------
// Runtime: precedence, provider pass-through and accounting
// --------------------------------------------------------------------------

/** Test fixture: a real AIProvider implementation that records what it received. */
class RecordingProvider implements AIProvider {
  readonly id = 'fixture';
  receivedModel: string | null = null;
  constructor(private readonly tokens: { input: number; output: number } = { input: 3, output: 4 }) {}
  isAvailable(): boolean {
    return true;
  }
  async call(opts: AIProviderCallOptions): Promise<AIProviderCallResult> {
    this.receivedModel = opts.model ?? null;
    return {
      content: 'fixture-content',
      model: opts.model ?? 'fixture',
      tokensInput: this.tokens.input,
      tokensOutput: this.tokens.output,
      cost: '0',
      currencyCode: 'USD',
    };
  }
}

class FailingProvider implements AIProvider {
  readonly id = 'failing';
  isAvailable(): boolean {
    return true;
  }
  async call(): Promise<AIProviderCallResult> {
    const { ApiError } = await import('@wasit/shared');
    throw ApiError.serviceUnavailable('vendor exploded');
  }
}

describe('F3 runtime model precedence and provider pass-through', () => {
  const created: string[] = [];

  afterEach(async () => {
    if (created.length > 0) {
      await db.delete(aiRequests).where(inArray(aiRequests.userId, created));
      await db.delete(aiUsage).where(inArray(aiUsage.userId, created));
      created.length = 0;
    }
  });

  it('honours the caller modelKey and forwards the vendor model to the provider', async () => {
    const fixture = new RecordingProvider();
    const userId = randomUUID();
    created.push(userId);

    const out = await runAIFeature(db, {
      userId,
      roles: ['ADMIN'],
      requestType: 'TEST',
      user: 'run',
      modelKey: 'openai-gpt-4o-mini',
      vendorModel: 'gpt-4o-mini',
      provider: fixture,
    });

    expect(fixture.receivedModel).toBe('gpt-4o-mini');
    expect(out.model).toBe('gpt-4o-mini');
    // Paid model → catalogue price applied to the measured tokens.
    expect(Number(out.cost)).toBeGreaterThan(0);
  });

  it('does not bill a degraded free provider at a paid model rate', async () => {
    const fixture = new RecordingProvider();
    const userId = randomUUID();
    created.push(userId);

    // Caller asked for a paid model, but the effective provider is the free engine.
    const { LocalHeuristicProvider } = await import('../src/lib/ai/provider.js');
    const out = await runAIFeature(db, {
      userId,
      roles: ['ADMIN'],
      requestType: 'TEST',
      user: 'run',
      modelKey: 'openai-gpt-4o-mini',
      provider: new LocalHeuristicProvider(),
    });

    expect(out.model).toBe('local-heuristic');
    expect(out.cost).toBe('0.0000000000');
    void fixture;
  });

  it('records a failed request (no billed tokens) when the provider throws', async () => {
    const userId = randomUUID();
    created.push(userId);

    await expect(
      runAIFeature(db, {
        userId,
        roles: ['ADMIN'],
        requestType: 'TEST',
        user: 'run',
        modelKey: 'local-heuristic',
        provider: new FailingProvider(),
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const rows = await db
      .select()
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, userId), eq(aiRequests.requestType, 'TEST')));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('UNAVAILABLE');
    expect(rows[0].tokensInput).toBe(0);
    expect(rows[0].cost).toBe('0.0000000000');
  });

  it('never writes the API key into the log ring', async () => {
    env.AI_PROVIDER = 'openai';
    env.AI_API_KEY = 'sk-must-never-be-logged';
    const provider = resolveProvider();
    await provider.call({ user: 'hi', budgetPeriod: 'MONTHLY', model: 'gpt-4o-mini' }).catch(() => undefined);
    const dump = JSON.stringify(recentLogs({ limit: 200 }));
    expect(dump).not.toContain('sk-must-never-be-logged');
  });

  it('falls back to the deployment default when the caller names no model', async () => {
    env.AI_MODEL = '';
    env.AI_DEFAULT_MODEL = 'local-heuristic';
    const fixture = new RecordingProvider();
    const userId = randomUUID();
    created.push(userId);

    const out = await runAIFeature(db, {
      userId,
      roles: ['ADMIN'],
      requestType: 'TEST',
      user: 'run',
      provider: fixture,
    });
    expect(out.model).toBe('local-heuristic');
  });
});
