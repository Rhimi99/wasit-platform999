import { and, count, desc, eq, gte, inArray, sum } from 'drizzle-orm';
import { ApiError } from '@wasit/shared';
import { platformDb, type DB } from '../../db/client';
import { aiProviders } from '../../db/schema/ai_providers';
import { aiModels, aiRequests } from '../../db/schema/ai';
import { agentTasks } from '../../db/schema/agents';
import { env } from '../env';
import { newId } from '../ids';
import { logger } from '../observability/logger';
import { writeAudit, type AuditContext } from '../audit';
import {
  AnthropicProvider,
  LocalHeuristicProvider,
  NoopProvider,
  OpenAIChatCompletionsProvider,
  VENDOR_MODEL_NAMES,
} from './provider';
import type { AIProvider } from './types';
import { assertSpendGuard, spendGuardState } from './spend-guard';
import { isExecutionBlocked } from './execution-switch';
import {
  fingerprintSecret,
  looksLikeSecret,
  openSecret,
  sealSecret,
  secretAad,
  secretStorageStatus,
  SecretStorageUnavailableError,
} from './secret-box';

/**
 * Secure AI provider management.
 *
 * Two key sources, both outside the row that describes the provider:
 *   ENV — the value lives in an environment variable; the row stores its NAME.
 *   DB  — the value is sealed with a master key that lives outside the database.
 * No key is ever returned by an API, written to a log or handed to an agent.
 */
export interface SupportedProvider {
  key: string;
  displayName: string;
  kind: 'vendor' | 'local' | 'test';
  requiresKey: boolean;
  defaultModel: string;
  defaultBaseUrl: string | null;
  defaultEnvVar: string | null;
  /** Accepted prefixes when the provider talks to its own default endpoint. */
  keyPrefixes: readonly string[];
  productionAllowed: boolean;
}

export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  {
    key: 'openai',
    displayName: 'OpenAI',
    kind: 'vendor',
    requiresKey: true,
    defaultModel: 'openai-gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEnvVar: 'AI_OPENAI_API_KEY',
    keyPrefixes: ['sk-'],
    productionAllowed: true,
  },
  {
    key: 'anthropic',
    displayName: 'Anthropic',
    kind: 'vendor',
    requiresKey: true,
    defaultModel: 'anthropic-claude-sonnet-4',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultEnvVar: 'AI_ANTHROPIC_API_KEY',
    keyPrefixes: ['sk-ant-'],
    productionAllowed: true,
  },
  {
    key: 'local-heuristic',
    displayName: 'WASIT local engine',
    kind: 'local',
    requiresKey: false,
    defaultModel: 'local-heuristic',
    defaultBaseUrl: null,
    defaultEnvVar: null,
    keyPrefixes: [],
    productionAllowed: true,
  },
  {
    key: 'noop',
    displayName: 'Noop harness',
    kind: 'test',
    requiresKey: false,
    defaultModel: 'noop',
    defaultBaseUrl: null,
    defaultEnvVar: null,
    keyPrefixes: [],
    productionAllowed: false,
  },
];

/** A vendor bills per call and sends data out; the in-process engines do not. */
export function isPaidProvider(providerKey: string): boolean {
  return SUPPORTED_PROVIDERS.some((p) => p.key === providerKey && p.kind === 'vendor');
}

/** Deployment environment this process manages. Config never crosses it. */
export function configEnvironment(): string {
  return env.AI_CONFIG_ENVIRONMENT ?? env.NODE_ENV;
}

/**
 * `ai_models.provider` values that belong to a provider key. The catalogue uses
 * `local` for the in-process engine, so the mapping is explicit rather than
 * derived from the key.
 */
export function catalogueProvidersFor(providerKey: string): string[] {
  if (providerKey === 'local-heuristic') return ['local', 'local-heuristic'];
  return [providerKey];
}

function catalogueEntry(key: string): SupportedProvider {
  const found = SUPPORTED_PROVIDERS.find((p) => p.key === key);
  if (!found) throw ApiError.notFound('AI provider');
  return found;
}

