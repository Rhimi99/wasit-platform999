import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { createAgentTask, decideAgentTask } from '../src/modules/ai/agents.js';
import { purgeAgentVideos } from '../src/modules/ai/agent-videos.js';
import { db } from '../src/db/client.js';
import { users, roles, userRoles } from '../src/db/schema/auth.js';
import { agentTasks } from '../src/db/schema/agents.js';
import { auditLogs } from '../src/db/schema/audit.js';
import { suppliers } from '../src/db/schema/trade.js';
import { products, categories } from '../src/db/schema/products.js';
import { env } from '../src/lib/env.js';
import { cleanupOwnedRows } from './support/ownership-cleanup.js';

/**
 * AI-FIRST-COMPLETION-04 — agent video delivery + retention.
 *
 * The marketing video agent really renders an MP4 (ffmpeg + libass) and writes it
 * to the media store. These tests fetch it back through the API: owner 200,
 * stranger 404, staff 200, Range 206, plus an audit row. No mocks.
 */
const createdUserIds: string[] = [];
const createdSellerIds: string[] = [];
const createdProductIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdTaskIds: string[] = [];

const app = createApp();
const AUDIT = { actorId: 'afc04-video' };

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status };
    },
  };
}

async function insertUser(roleName: 'ADMIN' | 'SUPER_ADMIN' | 'SUPPLIER' | 'CUSTOMER') {
  const id = randomUUID();
  createdUserIds.push(id);
  const email = `afc04v-${roleName.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@wasit.tn`;
  await db.insert(users).values({
    id,
    email,
    passwordHash: await argon2.hash('Afc04Video123!'),
    firstName: roleName,
    isActive: true,
    emailVerified: true,
  });
  const role = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (role[0]) await db.insert(userRoles).values({ id: randomUUID(), userId: id, roleId: role[0].id });
  return { id, email };
}

async function insertSupplier(userId: string, name: string) {
  const id = randomUUID();
  createdSellerIds.push(id);
  await db.insert(suppliers).values({
    id,
    userId,
    companyName: name,
    slug: `afc04v-${id.slice(0, 8)}`,
    verified: true,
    isActive: true,
  });
  return id;
}

async function insertProduct(sellerId: string, name: string) {
  const categoryId = randomUUID();
  createdCategoryIds.push(categoryId);
  await db.insert(categories).values({ id: categoryId, name: `AFC04 Cat ${categoryId.slice(0, 6)}`, slug: `afc04v-cat-${categoryId.slice(0, 8)}` });
  const id = randomUUID();
  createdProductIds.push(id);
  await db.insert(products).values({
    id,
    sellerId,
    sellerType: 'SUPPLIER',
    categoryId,
    name,
    sku: `AFC04V-${id.slice(0, 8)}`,
    slug: `afc04v-prod-${id.slice(0, 8)}`,
    description: 'A product used to verify agent video delivery.',
    basePrice: '149.0000',
    currencyCode: 'TND',
    status: 'ACTIVE',
    isPublished: true,
  });
  return id;
}

describe('AFC-04 — agent video download and retention', () => {
  let owner: { id: string; email: string };
  let stranger: { id: string; email: string };
  let staff: { id: string; email: string };
  let taskId: string;

  beforeAll(async () => {
    owner = await insertUser('SUPPLIER');
    stranger = await insertUser('CUSTOMER');
    staff = await insertUser('SUPER_ADMIN');
    const sellerId = await insertSupplier(owner.id, 'AFC04 Video Supplier');
    const productId = await insertProduct(sellerId, 'AFC04 Video Product');

    const created = await createAgentTask(
      db,
      ['SUPPLIER'],
      owner.id,
      { agentKey: 'marketing-video-agent', requestedBy: owner.id, input: { productId, language: 'en', durationSeconds: 6, render: true } },
      { ...AUDIT, actorId: owner.id },
    );
    createdTaskIds.push(created.id);
    const finished =
      created.status === 'awaiting_approval'
        ? await decideAgentTask(db, created.id, staff.id, 'APPROVE', 'afc04 video approval', AUDIT)
        : created;
    expect(finished.error ?? null).toBeNull();
    taskId = created.id;
  }, 120_000);

  it('streams the rendered video to its owner with an audit row', async () => {
    const client = makeClient();
    const login = await client.req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'Afc04Video123!' } });
    expect(login.status).toBe(200);

    const res = await client.req(`/api/ai/tasks/${taskId}/video`);
    expect(res.status).toBe(200);
    expect(res.res.headers.get('content-type')).toBe('video/mp4');
    expect(res.res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.res.headers.get('cache-control')).toBe('private, no-store');
    expect(Number(res.res.headers.get('content-length'))).toBeGreaterThan(1000);

    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'AI.AGENT_VIDEO_DOWNLOADED'));
    expect(audits.length).toBeGreaterThan(0);
  }, 60_000);

  it('serves a byte range for preview seeking', async () => {
    const client = makeClient();
    await client.req('/api/auth/login', { method: 'POST', body: { email: owner.email, password: 'Afc04Video123!' } });
    const res = await client.req(`/api/ai/tasks/${taskId}/video`, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(res.res.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/);
    expect(Number(res.res.headers.get('content-length'))).toBe(1024);
  }, 60_000);

  it('hides the video from a user who does not own the task', async () => {
    const client = makeClient();
    await client.req('/api/auth/login', { method: 'POST', body: { email: stranger.email, password: 'Afc04Video123!' } });
    const res = await client.req(`/api/ai/tasks/${taskId}/video`);
    expect(res.status).toBe(404);
    expect(res.data?.error?.code).toBe('NOT_FOUND');
  }, 60_000);

  it('lets platform staff fetch it for support', async () => {
    const client = makeClient();
    await client.req('/api/auth/login', { method: 'POST', body: { email: staff.email, password: 'Afc04Video123!' } });
    const res = await client.req(`/api/ai/tasks/${taskId}/video?download=1`);
    expect(res.status).toBe(200);
    expect(res.res.headers.get('content-disposition')).toContain('attachment');
  }, 60_000);

  it('refuses anonymous access', async () => {
    const client = makeClient();
    const res = await client.req(`/api/ai/tasks/${taskId}/video`);
    expect(res.status).toBe(401);
  }, 30_000);

  it('keeps a fresh draft and refuses to delete a file it cannot classify', async () => {
    const dir = path.join(env.MEDIA_STORAGE_DIR, 'agent-videos', 'afc04-purge');
    await mkdir(dir, { recursive: true });
    // Free-form name: no task row, so the purge must leave it alone.
    const stray = path.join(dir, 'old.mp4');
    await writeFile(stray, Buffer.alloc(2048, 1));
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    await utimes(stray, longAgo, longAgo);

    const result = await purgeAgentVideos(db);
    expect(result.deleted).toBe(0);
    expect(result.keptReasons.unrecognised_key ?? 0).toBeGreaterThanOrEqual(1);
    expect((await stat(stray)).size).toBe(2048);

    // The real render from this suite is an unapproved draft (30d), so it stays.
    const draft = await db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.id, taskId));
    expect(draft).toHaveLength(1);
  }, 30_000);
});

afterAll(async () => {
  await cleanupOwnedRows(db, { userIds: createdUserIds, taskIds: createdTaskIds });
  for (const id of createdProductIds) await db.delete(products).where(eq(products.id, id));
  for (const id of createdCategoryIds) await db.delete(categories).where(eq(categories.id, id));
  for (const id of createdSellerIds) await db.delete(suppliers).where(eq(suppliers.id, id));
});
