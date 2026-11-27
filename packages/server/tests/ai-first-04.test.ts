import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import { createAgentTask, decideAgentTask, AGENT_CATALOGUE } from '../src/modules/ai/agents.js';
import { AGENT_SCOPE_CONTRACTS } from '../src/modules/ai/agent-scope.js';
import { B2B_PARTNER_CONSENT, resolvePartnerConsent } from '../src/modules/ai/partner-consent.js';
import { setConsent } from '../src/modules/privacy/service.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles, consents } from '../src/db/schema/auth.js';
import { suppliers, merchants, companies } from '../src/db/schema/trade.js';
import { orders } from '../src/db/schema/commerce.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-FIRST-COMPLETION-04 — the six supporting agents and consent-scoped B2B
 * partner matching.
 *
 * Everything runs through the real task lifecycle (createAgentTask → approval →
 * executor) against PostgreSQL. No mocks, no route interception.
 */
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
const createdSellerIds: string[] = [];
const createdOrderIds: string[] = [];
const createdTaskIds: string[] = [];

const AUDIT = { actorId: 'afc04-test' };

async function insertUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER' | 'SUPPLIER' | 'MERCHANT' | 'COMPANY') {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `afc04-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  createdEmails.push(email);
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Afc04Pass123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

async function insertSupplier(userId: string, name: string, opts: { countryId?: string | null; verified?: boolean } = {}) {
  const id = randomUUID();
  createdSellerIds.push(id);
  await db.insert(suppliers).values({
    id,
    userId,
    companyName: name,
    slug: `afc04-sup-${id.slice(0, 8)}`,
    countryId: opts.countryId ?? null,
    verified: opts.verified ?? false,
    isActive: true,
  });
  return id;
}

async function insertMerchant(userId: string, name: string, opts: { countryId?: string | null; verified?: boolean } = {}) {
  const id = randomUUID();
  createdSellerIds.push(id);
  await db.insert(merchants).values({
    id,
    userId,
    storeName: name,
    slug: `afc04-mer-${id.slice(0, 8)}`,
    countryId: opts.countryId ?? null,
    verified: opts.verified ?? false,
    isActive: true,
  });
  return id;
}

async function insertCompany(userId: string, name: string) {
  const id = randomUUID();
  createdSellerIds.push(id);
  await db.insert(companies).values({
    id,
    userId,
    legalName: name,
    slug: `afc04-com-${id.slice(0, 8)}`,
    isActive: true,
    verified: false,
  });
  return id;
}

/** Runs a task through the real lifecycle, approving it with a second staff user when gated. */
async function runAndComplete(agentKey: string, input: Record<string, unknown>, requesterId: string, rolesList: Parameters<typeof createAgentTask>[1]) {
  const created = await createAgentTask(db, rolesList, requesterId, { agentKey, requestedBy: requesterId, input }, { ...AUDIT, actorId: requesterId });
  createdTaskIds.push(created.id);
  if (created.status === 'awaiting_approval') {
    const approver = await insertUser('SUPER_ADMIN');
    const decided = await decideAgentTask(db, created.id, approver.id, 'APPROVE', 'afc04 test approval', AUDIT);
    return decided;
  }
  return created;
}

function adviceOf(task: { result: unknown; status?: string; error?: unknown }): Record<string, unknown> {
  expect(task.error ?? null, `task ${task.status} failed: ${JSON.stringify(task.error)}`).toBeNull();
  const result = task.result as { advice?: string } | null;
  expect(typeof result?.advice).toBe('string');
  return JSON.parse(String(result?.advice)) as Record<string, unknown>;
}