function isAllowedInThisDeployment(spec: SupportedProvider): boolean {
  return spec.productionAllowed || env.NODE_ENV !== 'production';
}

export interface ProviderRow {
  id: string;
  environment: string;
  providerKey: string;
  displayName: string;
  enabled: boolean;
  isDefault: boolean;
  isFallback: boolean;
  model: string;
  baseUrl: string | null;
  keySource: string;
  keyEnvVar: string | null;
  secretCiphertext: string | null;
  secretFingerprint: string | null;
  secretUpdatedAt: Date | null;
  lastTestStatus: string;
  lastTestMode: string | null;
  lastTestedAt: Date | null;
  lastTestDetail: unknown;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Creates the default row for every supported provider on first use, so a fresh
 * database reports an honest "not configured" state instead of an empty page.
 * Never overwrites an existing row.
 */
export async function ensureProviderConfigs(db: DB): Promise<void> {
  const cfg = platformDb(db);
  const environment = configEnvironment();
  const existing = await cfg
    .select({ providerKey: aiProviders.providerKey })
    .from(aiProviders)
    .where(eq(aiProviders.environment, environment));
  const known = new Set(existing.map((r) => r.providerKey));
  const missing = SUPPORTED_PROVIDERS.filter((s) => isAllowedInThisDeployment(s) && !known.has(s.key));
  if (missing.length === 0) return;
  await cfg
    .insert(aiProviders)
    .values(
      missing.map((s) => ({
        id: newId(),
        environment,
        providerKey: s.key,
        displayName: s.displayName,
        enabled: s.kind === 'local',
        model: s.defaultModel,
        baseUrl: s.defaultBaseUrl,
        keySource: s.requiresKey ? 'ENV' : 'NONE',
        keyEnvVar: s.defaultEnvVar,
      })),
    )
    .onConflictDoNothing();
}

export async function listProviderRows(db: DB): Promise<ProviderRow[]> {
  await ensureProviderConfigs(db);
  const rows = await platformDb(db)
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.environment, configEnvironment()))
    .orderBy(desc(aiProviders.isDefault), desc(aiProviders.isFallback), aiProviders.providerKey);
  return rows as ProviderRow[];
}

export async function getProviderRow(db: DB, providerKey: string): Promise<ProviderRow> {
  catalogueEntry(providerKey);
  await ensureProviderConfigs(db);
  const rows = await platformDb(db)
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.environment, configEnvironment()), eq(aiProviders.providerKey, providerKey)))
    .limit(1);
  if (rows.length === 0) throw ApiError.notFound('AI provider');
  return rows[0] as ProviderRow;
}

/**
 * Resolves the effective credential for a provider, in precedence order:
 * a sealed DB secret, the named environment variable, then the legacy
 * deployment-wide `AI_API_KEY` when it was meant for this provider.
 */
export function effectiveKey(row: ProviderRow | null | undefined): string | null {
  if (!row) return null;
  if (row.secretCiphertext) {
    try {
      return openSecret(row.secretCiphertext, secretAad(row.environment, row.providerKey));
    } catch (err) {
      // A wrong master key or a tampered row must read as "no key", never as a
      // usable credential, and must never be echoed.
      logger.error('AI provider secret could not be opened', {
        provider: row.providerKey,
        reason: (err as Error).name,
      });
      return null;
    }
  }
  const varName = row.keyEnvVar?.trim();
  if (varName) {
    const value = process.env[varName]?.trim();
    if (value) return value;
  }
  if (row.providerKey !== 'local-heuristic' && row.providerKey !== 'noop') {
    const legacy = env.AI_API_KEY?.trim();
    if (legacy && env.AI_PROVIDER?.toLowerCase() === row.providerKey) return legacy;
  }
  return null;
}

export interface KeyState {
  present: boolean;
  source: 'DB' | 'ENV' | 'NONE';
  envVar: string | null;
  /** Present only for keys WASIT stores itself; never derived from an env key. */
  fingerprint: string | null;
  updatedAt: string | null;
}

