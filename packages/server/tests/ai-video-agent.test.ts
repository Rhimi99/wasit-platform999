import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { products, categories } from '../src/db/schema/products.js';
import { suppliers } from '../src/db/schema/trade.js';
import { mediaAssets } from '../src/db/schema/media.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import { generateMarketingVideo } from '../src/modules/media/service.js';
import { measureMp4DurationSeconds } from '../src/lib/media/mp4.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * Marketing Video Agent — real lifecycle against Postgres.
 *
 * The agent plans from live product data and hands the owner an executable
 * render request. The render itself runs in the media module: it writes a
 * media_assets row and an audit entry, and agents may not write audit_logs
 * (A2), so an executor can never perform it. These tests assert both halves:
 * the plan is real, and the agent writes nothing.
 */

const createdUserIds: string[] = [];
const createdTaskIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdSupplierIds: string[] = [];
const createdAssetIds: string[] = [];
const AUDIT = { actorId: 'it-video-agent', ipAddress: null, userAgent: null };

async function createUser(roleName: string): Promise<string> {
  const id = randomUUID();
  const email = `it-video-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({ id, email, passwordHash: 'x', firstName: 'IT', isActive: true, emailVerified: true });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  createdUserIds.push(id);
  return id;
}

async function createSupplier(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(suppliers).values({
    id,
    userId,
    companyName: `IT Groves ${id.slice(0, 6)}`,
    slug: `it-groves-${id.slice(0, 8)}`,
  });
  createdSupplierIds.push(id);
  return id;
}

async function createCategory(): Promise<string> {
  const id = randomUUID();
  await db.insert(categories).values({ id, name: `IT Cat ${id.slice(0, 6)}`, slug: `it-cat-${id.slice(0, 8)}` });
  createdCategoryIds.push(id);
  return id;
}

async function createProduct(sellerId: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  const categoryId = await createCategory();
  await db.insert(products).values({
    id,
    sellerId,
    sellerType: 'SUPPLIER',
    categoryId,
    name: 'Olive Oil 1L',
    nameAr: 'زيت زيتون 1 لتر',
    slug: `it-olive-${id.slice(0, 8)}`,
    sku: `IT-${id.slice(0, 8)}`,
    basePrice: '24.5000',
    currencyCode: 'TND',
    status,
    isPublished: true,
    description: 'Cold-pressed extra virgin olive oil from Sfax.',
  });
  createdProductIds.push(id);
  return id;
}

/** Runs a gated task to completion, approving it as a separate SUPER_ADMIN. */
async function runVideoTask(requestedBy: string, input: Record<string, unknown>) {
  const created = await createAgentTask(
    db,
    ['SUPPLIER'],
    requestedBy,
    { agentKey: 'marketing-video-agent', requestedBy, input },
    AUDIT,
  );
  createdTaskIds.push(created.id);
  expect(created.status).toBe('awaiting_approval');
  const approver = await createUser('SUPER_ADMIN');
  const done = await decideAgentTask(db, created.id, approver, 'APPROVE', 'it approval', AUDIT);
  // Approval executes inline and returns the completed task (status may still
  // read `approved` when the executor finished within the same call).
  expect(['succeeded', 'approved']).toContain(done.status);
  expect(done.error).toBeNull();
  const advice = JSON.parse((done.result as { advice: string }).advice);
  return { task: done, advice };
}

async function mediaAssetCount(): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(mediaAssets);
  return Number(rows[0]?.n ?? 0);
}

afterAll(async () => {
  if (createdAssetIds.length > 0) {
    await db.delete(mediaAssets).where(inArray(mediaAssets.id, createdAssetIds));
  }
  await cleanupOwnedRows(db, {
    userIds: createdUserIds,
    taskIds: createdTaskIds,
    productIds: createdProductIds,
    categoryIds: createdCategoryIds,
  });
  if (createdSupplierIds.length > 0) {
    await db.delete(suppliers).where(inArray(suppliers.id, createdSupplierIds));
  }
  await closeDb();
});

describe('AI — Marketing Video Agent (real DB)', () => {
  it('plans from live product data and renders a verified file without writing platform rows', async () => {
    const supplierUser = await createUser('SUPPLIER');
    const supplierId = await createSupplier(supplierUser);
    const productId = await createProduct(supplierId);
    const before = await mediaAssetCount();

    const { advice } = await runVideoTask(supplierUser, { productId, durationSeconds: 60 });

    expect(advice.readOnly).toBe(true);
    expect(advice.renders).toBe(true);
    expect(advice.writesPlatformRows).toBe(false);
    expect(advice.publishes).toBe(false);
    expect(advice.product).toMatchObject({ id: productId, status: 'ACTIVE', currencyCode: 'TND' });
    expect(advice.plan.durationSeconds).toBe(60);
    expect(advice.plan.slides).toHaveLength(4);
    expect(advice.plan.slides.map((s: { text: string }) => s.text).join(' ')).toContain('Olive Oil 1L');
    expect(advice.plan.slides[3].text).toContain('Order now on WASIT');
    expect(advice.plan.script.length).toBeGreaterThan(20);
    expect(advice.plan.storyboard).toHaveLength(4);
    expect(advice.plan.delivery).toMatchObject({ container: 'mp4', videoCodec: 'h264' });
    // Readiness reports the real renderer, not a promise.
    expect(advice.readiness.provider).toBe('structural');
    expect(advice.readiness.externalServices).toBe(false);
    expect(typeof advice.readiness.available).toBe('boolean');
    expect(advice.readiness.available || typeof advice.readiness.reason === 'string').toBe(true);
    expect(advice.renderRequest).toMatchObject({
      method: 'POST',
      path: '/api/media/marketing-videos',
      body: { productId, language: 'en', audience: 'B2B', style: 'MODERN', durationSeconds: 60 },
    });
    expect(advice.publish.available).toBe(false);

    // The render ran inside the agent task and the file was verified by ffprobe
    // plus a full decode — not by its extension.
    expect(advice.render.status).toBe('READY');
    expect(advice.video).toMatchObject({
      storage: 'local',
      contentType: 'video/mp4',
      codec: 'h264',
      width: 720,
      height: 1280,
      verified: true,
    });
    expect(advice.video.storageKey).toMatch(/^agent-videos\/[0-9a-f-]{36}\//);
    expect(advice.video.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(advice.video.bytes).toBeGreaterThan(10_000);
    expect(advice.video.durationSeconds).toBeGreaterThanOrEqual(35);
    expect(advice.video.durationSeconds).toBeLessThanOrEqual(120);
    expect(Math.abs(advice.video.durationSeconds - advice.video.containerDurationSeconds)).toBeLessThanOrEqual(0.5);
    expect(advice.video.decode.ok).toBe(true);
    expect(advice.steps.map((s: { step: string }) => s.step)).toEqual([
      'precheck_renderer',
      'render',
      'store',
      'probe',
      'decode',
    ]);
    expect(advice.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);

    // No platform row was written: rendering is a file, not a media_assets or
    // audit_logs write (both are out of reach for an agent).
    expect(await mediaAssetCount()).toBe(before);
  }, 90_000);

  it('can plan without rendering when the caller asks for a plan only', async () => {
    const supplierUser = await createUser('SUPPLIER');
    const supplierId = await createSupplier(supplierUser);
    const productId = await createProduct(supplierId);

    const { advice } = await runVideoTask(supplierUser, { productId, render: false });

    expect(advice.renders).toBe(false);
    expect(advice.render.status).toBe('SKIPPED');
    expect(advice.video).toBeNull();
    expect(advice.plan.slides).toHaveLength(4);
  });

  it('clamps the requested duration into the 35–120s window', async () => {
    const supplierUser = await createUser('SUPPLIER');
    const supplierId = await createSupplier(supplierUser);
    const productId = await createProduct(supplierId);

    const short = await runVideoTask(supplierUser, { productId, durationSeconds: 5 });
    expect(short.advice.plan.durationSeconds).toBe(35);
    const long = await runVideoTask(supplierUser, { productId, durationSeconds: 999 });
    expect(long.advice.plan.durationSeconds).toBe(120);
  });

  it('refuses a product owned by another seller without leaking it', async () => {
    const owner = await createUser('SUPPLIER');
    const ownerSupplier = await createSupplier(owner);
    const foreignProduct = await createProduct(ownerSupplier);

    const intruder = await createUser('SUPPLIER');
    await createSupplier(intruder);

    const { advice } = await runVideoTask(intruder, { productId: foreignProduct });
    expect(advice.refused).toBe(true);
    expect(advice.error.code).toBe('PRODUCT_NOT_OWNED');
    expect(advice.product).toBeUndefined();
    expect(advice.plan).toBeUndefined();
    expect(advice.renderRequest).toBeUndefined();
  });

  it('refuses an inactive product, a missing product and a missing productId', async () => {
    const supplierUser = await createUser('SUPPLIER');
    const supplierId = await createSupplier(supplierUser);
    const draft = await createProduct(supplierId, 'DRAFT');

    const inactive = await runVideoTask(supplierUser, { productId: draft });
    expect(inactive.advice.error.code).toBe('PRODUCT_NOT_ACTIVE');

    const missing = await runVideoTask(supplierUser, { productId: randomUUID() });
    expect(missing.advice.error.code).toBe('PRODUCT_NOT_FOUND');

    const none = await runVideoTask(supplierUser, {});
    expect(none.advice.error.code).toBe('PRODUCT_REQUIRED');
  });

  it('lets an admin plan for any seller and hands over a render request that really renders', async () => {
    const owner = await createUser('SUPPLIER');
    const ownerSupplier = await createSupplier(owner);
    const productId = await createProduct(ownerSupplier);

    const admin = await createUser('SUPER_ADMIN');
    const { advice } = await runVideoTask(admin, { productId, durationSeconds: 35, language: 'ar' });
    expect(advice.refused).toBeUndefined();
    expect(advice.product.id).toBe(productId);
    expect(advice.plan.language).toBe('ar');

    // Execute the hand-off exactly as the owner would.
    const before = await mediaAssetCount();
    const asset = await generateMarketingVideo(
      db,
      { userId: owner, roles: ['SUPPLIER'] },
      advice.renderRequest.body,
      AUDIT,
    );
    createdAssetIds.push(asset.id);
    expect(asset.status).toBe('READY');
    expect(asset.provider).toBe('structural');
    expect(asset.durationSeconds).toBe(35);
    expect(asset.previewable).toBe(true);
    expect(asset.downloadable).toBe(true);
    expect(await mediaAssetCount()).toBe(before + 1);
  }, 60_000);
});