describe('AFC-04 — six supporting agents are wired end to end', () => {
  it('has an executor and a scope contract for every executable agent', () => {
    const executable = AGENT_CATALOGUE.filter((a) => a.executable === true);
    expect(executable).toHaveLength(20);
    for (const agent of executable) {
      expect(AGENT_SCOPE_CONTRACTS[agent.key], agent.key).toBeDefined();
    }
    // Every specialised agent is executable; the supervisor is not in this catalogue.
    expect(AGENT_CATALOGUE.filter((a) => a.executable !== true)).toHaveLength(0);
  });

  it('runs the payment & settlement agent for staff and never claims money movement', async () => {
    const staff = await insertUser('SUPER_ADMIN');
    const task = await runAndComplete('payment-settlement-agent', { action: 'monitor_settlement', windowDays: 7 }, staff.id, ['SUPER_ADMIN']);
    expect(task.error).toBeNull();
    const advice = adviceOf(task);
    expect(advice.agentKey).toBe('payment-settlement-agent');
    expect(advice.moneyMovement).toBe(false);
    expect(Array.isArray(advice.anomalies)).toBe(true);
    expect(Array.isArray(advice.blindSpots)).toBe(true);
    expect(advice.orders).toBeTypeOf('object');
  });

  it('refuses the payment agent for a non-platform role', async () => {
    const customer = await insertUser('CUSTOMER');
    await expect(
      createAgentTask(db, ['CUSTOMER'], customer.id, { agentKey: 'payment-settlement-agent', requestedBy: customer.id, input: {} }, { ...AUDIT, actorId: customer.id }),
    ).rejects.toThrow(/platform-wide/);
  });

  it('runs the compliance agent and returns findings only', async () => {
    const staff = await insertUser('SUPER_ADMIN');
    const task = await runAndComplete('compliance-agent', { action: 'check', windowDays: 30 }, staff.id, ['SUPER_ADMIN']);
    const advice = adviceOf(task);
    expect(advice.findingsOnly).toBe(true);
    expect(Array.isArray(advice.findings)).toBe(true);
    expect(advice.snapshot).toBeTypeOf('object');
  });

  it('reviews the caller own supplier record and never another tenant record', async () => {
    const owner = await insertUser('SUPPLIER');
    const other = await insertUser('SUPPLIER');
    const ownId = await insertSupplier(owner.id, 'AFC04 Own Supplier', { verified: true });
    const otherId = await insertSupplier(other.id, 'AFC04 Other Supplier');

    const task = await runAndComplete('supplier-agent', { action: 'onboard' }, owner.id, ['SUPPLIER']);
    const advice = adviceOf(task);
    const reviews = advice.reviews as Array<{ id: string; name: string; completeness: { score: number; missing: string[] }; nextSteps: string[] }>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe(ownId);
    expect(reviews[0]!.name).toBe('AFC04 Own Supplier');
    expect(reviews[0]!.completeness.score).toBeGreaterThan(0);
    expect(Array.isArray(reviews[0]!.nextSteps)).toBe(true);
    expect(JSON.stringify(advice)).not.toContain(otherId);
  });

  it('refuses an onboarding review when the caller owns no such entity', async () => {
    const customer = await insertUser('CUSTOMER');
    const task = await runAndComplete('merchant-agent', { action: 'onboard' }, customer.id, ['CUSTOMER']);
    const advice = adviceOf(task);
    expect(advice.refused).toBe(true);
    expect(advice.code).toBe('ENTITY_NOT_FOUND');
  });

  it('segments real orders and masks buyer identities', async () => {
    const merchantUser = await insertUser('MERCHANT');
    const merchantId = await insertMerchant(merchantUser.id, 'AFC04 Segments Store');
    const buyer = await insertUser('CUSTOMER');

    for (const [i, total] of ['120.00', '80.00'].entries()) {
      const id = randomUUID();
      createdOrderIds.push(id);
      await db.insert(orders).values({
        id,
        orderNumber: `AFC04-${Date.now()}-${i}`,
        buyerId: buyer.id,
        buyerType: 'CUSTOMER',
        sellerId: merchantId,
        sellerType: 'MERCHANT',
        currencyCode: 'TND',
        itemsTotal: total,
        commission: '0',
        grandTotal: total,
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
      });
    }

    const task = await runAndComplete('customer-intelligence-agent', { action: 'segment', windowDays: 180 }, merchantUser.id, ['MERCHANT']);
    const advice = adviceOf(task);
    expect(advice.pii).toBe('masked');
    expect(advice.customers).toBe(1);
    const segments = advice.segments as Array<{ segment: string; customers: number; revenue: string }>;
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]!.revenue).toBe('200.00');
    // The raw buyer id must never appear in the agent output.
    expect(JSON.stringify(advice)).not.toContain(buyer.id);
  });

  it('reports operational health for staff only', async () => {
    const staff = await insertUser('SUPER_ADMIN');
    const task = await runAndComplete('operations-agent', { action: 'health_check' }, staff.id, ['SUPER_ADMIN']);
    const advice = adviceOf(task);
    expect(advice.healthScore).toBeTypeOf('number');
    expect(Array.isArray(advice.blockers)).toBe(true);

    const merchantUser = await insertUser('MERCHANT');
    await expect(
      createAgentTask(db, ['MERCHANT'], merchantUser.id, { agentKey: 'operations-agent', requestedBy: merchantUser.id, input: {} }, { ...AUDIT, actorId: merchantUser.id }),
    ).rejects.toThrow(/platform-wide/);
  });
});