/**
 * A provider as an admin surface may see it: configuration plus key presence,
 * never a secret. Lives here (not in a route) so every surface that reports a
 * provider — the AI desk and the GM command center — masks it the same way.
 */
export function maskProvider(row: ProviderRow) {
  const spec = SUPPORTED_PROVIDERS.find((p) => p.key === row.providerKey);
  return {
    key: row.providerKey,
    displayName: row.displayName,
    kind: spec?.kind ?? 'vendor',
    enabled: row.enabled,
    // A provider named by AI_PROVIDER is usable before any admin edit.
    activeFromEnv: isEnvSelected(row),
    isDefault: row.isDefault,
    isFallback: row.isFallback,
    model: row.model,
    baseUrl: row.baseUrl,
    requiresKey: spec?.requiresKey ?? true,
    keyState: keyState(row),
    lastTest: {
      status: row.lastTestStatus,
      mode: row.lastTestMode,
      testedAt: row.lastTestedAt?.toISOString() ?? null,
      detail: row.lastTestDetail ?? null,
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type MaskedProvider = ReturnType<typeof maskProvider>;

export function keyState(row: ProviderRow): KeyState {
  if (row.secretCiphertext) {
    return {
      present: true,
      source: 'DB',
      envVar: null,
      fingerprint: row.secretFingerprint,
      updatedAt: row.secretUpdatedAt?.toISOString() ?? null,
    };
  }
  const present = effectiveKey(row) !== null;
  return {
    present,
    source: present ? 'ENV' : 'NONE',
    envVar: row.keyEnvVar,
    fingerprint: null,
    updatedAt: null,
  };
}

export function buildProvider(row: ProviderRow): AIProvider {
  const spec = SUPPORTED_PROVIDERS.find((p) => p.key === row.providerKey);
  if (!spec) return new LocalHeuristicProvider();
  if (spec.key === 'local-heuristic') return new LocalHeuristicProvider();
  if (spec.key === 'noop') return new NoopProvider();
  const key = effectiveKey(row) ?? '';
  // The row stores a catalogue key; the adapter needs the vendor-facing name.
  const catalogueKey = row.model?.trim() || spec.defaultModel;
  const model = VENDOR_MODEL_NAMES[catalogueKey] ?? catalogueKey;
  const baseUrl = row.baseUrl?.trim() || undefined;
  if (spec.key === 'anthropic') return new AnthropicProvider(key, model, baseUrl);
  return new OpenAIChatCompletionsProvider(key, model, baseUrl);
}

/** True when the deployment names this provider and no admin has overridden it. */
export function isEnvSelected(row: ProviderRow): boolean {
  if (row.updatedBy !== null) return false;
  return (env.AI_PROVIDER ?? '').toLowerCase() === row.providerKey;
}

export interface ProviderChainEntry {
  key: string;
  provider: AIProvider;
  model: string;
  role: 'DEFAULT' | 'FALLBACK' | 'LOCAL';
  keySource: KeyState['source'];
}

/**
 * Ordered, allowlisted provider chain for this deployment:
 * configured default → configured fallback → the free local engine.
 *
 * Never throws: a missing key, a disabled provider, a tampered secret or an
 * unreadable table all degrade to the local engine so the platform keeps
 * working without any vendor configured. Providers outside the allowlist (for
 * example `noop` in production) are never returned.
 */
export async function resolveProviderChain(db: DB): Promise<ProviderChainEntry[]> {
  const chain: ProviderChainEntry[] = [];
  try {
    const rows = await listProviderRows(db);
    for (const row of rows) {
      const spec = SUPPORTED_PROVIDERS.find((p) => p.key === row.providerKey);
      if (!spec || !isAllowedInThisDeployment(spec)) continue;
      // Precedence: an explicit admin decision (updatedBy set) wins. A row that
      // no admin has touched stays usable when the deployment names that
      // provider through AI_PROVIDER, so existing env-only deployments keep
      // working without a migration step.
      if (!row.enabled && !isEnvSelected(row)) continue;
      if (spec.requiresKey && !effectiveKey(row)) continue;
      const provider = buildProvider(row);
      if (!provider.isAvailable()) continue;
      chain.push({
        key: row.providerKey,
        provider,
        model: row.model?.trim() || spec.defaultModel,
        role: row.isDefault
          ? 'DEFAULT'
          : row.isFallback
            ? 'FALLBACK'
            : isEnvSelected(row)
              ? 'DEFAULT'
              : 'LOCAL',
        keySource: keyState(row).source,
      });
    }
  } catch (err) {
    logger.error('AI provider configuration could not be read; using the local engine', {
      error: (err as Error).message,
    });
  }
  const local = new LocalHeuristicProvider();
  if (!chain.some((e) => e.key === 'local-heuristic')) {
    chain.push({ key: local.id, provider: local, model: 'local-heuristic', role: 'LOCAL', keySource: 'NONE' });
  }
  return chain;
}

/** First usable entry, for callers that only need one provider. */
export async function primaryProvider(db: DB): Promise<ProviderChainEntry> {
  const chain = await resolveProviderChain(db);
  return chain[0];
}

// ----- writes --------------------------------------------------------------

export interface ProviderConfigPatch {
  enabled?: boolean;
  model?: string;
  baseUrl?: string | null;
  keyEnvVar?: string | null;
  role?: 'DEFAULT' | 'FALLBACK' | 'NONE';
}

const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{2,99}$/;

export function assertEnvVarName(name: string): string {
  const trimmed = name.trim();
  if (!ENV_VAR_PATTERN.test(trimmed)) {
    throw ApiError.validation(
      [{ field: 'keyEnvVar', code: 'INVALID_ENV_VAR', message: 'Use an upper-case environment variable name' }],
      'Invalid environment variable name',
    );
  }
  return trimmed;
}

/** Rejects base URLs that could reach inside the platform (SSRF guard). */
export function assertAllowedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.validation(
      [{ field: 'baseUrl', code: 'INVALID_URL', message: 'Base URL must be an absolute URL' }],
      'Invalid base URL',
    );
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && env.NODE_ENV !== 'production')) {
    throw ApiError.validation(
      [{ field: 'baseUrl', code: 'INSECURE_URL', message: 'Base URL must use HTTPS' }],
      'Base URL must use HTTPS',
    );
  }
  const allowed = (env.AI_PROVIDER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const specHosts = SUPPORTED_PROVIDERS.map((p) => p.defaultBaseUrl)
    .filter((v): v is string => Boolean(v))
    .map((v) => new URL(v).host.toLowerCase());
  const host = url.host.toLowerCase();
  if (!allowed.includes(host) && !specHosts.includes(host) && !(loopback && env.NODE_ENV !== 'production')) {
    throw ApiError.validation(
      [
        {
          field: 'baseUrl',
          code: 'HOST_NOT_ALLOWED',
          message: 'Host is not in AI_PROVIDER_ALLOWED_HOSTS',
        },
      ],
      'Host is not allowed',
    );
  }
  return raw.replace(/\/+$/, '');
}

export async function updateProviderConfig(
  db: DB,
  ctx: AuditContext,
  providerKey: string,
  patch: ProviderConfigPatch,
): Promise<ProviderRow> {
  const spec = catalogueEntry(providerKey);
  const before = await getProviderRow(db, providerKey);
  if (patch.role && patch.role !== 'NONE' && spec.kind === 'test' && env.NODE_ENV === 'production') {
    throw ApiError.forbidden('This provider cannot be selected in production');
  }

  const values: Partial<typeof aiProviders.$inferInsert> = { updatedAt: new Date(), updatedBy: ctx.actorId ?? null };
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (model.length === 0 || model.length > 100) {
      throw ApiError.validation([{ field: 'model', code: 'INVALID_MODEL', message: 'Model is required' }], 'Invalid model');
    }
    const [known] = await db
      .select({ provider: aiModels.provider })
      .from(aiModels)
      .where(eq(aiModels.key, model))
      .limit(1);
    if (!known) {
      throw ApiError.validation(
        [{ field: 'model', code: 'UNKNOWN_MODEL', message: 'Add the model to the AI catalogue first' }],
        'Unknown model',
      );
    }
    if (!catalogueProvidersFor(providerKey).includes(known.provider)) {
      throw ApiError.validation(
        [
          {
            field: 'model',
            code: 'MODEL_PROVIDER_MISMATCH',
            message: `That model belongs to ${known.provider}`,
          },
        ],
        'Model does not belong to this provider',
      );
    }
    values.model = model;
  }
  if (patch.baseUrl !== undefined) {
    values.baseUrl = patch.baseUrl === null || patch.baseUrl.trim() === '' ? null : assertAllowedBaseUrl(patch.baseUrl.trim());
  }
  if (patch.keyEnvVar !== undefined) {
    values.keyEnvVar = patch.keyEnvVar === null || patch.keyEnvVar.trim() === '' ? null : assertEnvVarName(patch.keyEnvVar);
  }

  // AI-SPEND-GUARD-01: making a paid provider usable requires an explicit money
  // ceiling. The check runs before any write, so a refused activation leaves the
  // row exactly as it was (no half-enabled provider).
  // `role` is applied inside the transaction below, so it has to be folded in
  // here; `NONE` clears both roles and must stay possible without a cap (turning
  // a vendor off is always allowed).
  const willBeEnabled = values.enabled ?? before.enabled;
  const willBeDefault = patch.role === 'DEFAULT' || (patch.role === undefined && (values.isDefault ?? before.isDefault));
  const willBeFallback =
    patch.role === 'FALLBACK' || (patch.role === undefined && (values.isFallback ?? before.isFallback));
  if (spec.kind === 'vendor' && (willBeEnabled || willBeDefault || willBeFallback)) {
    await assertSpendGuard(db, providerKey, before.environment);
  }

  await platformDb(db).transaction(async (tx) => {
    // A single default and a single fallback per environment: clear the old one
    // in the same statement so the partial unique index can never be violated.
    if (patch.role === 'DEFAULT') {
      await tx
        .update(aiProviders)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(aiProviders.environment, before.environment), eq(aiProviders.isDefault, true)));
      values.isDefault = true;
    }
    if (patch.role === 'FALLBACK') {
      await tx
        .update(aiProviders)
        .set({ isFallback: false, updatedAt: new Date() })
        .where(and(eq(aiProviders.environment, before.environment), eq(aiProviders.isFallback, true)));
      values.isFallback = true;
    }
    if (patch.role === 'NONE') {
      values.isDefault = false;
      values.isFallback = false;
    }
    await tx.update(aiProviders).set(values).where(eq(aiProviders.id, before.id));
  });

  const after = await getProviderRow(db, providerKey);
  await writeAudit(db, ctx, {
    action: 'AI_PROVIDER.UPDATED',
    entityType: 'AI_PROVIDER',
    entityId: after.id,
    before: { enabled: before.enabled, model: before.model, baseUrl: before.baseUrl, keyEnvVar: before.keyEnvVar, isDefault: before.isDefault, isFallback: before.isFallback },
    after: { enabled: after.enabled, model: after.model, baseUrl: after.baseUrl, keyEnvVar: after.keyEnvVar, isDefault: after.isDefault, isFallback: after.isFallback },
    metadata: { provider: providerKey, environment: after.environment },
  });
  return after;
}

export function assertStorableSecret(spec: SupportedProvider, secret: string, baseUrl: string | null): string {
  const value = secret.trim();
  if (!looksLikeSecret(value)) {
    throw ApiError.validation(
      [{ field: 'secret', code: 'INVALID_SECRET', message: 'The key is empty or malformed' }],
      'Invalid provider key',
    );
  }
  const usesVendorEndpoint = !baseUrl || (spec.defaultBaseUrl ? baseUrl.replace(/\/+$/, '') === spec.defaultBaseUrl : true);
  if (spec.keyPrefixes.length > 0 && usesVendorEndpoint && !spec.keyPrefixes.some((p) => value.startsWith(p))) {
    throw ApiError.validation(
      [{ field: 'secret', code: 'INVALID_SECRET', message: `A ${spec.displayName} key usually starts with ${spec.keyPrefixes[0]}` }],
      'Invalid provider key',
    );
  }
  return value;
}

export async function storeProviderSecret(
  db: DB,
  ctx: AuditContext,
  providerKey: string,
  secret: string,
): Promise<ProviderRow> {
  const spec = catalogueEntry(providerKey);
  if (!spec.requiresKey) throw ApiError.validation([{ field: 'provider', code: 'NO_KEY_REQUIRED', message: 'This provider does not use a key' }], 'No key required');
  const status = secretStorageStatus();
  if (!status.available) {
    // Fail closed: without a master key outside the database there is nowhere
    // safe to put the value, and WASIT never stores a credential in plaintext.
    throw new ApiError(409, 'SECRET_STORAGE_DISABLED', 'Storing provider keys is disabled on this server; use an environment variable instead');
  }
  const row = await getProviderRow(db, providerKey);
  // A stored key is what makes a paid provider callable, so the guard applies
  // here too — not only on the `enabled` flag.
  if (spec.kind === 'vendor') await assertSpendGuard(db, providerKey, row.environment);
  const value = assertStorableSecret(spec, secret, row.baseUrl);
  const fingerprint = fingerprintSecret(value);
  let envelope: string;
  try {
    envelope = sealSecret(value, secretAad(row.environment, providerKey));
  } catch (err) {
    if (err instanceof SecretStorageUnavailableError) {
      throw new ApiError(409, 'SECRET_STORAGE_DISABLED', 'Storing provider keys is disabled on this server');
    }
    throw err;
  }
  await platformDb(db)
    .update(aiProviders)
    .set({
      secretCiphertext: envelope,
      secretFingerprint: fingerprint,
      secretUpdatedAt: new Date(),
      keySource: 'DB',
      updatedAt: new Date(),
      updatedBy: ctx.actorId ?? null,
    })
    .where(eq(aiProviders.id, row.id));
  await writeAudit(db, ctx, {
    action: 'AI_PROVIDER.SECRET_SET',
    entityType: 'AI_PROVIDER',
    entityId: row.id,
    metadata: { provider: providerKey, environment: row.environment, fingerprint, rotated: row.secretCiphertext !== null },
  });
  return getProviderRow(db, providerKey);
}