describe('AFC-04 — B2B partner suggestions are consent-scoped', () => {
  it('refuses without the partner-discovery consent and says how to grant it', async () => {
    const merchantUser = await insertUser('MERCHANT');
    await insertMerchant(merchantUser.id, 'AFC04 Consentless Store');

    const task = await runAndComplete('b2b-agent', { action: 'match_b2b' }, merchantUser.id, ['MERCHANT']);
    const advice = adviceOf(task);
    expect(advice.refused).toBe(true);
    expect(advice.code).toBe('CONSENT_REQUIRED');
    const howTo = advice.howToGrant as { path: string; body: { consentType: string } };
    expect(howTo.path).toBe('/api/privacy/consents');
    expect(howTo.body.consentType).toBe(B2B_PARTNER_CONSENT);
  });

  it('suggests only opted-in, complementary partners and exposes no contact detail', async () => {
    const requester = await insertUser('MERCHANT');
    const requesterMerchantId = await insertMerchant(requester.id, 'AFC04 Requester Store', { countryId: 'TN', verified: true });
    const optedSupplierUser = await insertUser('SUPPLIER');
    const optedSupplierId = await insertSupplier(optedSupplierUser.id, 'AFC04 Opted Supplier', { countryId: 'TN', verified: true });
    const silentSupplierUser = await insertUser('SUPPLIER');
    const silentSupplierId = await insertSupplier(silentSupplierUser.id, 'AFC04 Silent Supplier', { countryId: 'TN', verified: true });
    const silentCompanyUser = await insertUser('COMPANY');
    const silentCompanyId = await insertCompany(silentCompanyUser.id, 'AFC04 Silent Company');

    await setConsent(db, { userId: requester.id }, B2B_PARTNER_CONSENT, true);
    await setConsent(db, { userId: optedSupplierUser.id }, B2B_PARTNER_CONSENT, true);

    const snapshot = await resolvePartnerConsent(db, requester.id);
    expect(snapshot.requesterGranted).toBe(true);
    expect(snapshot.discoverableSellerIds).toContain(optedSupplierId);
    expect(snapshot.discoverableSellerIds).not.toContain(silentSupplierId);
    expect(snapshot.discoverableSellerIds).not.toContain(silentCompanyId);

    const task = await runAndComplete('b2b-agent', { action: 'match_b2b', limit: 10 }, requester.id, ['MERCHANT']);
    const advice = adviceOf(task);
    const suggestions = advice.suggestions as Array<{
      partnerType: string;
      partnerRef: string;
      displayName: string;
      score: number;
      reasons: string[];
    }>;

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.map((s) => s.displayName)).toContain('AFC04 Opted Supplier');
    expect(suggestions.map((s) => s.displayName)).not.toContain('AFC04 Silent Supplier');
    expect(suggestions.map((s) => s.displayName)).not.toContain('AFC04 Silent Company');
    // The caller's own entity is never suggested to itself.
    expect(suggestions.map((s) => s.displayName)).not.toContain('AFC04 Requester Store');

    for (const suggestion of suggestions) {
      expect(suggestion.partnerType).not.toBe('MERCHANT');
      expect(suggestion.score).toBeGreaterThanOrEqual(0);
      expect(suggestion.score).toBeLessThanOrEqual(100);
      expect(suggestion.reasons.length).toBeGreaterThan(0);
      expect(suggestion.partnerRef).toMatch(/^[0-9a-f]{10}$/);
    }
    const serialized = JSON.stringify(advice);
    expect(serialized).not.toContain(optedSupplierId);
    expect(serialized).not.toMatch(/@wasit\.tn/);
    expect(advice.contactPolicy).toBeTypeOf('string');
  });

  it('drops a caller-supplied consent snapshot instead of trusting it', async () => {
    const requester = await insertUser('MERCHANT');
    await insertMerchant(requester.id, 'AFC04 Forged Store');
    const created = await createAgentTask(
      db,
      ['MERCHANT'],
      requester.id,
      {
        agentKey: 'b2b-agent',
        requestedBy: requester.id,
        input: { __partnerConsent: { requesterGranted: true, discoverableSellerIds: ['forged'], discoverableOwners: 99 } },
      },
      { ...AUDIT, actorId: requester.id },
    );
    createdTaskIds.push(created.id);
    // The stored input must carry the server-resolved snapshot, not the forged one.
    const stored = await db.execute(
      sql`select input->'__partnerConsent' as consent from agent_tasks where id = ${created.id}`,
    );
    const value = (stored.rows?.[0] as { consent?: { requesterGranted?: boolean; discoverableSellerIds?: string[] } } | undefined)?.consent;
    expect(value?.discoverableSellerIds ?? []).not.toContain('forged');
    expect(value?.requesterGranted).toBe(false);
  });
});

afterAll(async () => {
  await cleanupOwnedRows(db, { userIds: createdUserIds, taskIds: createdTaskIds });
  if (createdOrderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  if (createdSellerIds.length > 0) {
    await db.delete(suppliers).where(inArray(suppliers.id, createdSellerIds));
    await db.delete(merchants).where(inArray(merchants.id, createdSellerIds));
    await db.delete(companies).where(inArray(companies.id, createdSellerIds));
  }
  if (createdEmails.length > 0) {
    await db.delete(consents).where(inArray(consents.userId, createdUserIds));
  }
});