export async function clearProviderSecret(db: DB, ctx: AuditContext, providerKey: string): Promise<ProviderRow> {
  catalogueEntry(providerKey);
  const row = await getProviderRow(db, providerKey);
  if (!row.secretCiphertext) return row;
  await platformDb(db)
    .update(aiProviders)
    .set({
      secretCiphertext: null,
      secretFingerprint: null,
      secretUpdatedAt: null,
      keySource: row.keyEnvVar ? 'ENV' : 'NONE',
      updatedAt: new Date(),
      updatedBy: ctx.actorId ?? null,
    })
    .where(eq(aiProviders.id, row.id));
  await writeAudit(db, ctx, {
    action: 'AI_PROVIDER.SECRET_REMOVED',
    entityType: 'AI_PROVIDER',
    entityId: row.id,
    metadata: { provider: providerKey, environment: row.environment },
  });
  return getProviderRow(db, providerKey);
}

// ----- connection test -----------------------------------------------------

export type TestMode = 'CONFIG' | 'LIVE';
export type TestStatus = 'OK' | 'FAILED' | 'CONFIG_ONLY' | 'BLOCKED';

export interface ConnectionTestResult {
  provider: string;
  mode: TestMode;
  status: TestStatus;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  latencyMs: number | null;
  testedAt: string;
}

/** A constant probe: no prompt, no WASIT data, no customer data ever leaves. */
const LIVE_PROBE = 'ping';

async function probeVendor(
  spec: SupportedProvider,
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<{ status: number; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = Math.min(env.AI_REQUEST_TIMEOUT_MS, 10_000);
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const isAnthropic = spec.key === 'anthropic';
    const url = isAnthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
    const body = isAnthropic
      ? { model, max_tokens: 1, messages: [{ role: 'user', content: LIVE_PROBE }] }
      : { model, max_tokens: 1, messages: [{ role: 'user', content: LIVE_PROBE }] };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isAnthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    return { status: res.status, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies a provider without touching customer data.
 *
 * `CONFIG` (default) performs no network call at all: it checks that a key
 * exists, a model is set and the endpoint is allowlisted. `LIVE` sends a fixed
 * one-word probe and is refused unless `AI_PROVIDER_ALLOW_LIVE_TEST=true` —
 * a deliberate opt-in because a probe is a paid vendor request.
 */
export async function testProviderConnection(
  db: DB,
  ctx: AuditContext,
  providerKey: string,
  mode: TestMode,
): Promise<ConnectionTestResult> {
  const spec = catalogueEntry(providerKey);
  const row = await getProviderRow(db, providerKey);
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const key = effectiveKey(row);
  const model = row.model?.trim() || spec.defaultModel;

  checks.push({ id: 'enabled', ok: row.enabled, detail: row.enabled ? 'Provider is enabled' : 'Provider is disabled' });
  if (spec.requiresKey) {
    checks.push({ id: 'key', ok: Boolean(key), detail: key ? `Key present (${keyState(row).source})` : 'No key configured' });
  } else {
    checks.push({ id: 'key', ok: true, detail: 'This provider runs in-process and needs no key' });
  }
  checks.push({ id: 'model', ok: model.length > 0, detail: model.length > 0 ? `Model ${model}` : 'No model set' });
  if (spec.defaultBaseUrl) {
    const baseUrl = row.baseUrl?.trim() || spec.defaultBaseUrl;
    let allowed = true;
    try {
      assertAllowedBaseUrl(baseUrl);
    } catch {
      allowed = false;
    }
    checks.push({ id: 'endpoint', ok: allowed, detail: allowed ? `Endpoint ${new URL(baseUrl).host}` : 'Endpoint is not allowlisted' });
  }

  let status: TestStatus;
  let latencyMs: number | null = null;

  if (mode === 'LIVE') {
    if (!env.AI_PROVIDER_ALLOW_LIVE_TEST) {
      status = 'BLOCKED';
      checks.push({ id: 'live', ok: false, detail: 'Live probes are disabled (AI_PROVIDER_ALLOW_LIVE_TEST)' });
    } else if (checks.some((c) => !c.ok)) {
      status = 'BLOCKED';
      checks.push({ id: 'live', ok: false, detail: 'Configuration is incomplete' });
    } else if (await isExecutionBlocked(db)) {
      // A live probe is a real vendor request. The central switch stops AI
      // execution, so it must stop this too — and a switch store that cannot be
      // read counts as stopped (fail-closed), never as permission to spend.
      status = 'BLOCKED';
      checks.push({ id: 'kill_switch', ok: false, detail: 'AI execution is stopped by the central switch' });
    } else if (spec.kind === 'vendor') {
      // AI-SPEND-GUARD-01: a live probe is a paid call. Without an active
      // GLOBAL daily+monthly cap it is reported as BLOCKED and no socket opens.
      const guard = await spendGuardState(db, row.environment);
      if (!guard.ready) {
        status = 'BLOCKED';
        checks.push({
          id: 'spend_guard',
          ok: false,
          detail: `No active ${guard.missing.map((p) => `GLOBAL ${p.toLowerCase()} cost cap`).join(' and ')}`,
        });
      } else {
        try {
          const probe = await probeVendor(
            spec,
            key as string,
            VENDOR_MODEL_NAMES[model] ?? model,
            row.baseUrl?.trim() || (spec.defaultBaseUrl as string),
          );
          latencyMs = probe.latencyMs;
          const ok = probe.status >= 200 && probe.status < 300;
          checks.push({ id: 'live', ok, detail: ok ? `Provider answered ${probe.status}` : `Provider answered ${probe.status}` });
          status = ok ? 'OK' : 'FAILED';
        } catch (err) {
          checks.push({ id: 'live', ok: false, detail: `Probe failed (${(err as Error).name})` });
          status = 'FAILED';
        }
      }
    } else {
      // In-process engine: run it for real, it costs nothing and sends nothing.
      const started = Date.now();
      const out = await buildProvider(row).call({
        user: LIVE_PROBE,
        maxTokens: 8,
        temperature: 0,
        budgetPeriod: 'MONTHLY',
      });
      latencyMs = Date.now() - started;
      checks.push({ id: 'live', ok: out.content.length > 0, detail: 'Local engine executed in-process' });
      status = out.content.length > 0 ? 'OK' : 'FAILED';
    }
  } else {
    status = checks.every((c) => c.ok) ? 'CONFIG_ONLY' : 'BLOCKED';
  }

  const testedAt = new Date();
  await platformDb(db)
    .update(aiProviders)
    .set({
      lastTestStatus: status,
      lastTestMode: mode,
      lastTestedAt: testedAt,
      lastTestDetail: { checks, latencyMs },
      updatedAt: testedAt,
      updatedBy: ctx.actorId ?? null,
    })
    .where(eq(aiProviders.id, row.id));
  await writeAudit(db, ctx, {
    action: 'AI_PROVIDER.TESTED',
    entityType: 'AI_PROVIDER',
    entityId: row.id,
    metadata: { provider: providerKey, environment: row.environment, mode, status, latencyMs },
  });
  return { provider: providerKey, mode, status, checks, latencyMs, testedAt: testedAt.toISOString() };
}

// ----- usage ---------------------------------------------------------------

export interface ProviderUsage {
  provider: string;
  windowDays: number;
  models: Array<{ key: string; displayName: string; isActive: boolean }>;
  requests: number;
  tokensInput: number;
  tokensOutput: number;
  cost: string;
  agents: Array<{ agentKey: string; tasks: number; model: string }>;
}

/** Which models, agents and tasks actually ran on a provider (from real rows). */
export async function providerUsage(db: DB, providerKey: string, windowDays = 30): Promise<ProviderUsage> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const models = await db
    .select({ key: aiModels.key, displayName: aiModels.displayName, isActive: aiModels.isActive })
    .from(aiModels)
    .where(inArray(aiModels.provider, catalogueProvidersFor(providerKey)));
  const modelKeys = models.map((m) => m.key);
  const localKeys = providerKey === 'local-heuristic' ? ['local-heuristic'] : [];
  const keys = [...new Set([...modelKeys, ...localKeys])];
  if (keys.length === 0) {
    return { provider: providerKey, windowDays, models, requests: 0, tokensInput: 0, tokensOutput: 0, cost: '0', agents: [] };
  }
  const totals = await db
    .select({
      requests: count(),
      tokensInput: sum(aiRequests.tokensInput),
      tokensOutput: sum(aiRequests.tokensOutput),
      cost: sum(aiRequests.cost),
    })
    .from(aiRequests)
    .where(and(inArray(aiRequests.model, keys), gte(aiRequests.createdAt, since)));
  const agents = await db
    .select({ agentKey: agentTasks.agentKey, model: agentTasks.model, tasks: count() })
    .from(agentTasks)
    .where(and(inArray(agentTasks.model, keys), gte(agentTasks.createdAt, since)))
    .groupBy(agentTasks.agentKey, agentTasks.model)
    .orderBy(desc(count()));
  const row = totals[0];
  return {
    provider: providerKey,
    windowDays,
    models,
    requests: Number(row?.requests ?? 0),
    tokensInput: Number(row?.tokensInput ?? 0),
    tokensOutput: Number(row?.tokensOutput ?? 0),
    cost: String(row?.cost ?? '0'),
    agents: agents.map((a) => ({ agentKey: a.agentKey, model: a.model, tasks: Number(a.tasks) })),
  };
}
